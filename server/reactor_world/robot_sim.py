"""Interactive Franka Panda simulation of a room's task, using the exact scene exported to MuJoCo Playground.

The player (or a scripted demo) moves the gripper in Cartesian space; damped-least-squares IK drives the Panda's
joint position actuators, the same actuators a Playground policy controls. Frames are rendered offscreen.
"""
from __future__ import annotations

import io
import math
import subprocess
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path

import mujoco
import numpy as np
from PIL import Image

from .playground_export import Layout, SceneWriter, plan_layout
from .schema import WorldRoomSpec, WorldTask
from .tasks import LIFT_HEIGHT, Observation, Progress, program

CONTROL_HZ = 25
SPEED = .25  # m/s for held direction keys
WORKSPACE = (np.array([.2, -.55, .004]), np.array([.85, .55, .6]))
# Top-down grasp: the fingers close along the robot's x axis and the gripper points straight down.
TOP_DOWN = np.array([[0., 1, 0], [1, 0, 0], [0, 0, -1]])


def panda_model(xml: str, extra_assets: dict[str, bytes] | None = None) -> mujoco.MjModel:
    from mujoco_playground._src import mjx_env
    from mujoco_playground._src.manipulation.franka_emika_panda import panda
    mjx_env.ensure_menagerie_exists()
    return mujoco.MjModel.from_xml_string(xml, assets={**panda.get_assets(), **(extra_assets or {})})


def with_backdrop(xml: str, layout: Layout, image: Path) -> tuple[str, dict[str, bytes]]:
    """Place the room's Reactor arrival frame behind the task surface as a visual-only, self-lit backdrop.

    The simulation (and Reactor's render of it) then shows the robot inside the generated room; physics is unchanged.
    """
    root = ET.fromstring(xml)
    with Image.open(image) as picture:
        rgb = picture.convert("RGB")
        aspect = rgb.width / rgb.height
        buffer = io.BytesIO()
        rgb.save(buffer, format="PNG")
    asset = root.find("asset")
    ET.SubElement(asset, "texture", type="2d", name="reactor_room", file="reactor_room.png")
    ET.SubElement(asset, "material", name="reactor_room", texture="reactor_room", emission="0.9", specular="0", shininess="0")
    support_far = max(float(layout.goal[1][0]), float(layout.spawn[1][0])) + .45
    top, floor = 1.6, -layout.frame.top
    half_height = (top - floor) / 2
    # Plane local axes: x → robot −y (image right, as seen by a camera looking along +x), y → +z (up), normal → −x.
    ET.SubElement(root.find("worldbody"), "geom", name="reactor_room_backdrop", type="plane", material="reactor_room",
                  pos=f"{support_far + .8:.4g} 0 {(top + floor) / 2:.4g}", quat="0.5 0.5 -0.5 -0.5",
                  size=f"{half_height * aspect:.4g} {half_height:.4g} 0.01", contype="0", conaffinity="0", rgba="1 1 1 1")
    ET.indent(root)
    return ET.tostring(root, encoding="unicode"), {"reactor_room.png": buffer.getvalue()}


@dataclass
class Phase:
    name: str
    target: np.ndarray
    closed: bool
    steps: int  # at most this many control ticks
    tolerance: float | None = .01  # None: wait the full duration
    speed: float = .2  # m/s along the waypoint
    settle: int = 0  # ticks to hold after arriving


