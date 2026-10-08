"""The robot worlds' articulated, contact-driven Franka Panda simulation."""
from __future__ import annotations

import json
import shutil
import time
import xml.etree.ElementTree as ET
from functools import lru_cache
from pathlib import Path

import mujoco
import numpy as np

from .compiler import compile_room
from .schema import RoomSpec

ASSETS = Path(__file__).parent / "assets" / "panda"
HOME = np.array([0., -.6, 0., -2.1, 0., 1.5, .785398])


def compile_panda(spec: RoomSpec, *, portable=False):
    root = ET.parse(ASSETS / "panda.xml").getroot()
    root.remove(root.find("keyframe"))
    root.find("compiler").set("meshdir", "assets" if portable else str(ASSETS / "assets"))
    root.find("option").set("timestep", ".002")
    root.find("worldbody/body").set("pos", "-.55 0 .75")
    hand = next(b for b in root.iter("body") if b.get("name") == "hand")
    ET.SubElement(hand, "site", name="tool", pos="0 0 .103", size=".005", rgba="0 0 0 0")
    room = ET.fromstring(compile_room(spec))
    for child in room.find("default"):
        root.find("default").append(child)
    for child in room.find("worldbody"):
        root.find("worldbody").append(child)
    return ET.tostring(root, encoding="unicode")


@lru_cache(maxsize=16)
def compiled(spec_json):
    return mujoco.MjModel.from_xml_string(compile_panda(RoomSpec.model_validate_json(spec_json)))


def geoms(model):
    kinds = {int(mujoco.mjtGeom.mjGEOM_BOX): "box", int(mujoco.mjtGeom.mjGEOM_SPHERE): "sphere",
             int(mujoco.mjtGeom.mjGEOM_CYLINDER): "cylinder", int(mujoco.mjtGeom.mjGEOM_MESH): "mesh"}
    result = []
    for i in range(model.ngeom):
        if model.geom_group[i] == 3 or int(model.geom_type[i]) not in kinds:
            continue
        material = model.geom_matid[i]
        color = model.mat_rgba[material] if material >= 0 else model.geom_rgba[i]
        body = int(model.geom_bodyid[i])
        result.append({"id": i, "body_id": body, "body_name": model.body(body).name,
            "type": kinds[int(model.geom_type[i])], "mesh_id": int(model.geom_dataid[i]),
            "size": model.geom_size[i].tolist(), "position": model.geom_pos[i].tolist(),
            "quaternion": model.geom_quat[i].tolist(), "color": color.tolist(),
            "movable": bool(model.body_dofnum[body])})
    return result


@lru_cache(maxsize=1)
def mesh_assets():
    model = mujoco.MjModel.from_xml_path(str(ASSETS / "panda.xml"))
    meshes = {}
    for i in sorted(set(int(model.geom_dataid[g]) for g in range(model.ngeom) if model.geom_group[g] == 2)):
        va, vn = model.mesh_vertadr[i], model.mesh_vertnum[i]
        fa, fn = model.mesh_faceadr[i], model.mesh_facenum[i]
        meshes[str(i)] = {"vertices": model.mesh_vert[va:va+vn].round(6).reshape(-1).tolist(),
                          "indices": model.mesh_face[fa:fa+fn].reshape(-1).tolist()}
    return meshes


