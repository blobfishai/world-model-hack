"""Gymnasium robot control in the same MuJoCo scene as the room viewer."""
from __future__ import annotations

import json
from pathlib import Path

import gymnasium as gym
import mujoco
import numpy as np
from gymnasium import spaces

from .compiler import compile_room
from .robot import FINGER_LIMITS, ROBOT, compile_robot, task_catalog, workspace
from .schema import RoomSpec


class RoomRobotEnv(gym.Env):
    metadata = {"render_modes": ["rgb_array"], "render_fps": 20}

    def __init__(self, scene_path: str | Path | None = None, *, spec: RoomSpec | dict | None = None,
                 task: str | None = None, render_mode: str | None = None,
                 max_episode_steps: int = 200, randomization: float = .1):
        if (scene_path is None) == (spec is None):
            raise ValueError("Provide exactly one of scene_path or spec")
        if render_mode not in (None, "rgb_array"):
            raise ValueError("render_mode must be None or 'rgb_array'")
        if not isinstance(max_episode_steps, int) or max_episode_steps < 1:
            raise ValueError("max_episode_steps must be a positive integer")
        if not np.isfinite(randomization) or not 0 <= randomization <= .3:
            raise ValueError("randomization must be between 0 and 0.3")
        if scene_path is not None:
            contents = json.loads(Path(scene_path).read_text())
            spec = contents.get("spec", contents)
        self.room_spec = spec if isinstance(spec, RoomSpec) else RoomSpec.model_validate(spec)
        self.render_mode = render_mode
        self.max_episode_steps = max_episode_steps
        self.randomization = randomization
        self.xml = compile_robot(self.room_spec)
        self.model = mujoco.MjModel.from_xml_string(self.xml)
        self.data = mujoco.MjData(self.model)
        # Settle the original scene before introducing the robot.
        room_model = mujoco.MjModel.from_xml_string(compile_room(self.room_spec))
        room_data = mujoco.MjData(room_model)
        mujoco.mj_step(room_model, room_data, nstep=500)
        if not np.isfinite(room_data.qpos).all() or np.max(np.abs(room_data.qvel), initial=0) > .5:
            raise ValueError("Room does not settle; correct its scene layout before training")
        self.tasks = task_catalog(self.room_spec, room_model, room_data)
        if not self.tasks:
            raise ValueError("This room needs at least one reachable movable object to create robot tasks")
        task_id = task or self.tasks[0]["id"]
        self.task = next((t for t in self.tasks if t["id"] == task_id), None)
        if self.task is None:
            raise ValueError(f"Unknown task {task_id!r}. Available: {', '.join(t['id'] for t in self.tasks)}")
        # Room joints precede appended robot joints in the generated XML.
        self.initial_qpos = self.model.qpos0.copy()
        self.initial_qpos[:room_model.nq] = room_data.qpos
        self.robot_joints = [self.model.joint(f"{ROBOT}_{axis}").id for axis in ("x", "y", "z", "left", "right")]
        self.robot_qpos = np.array([self.model.jnt_qposadr[j] for j in self.robot_joints])
        self.robot_dofs = np.array([self.model.jnt_dofadr[j] for j in self.robot_joints])
        self.robot_bodies = {self.model.body(name).id for name in (ROBOT, f"{ROBOT}_left", f"{ROBOT}_right")}
        self.finger_bodies = {self.model.body(f"{ROBOT}_{s}").id for s in ("left", "right")}
        self.target_body = self.model.body(self.task["object_id"]).id
        self.tool_site = self.model.site(f"{ROBOT}_tool").id
        self.goal_site = self.model.site("__goal").id
        self.goal = np.array(self.task["goal"], dtype=np.float64)
        self.initial_center = room_data.xipos[room_model.body(self.task["object_id"]).id].copy()
        self.lower, self.upper = workspace(self.room_spec)
        self.original_mass = self.model.body_mass.copy()
        self.original_inertia = self.model.body_inertia.copy()
        self.original_friction = self.model.geom_friction.copy()
        self.movable_bodies = np.array([self.model.body(o.id).id for o in self.room_spec.objects if o.movable])
        self.action_space = spaces.Box(-1, 1, shape=(4,), dtype=np.float32)
        size = self.model.nq + self.model.nv + 5 + 2
        self.observation_space = spaces.Dict({
            "observation": spaces.Box(-np.inf, np.inf, shape=(size,), dtype=np.float32),
            "achieved_goal": spaces.Box(-np.inf, np.inf, shape=(3,), dtype=np.float32),
            "desired_goal": spaces.Box(-np.inf, np.inf, shape=(3,), dtype=np.float32),
        })
        self._renderer = None
        self._done = True
        self.elapsed_steps = 0
        self.success_steps = 0

    @property
    def tool_position(self):
        return self.data.site_xpos[self.tool_site].copy()

    def _achieved(self):
        return self.tool_position if self.task["kind"] == "reach" else self.data.xipos[self.target_body].copy()

    def _observation(self):
        return {"observation": np.concatenate([self.data.qpos, self.data.qvel, self.data.ctrl,
                                               [self.elapsed_steps / self.max_episode_steps, self.success_steps / 3]]).astype(np.float32),
                "achieved_goal": self._achieved().astype(np.float32), "desired_goal": self.goal.astype(np.float32)}

    def _grasped(self):
        touching = set()
        for contact in self.data.contact:
            if contact.dist > .001:
                continue
            bodies = {int(self.model.geom_bodyid[g]) for g in contact.geom}
            if self.target_body in bodies:
                touching.update(bodies & self.finger_bodies)
        return touching == self.finger_bodies

    def _info(self, success=False, failure=None):
        return {"task": self.task["id"], "is_success": bool(success), "failure": failure,
                "distance": float(np.linalg.norm(self._achieved() - self.goal)),
                "grasped": self._grasped(), "elapsed_steps": self.elapsed_steps,
                "scale_status": self.room_spec.scale_status}

    def reset(self, *, seed=None, options=None):
        super().reset(seed=seed)
        if options:
            raise ValueError("Set task and randomization in the constructor; reset options are unsupported")
        self.model.body_mass[:] = self.original_mass
        self.model.body_inertia[:] = self.original_inertia
        self.model.geom_friction[:] = self.original_friction
        for body in self.movable_bodies:
            factor = self.np_random.uniform(1 - self.randomization, 1 + self.randomization)
            self.model.body_mass[body] *= factor
            self.model.body_inertia[body] *= factor
        self.model.geom_friction[:, 0] *= self.np_random.uniform(1 - self.randomization, 1 + self.randomization)
        mujoco.mj_setConst(self.model, self.data)
        self.model.site_pos[self.goal_site] = self.goal
        # mj_setConst recomputes the frame optimization. Disable it after that
        # call so a marker compiled at the origin also moves on the first reset.
        self.model.site_sameframe[self.goal_site] = 0
        for _ in range(100):
            mujoco.mj_resetData(self.model, self.data)
            self.data.qpos[:] = self.initial_qpos
            start = self.initial_center + [0, -.12, .3]
            start += self.np_random.uniform([-.08, -.08, 0], [.08, .08, .12])
            start = np.clip(start, self.lower, self.upper)
            self.data.qpos[self.robot_qpos] = [*start, FINGER_LIMITS[1], FINGER_LIMITS[1]]
            self.data.ctrl[:] = self.data.qpos[self.robot_qpos]
            mujoco.mj_forward(self.model, self.data)
            if not any(c.dist < -.001 and any(int(self.model.geom_bodyid[g]) in self.robot_bodies for g in c.geom)
                       for c in self.data.contact):
                break
        else:
            raise ValueError("No collision-free robot start above the target; edit the layout or choose another task")
        self.elapsed_steps = self.success_steps = 0
        self._done = False
        return self._observation(), self._info()

    def step(self, action):
        if self._done:
            raise gym.error.ResetNeeded("Call reset() before stepping a new episode")
        action = np.asarray(action, dtype=np.float64)
        if action.shape != (4,) or not np.isfinite(action).all() or np.any(np.abs(action) > 1):
            raise ValueError("Action must contain four finite values in [-1, 1]")
        previous_distance = np.linalg.norm(self._achieved() - self.goal)
        self.data.ctrl[:3] = np.clip(self.data.ctrl[:3] + .025 * action[:3], self.lower, self.upper)
        self.data.ctrl[3:] = FINGER_LIMITS[0] + (action[3] + 1) / 2 * (FINGER_LIMITS[1] - FINGER_LIMITS[0])
        warnings = self.data.warning.number.copy()
        mujoco.mj_step(self.model, self.data, nstep=25)
        mujoco.mj_forward(self.model, self.data)
        self.elapsed_steps += 1
        # MuJoCo can auto-reset on numerical failure; don't silently train on that reset.
        bad = (not np.isfinite(self.data.qpos).all() or not np.isfinite(self.data.qvel).all()
               or any(self.data.warning.number[i] > warnings[i] for i in
                      (int(mujoco.mjtWarning.mjWARN_BADQPOS), int(mujoco.mjtWarning.mjWARN_BADQVEL), int(mujoco.mjtWarning.mjWARN_BADQACC))))
        if bad:
            self._done = True
            raise RuntimeError("MuJoCo became unstable; inspect this scene before continuing training")
        distance = float(np.linalg.norm(self._achieved() - self.goal))
        velocity = np.zeros(6)
        mujoco.mj_objectVelocity(self.model, self.data, mujoco.mjtObj.mjOBJ_BODY, self.target_body, velocity, 0)
        success = distance < self.task["tolerance"]
        if self.task["kind"] != "reach":
            success = success and np.linalg.norm(velocity[3:]) < .12
        if self.task["kind"] == "lift":
            success = success and self._grasped()
        self.success_steps = self.success_steps + 1 if success else 0
        success = self.success_steps >= 3
        center = self.data.xipos[self.target_body]
        failure = None
        if center[2] < -.05 or np.any(np.abs(center[:2]) > np.array(self.room_spec.dimensions[:2]) / 2):
            failure = "object_outside_room"
        elif self.task["kind"] != "reach" and center[2] < self.initial_center[2] - .2:
            failure = "object_dropped"
        reward = 5 * (previous_distance - distance) - distance * .1 - .002 * float(np.square(action).sum()) - .005
        if self.task["kind"] != "reach":
            reward -= .02 * float(np.linalg.norm(self.tool_position - center))
        reward += 10 if success else -5 if failure else 0
        terminated = bool(success or failure)
        truncated = bool(self.elapsed_steps >= self.max_episode_steps and not terminated)
        self._done = terminated or truncated
        return self._observation(), float(reward), terminated, truncated, self._info(success, failure)

    def render(self):
        if self.render_mode != "rgb_array":
            return None
        if self._renderer is None:
            self._renderer = mujoco.Renderer(self.model, height=480, width=640)
        camera = mujoco.MjvCamera()
        camera.lookat[:] = [0, 0, .7]
        camera.distance = max(self.room_spec.dimensions[:2]) * 1.4
        camera.azimuth = 125
        camera.elevation = -35
        self._renderer.update_scene(self.data, camera=camera)
        return self._renderer.render().copy()

    def close(self):
        if self._renderer is not None:
            self._renderer.close()
            self._renderer = None


if "RoomRobot-v0" not in gym.registry:
    gym.register("RoomRobot-v0", entry_point="room_sim.gym_env:RoomRobotEnv")