class RobotSim:
    def __init__(self, spec: WorldRoomSpec, task: WorldTask, *, width: int = 960, height: int = 540,
                 layout: Layout | None = None, backdrop: Path | None = None):
        self.layout = layout or plan_layout(spec, task)
        xml = SceneWriter(self.layout, spec, walls=backdrop is None).write()
        assets = {}
        if backdrop is not None and backdrop.is_file():
            xml, assets = with_backdrop(xml, self.layout, backdrop)
        self.model = panda_model(xml, assets)
        self.data = mujoco.MjData(self.model)
        self.scratch = mujoco.MjData(self.model)
        self.task = task
        self.kind = task.robot_task.kind
        self.steps = program(task)
        self.substeps = round(1 / CONTROL_HZ / self.model.opt.timestep)
        self.site = self.model.site("gripper").id
        self.item = self.model.body("box").id
        self.item_geom = self.model.geom("box").id
        self.pads = {self.model.geom(n).id for n in ("left_finger_pad", "right_finger_pad")}
        self.key = self.model.key("home").id
        self.limits = self.model.actuator_ctrlrange[:7].copy()
        self.closed, self.open = self.model.actuator_ctrlrange[7]  # finger position: 0 closed, 0.04 m open
        self.width, self.height = width, height
        self.renderer: mujoco.Renderer | None = None
        self.camera = mujoco.MjvCamera()
        self.camera.lookat[:] = [.45, 0, .05]
        self.camera.distance, self.camera.azimuth, self.camera.elevation = 1.75, 25, -30
        self.reset()

    # State -----------------------------------------------------------------------------------
    def reset(self) -> None:
        mujoco.mj_resetDataKeyframe(self.model, self.data, self.key)
        goal = (np.array(self.layout.goal[0]) + np.array(self.layout.goal[1])) / 2
        self.data.mocap_pos[self.model.body("mocap_target").mocapid[0]] = goal
        mujoco.mj_forward(self.model, self.data)
        self.target = self.data.site_xpos[self.site].copy()
        self.orientation = TOP_DOWN
        self.solution = self.data.qpos[:7].copy()
        self.integral = np.zeros(7)
        self.grip_closed = False
        self.axes = np.zeros(3)
        self.start = self.data.xpos[self.item].copy()
        self.progress = Progress(self.steps, self.kind, np.array(self.layout.goal[0]), np.array(self.layout.goal[1]))
        self.ticks = 0
        self.demo: list[Phase] | None = None
        self.mode = "manual"

    def command(self, message: dict) -> None:
        kind = message.get("type")
        if kind == "move":
            axes = message.get("axes") or {}
            self.axes = np.clip([float(axes.get(k, 0)) for k in ("x", "y", "z")], -1, 1)
            if self.mode == "demo" and np.any(self.axes):
                self.mode, self.demo = "manual", None
        elif kind == "gripper":
            self.grip_closed = bool(message.get("closed"))
            if self.mode == "demo":
                self.mode, self.demo = "manual", None
        elif kind == "reset":
            self.reset()
        elif kind == "demo":
            self.reset()
            self.mode, self.demo = "demo", None
        elif kind == "stop":
            self.mode, self.demo = "manual", None
            self.axes = np.zeros(3)
        else:
            raise ValueError(f"Unknown robot command {kind!r}")

    def observation(self) -> Observation:
        contacts = set()
        for contact in self.data.contact[: self.data.ncon]:
            pair = {contact.geom1, contact.geom2}
            if self.item_geom in pair:
                contacts |= pair & self.pads
        velocity = np.zeros(6)
        mujoco.mj_objectVelocity(self.model, self.data, mujoco.mjtObj.mjOBJ_BODY, self.item, velocity, 0)
        return Observation(self.data.site_xpos[self.site].copy(), self.data.xpos[self.item].copy(), self.start,
                           float(np.linalg.norm(velocity[3:])), len(contacts), float(self.data.qpos[7]))

    # Control ---------------------------------------------------------------------------------
    def solve(self, target: np.ndarray, orientation: np.ndarray, start: np.ndarray) -> np.ndarray:
        """Joint angles that put the gripper site at `target` with `orientation` (damped least squares on a scratch copy)."""
        scratch = self.scratch
        scratch.qpos[:] = self.data.qpos
        scratch.qpos[:7] = start
        jacp, jacr = np.zeros((3, self.model.nv)), np.zeros((3, self.model.nv))
        for _ in range(20):
            mujoco.mj_kinematics(self.model, scratch)
            mujoco.mj_comPos(self.model, scratch)
            current = scratch.site_xmat[self.site].reshape(3, 3)
            position = target - scratch.site_xpos[self.site]
            rotation = .5 * sum(np.cross(current[:, i], orientation[:, i]) for i in range(3))
            if np.linalg.norm(position) < 5e-4 and np.linalg.norm(rotation) < 5e-3:
                break
            mujoco.mj_jacSite(self.model, scratch, jacp, jacr, self.site)
            jacobian = np.vstack([jacp[:, :7], jacr[:, :7]])
            error = np.r_[np.clip(position, -.05, .05), rotation]
            delta = jacobian.T @ np.linalg.solve(jacobian @ jacobian.T + .01 ** 2 * np.eye(6), error)
            scratch.qpos[:7] = np.clip(scratch.qpos[:7] + delta, self.limits[:, 0], self.limits[:, 1])
        return scratch.qpos[:7].copy()

    def ik(self) -> None:
        # The Panda's position servos sag under gravity (no compensation, as in Playground). An integral term on the
        # joint targets removes the steady error using only the actuators a Playground policy controls.
        self.solution = self.solve(self.target, self.orientation, self.solution)
        self.integral = np.clip(self.integral + .3 * (self.solution - self.data.qpos[:7]), -.15, .15)
        self.data.ctrl[:7] = np.clip(self.solution + self.integral, self.limits[:, 0], self.limits[:, 1])
        self.data.ctrl[7] = self.closed if self.grip_closed else self.open

    def demo_plan(self) -> list[Phase]:
        """Pick (and place) waypoints: rise, approach above the object, descend vertically, grasp, lift, carry."""
        item = self.data.xpos[self.item].copy()
        height = self.layout.size[2]
        gripper = self.data.site_xpos[self.site].copy()
        safe = max(item[2] + height / 2 + .08, .22)
        grasp = item + [0, 0, min(.02, height / 4)]
        if self.kind == "reach":
            above = item + [0, 0, .03]
            return [Phase("rise", np.r_[gripper[:2], max(safe, gripper[2])], False, 40),
                    Phase("approach", np.r_[item[:2], safe], False, 90, .004),
                    Phase("align", above, False, 100, .005, speed=.08), Phase("hold", above, False, 50, None)]
        if self.kind == "push":
            goal = self.progress.goal.copy()
            direction = goal[:2] - item[:2]
            direction /= max(np.linalg.norm(direction), 1e-6)
            offset = max(self.layout.size[:2]) / 2 + .035
            behind = item - np.r_[direction * offset, 0]
            contact = item - np.r_[direction * (offset - .025), 0]
            end = goal - np.r_[direction * (offset - .04), 0]
            return [Phase("rise", np.r_[gripper[:2], max(safe, gripper[2])], True, 40),
                    Phase("approach", np.r_[behind[:2], safe], True, 100, .005),
                    Phase("descend", behind, True, 100, .005, speed=.08),
                    Phase("contact", contact, True, 55, .004, speed=.05),
                    Phase("push", end, True, 180, .008, speed=.06),
                    Phase("retreat", end + [0, 0, .1], True, 70, speed=.1), Phase("settle", end + [0, 0, .1], True, 50, None)]
        phases = [Phase("rise", np.r_[gripper[:2], max(safe, gripper[2])], False, 40),
                  Phase("approach", np.r_[item[:2], safe], False, 90, .004, settle=8),
                  Phase("descend", grasp, False, 90, .005, speed=.08, settle=5),
                  Phase("grasp", grasp, True, 40, None)]
        if self.kind == "lift":
            top = grasp + [0, 0, LIFT_HEIGHT["lift"] + .04]
            return phases + [Phase("lift", top, True, 70, speed=.12), Phase("hold", top, True, 40, None)]
        goal = self.progress.goal
        carry = max(safe, grasp[2] + LIFT_HEIGHT["place"] + .04)
        down = goal + [0, 0, grasp[2] - item[2] + .004]
        return phases + [Phase("lift", np.r_[grasp[:2], carry], True, 70, speed=.12),
                         Phase("carry", np.r_[goal[:2], carry], True, 100, .006, speed=.12, settle=5),
                         Phase("lower", down, True, 80, .006, speed=.06, settle=5), Phase("release", down, False, 20, None),
                         Phase("retreat", down + [0, 0, .14], False, 40, speed=.15)]

    def run_demo(self) -> None:
        if self.demo is None:
            self.demo = self.demo_plan()
            self.phase_ticks = self.arrived_ticks = 0
        if not self.demo:
            self.mode = "manual"
            return
        phase = self.demo[0]
        # Stream the waypoint at a bounded speed so the arm moves smoothly instead of jumping between poses.
        step = phase.speed / CONTROL_HZ
        self.target = self.target + np.clip(phase.target - self.target, -step, step)
        self.grip_closed = phase.closed
        self.phase_ticks += 1
        if phase.tolerance is not None and np.linalg.norm(self.data.site_xpos[self.site] - phase.target) < phase.tolerance:
            self.arrived_ticks += 1
        if self.arrived_ticks > phase.settle or self.phase_ticks >= phase.steps:
            self.demo.pop(0)
            self.phase_ticks = self.arrived_ticks = 0

    def tick(self) -> None:
        if self.mode == "demo":
            self.run_demo()
        else:
            self.target = np.clip(self.target + self.axes * SPEED / CONTROL_HZ, *WORKSPACE)
        self.ik()
        mujoco.mj_step(self.model, self.data, nstep=self.substeps)
        self.ticks += 1
        self.progress.update(self.observation())

    # Output ----------------------------------------------------------------------------------
    def render(self, quality: int = 82) -> bytes:
        if self.renderer is None:
            self.renderer = mujoco.Renderer(self.model, self.height, self.width)
        self.renderer.update_scene(self.data, self.camera)
        buffer = io.BytesIO()
        Image.fromarray(self.renderer.render()).save(buffer, format="JPEG", quality=quality)
        return buffer.getvalue()

    def state(self) -> dict:
        observation = self.observation()
        return {"type": "state", "mode": self.mode, "time": round(self.ticks / CONTROL_HZ, 2), "ticks": self.ticks,
                "steps": self.progress.view(), "success": self.progress.success,
                "metrics": self.progress.metrics(observation), "gripper_target": [round(float(v), 3) for v in self.target]}

    def close(self) -> None:
        if self.renderer is not None:
            self.renderer.close()
            self.renderer = None