class PandaWorldSession:
    def __init__(self, scene, task, seed, _policy=None):
        self.spec = RoomSpec.model_validate(scene["spec"])
        self.model = compiled(self.spec.model_dump_json())
        self.data, self.ik = mujoco.MjData(self.model), mujoco.MjData(self.model)
        self.arm_joints = np.array([self.model.joint(f"joint{i}").id for i in range(1, 8)])
        self.arm_q = self.model.jnt_qposadr[self.arm_joints]
        self.arm_v = self.model.jnt_dofadr[self.arm_joints]
        self.site = self.model.site("tool").id
        self.object = self.model.body("target").id
        self.fingers = {self.model.body(n).id for n in ("left_finger", "right_finger")}
        self.geoms = geoms(self.model)
        self.kind = task.split(":")[0]
        self.env = self  # Existing room-session contract.
        self.max_episode_steps = 2400
        self.randomization = 0
        self.closed = False
        self.last_used = time.monotonic()
        self.reset(seed)

    @property
    def tool_position(self):
        return self.data.site_xpos[self.site].copy()

    def reset(self, seed):
        self.seed = seed
        mujoco.mj_resetData(self.model, self.data)
        self.data.qpos[self.arm_q] = HOME
        for name in ("finger_joint1", "finger_joint2"):
            self.data.qpos[self.model.joint(name).qposadr[0]] = .04
        self.data.ctrl[:7] = HOME
        self.data.ctrl[7] = 255
        mujoco.mj_forward(self.model, self.data)
        mujoco.mj_step(self.model, self.data, nstep=300)
        self.initial_center = self.data.xipos[self.object].copy()
        self.initial = self.data.qpos.copy()
        self.target = self.tool_position
        self.desired_q = self.data.qpos[self.arm_q].copy()
        self.goal = self.initial_center + ({"reach": [0, 0, .18], "push": [.16, 0, 0], "lift": [0, 0, .14]}[self.kind])
        self.task = {"id": f"{self.kind}:target", "kind": self.kind, "object_id": "target",
                     "label": f"{self.kind.capitalize()} {next(o.label.lower() for o in self.spec.objects if o.id == 'target')}",
                     "goal": self.goal.tolist(), "tolerance": .04}
        self.controller = "manual"
        self.paused = self.terminated = self.truncated = False
        self.grip = 1.
        self.elapsed_steps = self.phase = self.phase_steps = self.hold = 0
        self.reward = self.return_sum = 0.
        self.start_distance = self.distance()

    def solve(self):
        self.ik.qpos[:] = self.data.qpos
        self.ik.qpos[self.arm_q] = self.desired_q
        jp, jr = np.zeros((3, self.model.nv)), np.zeros((3, self.model.nv))
        desired = np.diag([1., -1., -1.])
        for _ in range(14):
            mujoco.mj_forward(self.model, self.ik)
            current = self.ik.site_xmat[self.site].reshape(3, 3)
            angle = sum(np.cross(current[:, i], desired[:, i]) for i in range(3)) * .5
            error = np.r_[self.target - self.ik.site_xpos[self.site], angle * .4]
            if np.linalg.norm(error) < .0005:
                break
            mujoco.mj_jacSite(self.model, self.ik, jp, jr, self.site)
            jac = np.vstack([jp[:, self.arm_v], jr[:, self.arm_v] * .4])
            delta = jac.T @ np.linalg.solve(jac @ jac.T + np.eye(6) * .0004, error)
            limits = self.model.jnt_range[self.arm_joints]
            self.ik.qpos[self.arm_q] = np.clip(self.ik.qpos[self.arm_q] + np.clip(delta, -.12, .12), limits[:, 0] + .01, limits[:, 1] - .01)
        self.desired_q = self.ik.qpos[self.arm_q].copy()
        self.data.ctrl[:7] = self.desired_q

    def grasped(self):
        touched = set()
        for contact in self.data.contact:
            a, b = (int(self.model.geom_bodyid[g]) for g in (contact.geom1, contact.geom2))
            if a == self.object and b in self.fingers: touched.add(b)
            if b == self.object and a in self.fingers: touched.add(a)
        return len(touched) == 2

    def distance(self):
        position = self.tool_position if self.kind == "reach" else self.data.xipos[self.object]
        return float(np.linalg.norm(position - self.goal))

    def scripted_action(self):
        point = self.initial_center.copy()
        if self.kind == "reach":
            desired, grip = self.goal, 1
        elif self.kind == "lift":
            desired = point + [0, 0, .20 if self.phase == 0 else .19 if self.phase >= 3 else 0]
            grip = 1 if self.phase < 2 else -1
        else:
            desired = (point + [-.09, 0, .20] if self.phase == 0 else
                       point + [-.09, 0, 0] if self.phase == 1 else self.goal + [-.018, 0, 0])
            grip = -1
        self.phase_steps += 1
        if self.kind != "reach" and self.phase < (3 if self.kind == "lift" else 2):
            ready = self.phase_steps >= 24 if self.kind == "lift" and self.phase == 2 else np.linalg.norm(self.tool_position - desired) < .02 and self.phase_steps >= 8
            if ready:
                self.phase += 1; self.phase_steps = 0
        return np.r_[np.clip((desired - self.target) / .015, -1, 1), grip]

    def command(self, command):
        if self.closed: raise ValueError("This robot session ended")
        self.last_used = time.monotonic()
        if command.type == "reset": self.reset(self.seed if command.seed is None else command.seed)
        elif command.type == "pause": self.paused = command.paused
        elif command.type == "take_control": self.controller = "manual"; self.paused = False
        elif command.type == "run":
            if command.controller != "scripted": raise ValueError("This room has no trained Panda policy")
            self.reset(self.seed); self.controller = "scripted"
        elif not (self.paused or self.terminated or self.truncated):
            if command.type == "action": self.controller = "manual"
            action = np.array(command.action) if command.type == "action" else self.scripted_action() if self.controller == "scripted" else np.array([0, 0, 0, self.grip])
            self.target = np.clip(self.target + action[:3] * .015, [-.25, -.3, .775], [.28, .3, 1.35])
            self.grip = float(action[3]); self.data.ctrl[7] = 255 if self.grip > 0 else 0
            self.solve()
            mujoco.mj_step(self.model, self.data, nstep=25)
            self.elapsed_steps += 1
            distance = self.distance()
            success = distance < .04 and (self.kind != "lift" or self.grasped())
            self.hold = self.hold + 1 if success else 0
            self.terminated = self.hold >= 3
            self.truncated = self.elapsed_steps >= self.max_episode_steps
            self.reward = 1. if self.terminated else -distance
            self.return_sum += self.reward
        return self.state()

    def state(self):
        distance = self.distance()
        progress = 1. if self.terminated else float(np.clip(1 - distance / max(self.start_distance, .001), 0, .99))
        return {"bodies": np.concatenate([self.data.xpos, self.data.xquat], axis=1).tolist(),
            "tasks": [{"id": self.task["id"], "label": self.task["label"], "progress": progress}],
            "robot": {"model": "Franka Emika Panda", "joints": self.data.qpos[self.arm_q].tolist(),
                "controller": self.controller, "seed": self.seed, "task": {**self.task, "goal": self.goal.tolist()}, "steps": self.elapsed_steps,
                "max_steps": self.max_episode_steps, "done": self.terminated or self.truncated,
                "terminated": self.terminated, "truncated": self.truncated, "is_success": self.terminated,
                "failure": None, "distance": distance, "grasped": self.grasped(), "reward": self.reward,
                "return": self.return_sum, "gripper_open": self.grip > 0, "tool_position": self.tool_position.tolist()}}

    def close(self):
        self.closed = True

    def export(self, scene, folder):
        folder.mkdir(parents=True, exist_ok=True)
        xml = ET.fromstring(compile_panda(self.spec, portable=True))
        xml.find("compiler").set("meshdir", "room_sim/assets/panda/assets")
        (folder / "robot.xml").write_text(ET.tostring(xml, encoding="unicode"))
        (folder / "scene.json").write_text(json.dumps(scene, indent=2))
        (folder / "manifest.json").write_text(json.dumps({"default_task": self.task["id"],
            "robot": "Franka Emika Panda", "robot_source": "MuJoCo Menagerie, Apache-2.0",
            "control": "seven joint position actuators and a coupled physical finger actuator",
            "visual_generation": "Reactor-generated references; generated video is not collision geometry"}, indent=2))
        package = folder / "room_sim"
        package.mkdir(exist_ok=True)
        (package / "__init__.py").write_text("")
        for name in ("panda_world.py", "compiler.py", "schema.py"):
            shutil.copy2(Path(__file__).parent / name, package / name)
        shutil.copytree(ASSETS, package / "assets" / "panda", dirs_exist_ok=True)
        shutil.copy2(ASSETS / "LICENSE", folder / "PANDA-LICENSE")
        np.savez(folder / "initial_state.npz", qpos=self.initial, goal=self.goal)
        (folder / "requirements.txt").write_text("mujoco==3.15.0\ngymnasium>=1.2,<2\nnumpy>=2\npydantic>=2\n")
        (folder / "env.py").write_text('''"""Gymnasium interface to this exact Panda task. Actions are dx, dy, dz, grip."""
import json
from pathlib import Path
from types import SimpleNamespace
import gymnasium as gym
import numpy as np
from room_sim.panda_world import PandaWorldSession

class PandaGym(gym.Env):
    metadata = {"render_modes": []}
    def __init__(self):
        root = Path(__file__).parent
        scene = json.loads((root / "scene.json").read_text())
        task = json.loads((root / "manifest.json").read_text())["default_task"]
        self.sim = PandaWorldSession(scene, task, 42)
        self.action_space = gym.spaces.Box(-1., 1., (4,), dtype=np.float32)
        self.observation_space = gym.spaces.Box(-np.inf, np.inf, self._obs().shape, dtype=np.float32)
    def _obs(self):
        return np.concatenate([self.sim.data.qpos, self.sim.data.qvel, self.sim.target, self.sim.goal]).astype(np.float32)
    def reset(self, *, seed=None, options=None):
        super().reset(seed=seed)
        self.sim.reset(42 if seed is None else seed)
        return self._obs(), self.sim.state()["robot"]
    def step(self, action):
        value = np.asarray(action, dtype=np.float64)
        if value.shape != (4,) or not np.isfinite(value).all() or (np.abs(value) > 1).any():
            raise ValueError("Action needs four finite values between -1 and 1")
        self.sim.command(SimpleNamespace(type="action", action=value.tolist()))
        return self._obs(), float(self.sim.reward), bool(self.sim.terminated), bool(self.sim.truncated), self.sim.state()["robot"]
    def close(self):
        self.sim.close()
''')
        (folder / "README.md").write_text("# Franka Panda task gym\n\nInstall requirements.txt, then `from env import PandaGym`. The Gymnasium environment exposes four Cartesian actions (dx, dy, dz, grip), solving them into seven joint actuator targets. Contacts determine grasp and lift success.\n\nLoad robot.xml directly with MuJoCo for inspection. initial_state.npz contains the settled reset pose and task goal. The model includes real joint limits, mass/inertia, full arm collisions, and coupled physical fingers.\n\nGenerated room videos are appearance references. They do not supply recovered geometry or verified robot demonstrations.\n")