def record_demo(sim: RobotSim, output: Path, *, seconds: float = 22, fps: int = CONTROL_HZ) -> dict:
    """Run the scripted demo and encode it (H.264); returns the outcome for the room record."""
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(".tmp.mp4")
    encoder = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "image2pipe", "-framerate", str(fps), "-i", "pipe:0",
                                "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
                                "-movflags", "+faststart", str(temporary)], stdin=subprocess.PIPE)
    sim.command({"type": "demo"})
    finished_at = None
    start_box, goal, controls = sim.start.copy(), sim.progress.goal.copy(), []
    try:
        for frame in range(math.ceil(seconds * fps)):
            sim.tick()
            controls.append(sim.data.ctrl.copy())
            assert encoder.stdin is not None
            encoder.stdin.write(sim.render(quality=92))
            if finished_at is None and sim.progress.success:
                finished_at = frame
            if finished_at is not None and frame - finished_at > fps:
                break
    finally:
        assert encoder.stdin is not None
        encoder.stdin.close()
        if encoder.wait(timeout=120) != 0:
            raise RuntimeError("Demo video encoding failed")
    temporary.replace(output)
    # Joint targets per tick, so the exported MJX gym can replay the demo and check success in code.
    np.savez_compressed(output.with_suffix(".npz"), ctrl=np.array(controls), box=start_box, goal=goal,
                        control_hz=CONTROL_HZ, success=sim.progress.success)
    done = sum(sim.progress.done)
    return {"success": sim.progress.success, "steps_completed": done, "total_steps": len(sim.steps),
            "seconds": round((finished_at if finished_at is not None else sim.ticks) / fps, 2)}


def room_sim(store, world_id: str, path: str, *, width: int = 960, height: int = 540) -> RobotSim:
    scene = store.read_json(world_id, path, "scene.json")
    if scene is None:
        raise ValueError("Build physics for this room before simulating the robot")
    room = store.room(world_id, path)
    backdrop = store.room_path(world_id, path) / "arrival.jpg"
    return RobotSim(WorldRoomSpec.model_validate(scene["spec"]), room.task, width=width, height=height,
                    backdrop=backdrop if backdrop.is_file() else None)


def demo_prompt(room, task: WorldTask) -> str:
    robot = task.robot_task
    labels = {o.id: o.label for o in task.objects}
    item = labels.get(robot.object, robot.object.replace("_", " "))
    action = (f"holds its open gripper just above the {item}" if robot.kind == "reach" else
              f"pushes the {item} along the work surface to the goal" if robot.kind == "push" else
              f"picks up the {item} and lifts it" if robot.kind == "lift" else
              f"picks up the {item} and sets it down {robot.relation or 'beside'} the "
              f"{labels.get(robot.anchor or '', (robot.anchor or 'target').replace('_', ' '))}")
    return (f"Photorealistic footage of this room: {room.prompt[:520]} A white Franka Emika Panda robot arm on a dark "
            f"pedestal {action}. Keep the robot's exact motion, the camera and every object's position; restyle only "
            "materials, textures and lighting to match the room. No people, text or extra objects.")
