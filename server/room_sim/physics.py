from __future__ import annotations

from copy import deepcopy

import mujoco
import numpy as np

from .compiler import compile_room, render_metadata
from .schema import Interaction, RoomSpec


class PhysicsSession:
    def __init__(self, spec: RoomSpec, *, xml: str | None = None):
        self.spec = spec
        self.model = mujoco.MjModel.from_xml_string(xml if xml is not None else compile_room(spec))
        self.data = mujoco.MjData(self.model)
        mujoco.mj_step(self.model, self.data, nstep=500)
        self.initial = self.data.qpos.copy()
        self.initial_bodies = self.data.xpos.copy()
        self.geoms = render_metadata(self.model)
        self.valid = True
        self.log: list[dict] = []
        self.replay_events: list[dict] | None = None
        self.replay_end = 0
        self.replay_index = 0
        self.reset()

    def reset(self):
        mujoco.mj_resetData(self.model, self.data)
        self.data.qpos[:] = self.initial
        mujoco.mj_forward(self.model, self.data)
        self.tick = 0
        self.paused = False
        self.grab = None

    def command(self, command: Interaction, record=True):
        c = command
        if c.type == "reset":
            self.reset(); self.log = []; self.replay_events = None
            return
        if c.type == "replay":
            if not self.log:
                raise ValueError("Interact with an object before replaying")
            self.replay_events = deepcopy(self.log)
            self.replay_end = self.tick
            self.replay_index = 0
            self.reset()
            return
        if c.type == "pause":
            self.paused = bool(c.paused)
            return
        if record and self.replay_events is not None:
            raise ValueError("Reset before starting a new interaction during replay")
        if c.type == "grab":
            body = c.body_id
            if body is None or body <= 0 or body >= self.model.nbody or not self.model.body_dofnum[body]:
                raise ValueError("Select a movable object, door, or drawer")
            point = np.array(c.point)
            if np.linalg.norm(point - self.data.xpos[body]) > 3:
                raise ValueError("Grab point must lie near the selected body")
            local = self.data.xmat[body].reshape(3, 3).T @ (point - self.data.xpos[body])
            self.grab = {"body": body, "local": local, "target": point}
        elif c.type == "move":
            if self.grab is None:
                raise ValueError("Grab an object first")
            self.grab["target"] = np.array(c.target)
        elif c.type == "release":
            self.grab = None
        if record:
            if len(self.log) >= 20000:
                self.grab = None
                raise ValueError("Recording is full; reset to start another recording")
            self.log.append({"tick": self.tick, "command": c.model_dump(exclude_none=True)})

    def advance(self, steps=16):
        if self.paused:
            return
        for _ in range(steps):
            if self.replay_events is not None:
                while self.replay_index < len(self.replay_events) and self.replay_events[self.replay_index]["tick"] == self.tick:
                    self.command(Interaction.model_validate(self.replay_events[self.replay_index]["command"]), record=False)
                    self.replay_index += 1
                if self.tick >= self.replay_end:
                    self.replay_events = None; self.paused = True; self.grab = None
                    break
            self.data.qfrc_applied.fill(0)
            if self.grab:
                body = self.grab["body"]
                offset = self.data.xmat[body].reshape(3, 3) @ self.grab["local"]
                point = self.data.xpos[body] + offset
                velocity = np.zeros(6)
                mujoco.mj_objectVelocity(self.model, self.data, mujoco.mjtObj.mjOBJ_BODY, body, velocity, 0)
                speed = velocity[3:] + np.cross(velocity[:3], point - self.data.xipos[body])
                force = 180 * (self.grab["target"] - point) - 18 * speed
                force *= min(1, 80 / max(np.linalg.norm(force), 1e-8))
                mujoco.mj_applyFT(self.model, self.data, force, np.zeros(3), point, body, self.data.qfrc_applied)
            mujoco.mj_step(self.model, self.data)
            self.tick += 1
        if not np.isfinite(self.data.qpos).all() or not np.isfinite(self.data.qvel).all():
            raise ValueError("Physics became unstable; reset the room and check its layout")

    def tasks(self):
        tasks = []
        for o in self.spec.objects:
            if o.kind in {"cabinet", "drawer"}:
                joint = self.model.joint(f"{o.id}_joint")
                value = abs(float(self.data.qpos[joint.qposadr[0]]))
                goal = o.joint.opening * .6 if o.kind == "cabinet" else o.joint.travel * .7
                tasks.append({"id": o.id, "label": f"Open {o.label.lower()}", "progress": min(1, value / goal)})
            elif o.movable:
                body = self.model.body(o.id).id
                moved = np.linalg.norm(self.data.xpos[body] - self.initial_bodies[body])
                tasks.append({"id": o.id, "label": f"Move {o.label.lower()} 20 cm", "progress": min(1, float(moved / .2))})
                receiving_kind = {"cup": "bowl", "bottle": "tray"}.get(o.kind)
                for receiver in self.spec.objects:
                    if receiver.kind != receiving_kind or min(receiver.size[:2]) <= max(o.size[:2]) + .03:
                        continue
                    receiving_body = self.model.body(receiver.id).id
                    relative = self.data.xmat[receiving_body].reshape(3, 3).T @ (self.data.xpos[body] - self.data.xpos[receiving_body])
                    clearance = (np.array(receiver.size[:2]) - np.array(o.size[:2])) / 2 - .012
                    inside = bool(np.all(np.abs(relative[:2]) < clearance) and 0 <= relative[2] < receiver.size[2])
                    velocity = np.zeros(6)
                    mujoco.mj_objectVelocity(self.model, self.data, mujoco.mjtObj.mjOBJ_BODY, body, velocity, 0)
                    settled = np.linalg.norm(velocity) < .1 and (not self.grab or self.grab["body"] != body)
                    progress = (1 if settled else .8) if inside else 0
                    tasks.append({"id": f"place-{o.id}-{receiver.id}", "label": f"Place {o.label.lower()} in {receiver.label.lower()}", "progress": progress})
        return tasks

    def state(self):
        return {"type": "state", "tick": self.tick, "time": round(self.tick * .002, 3),
                "paused": self.paused, "replaying": self.replay_events is not None,
                "recorded_commands": len(self.log), "grabbed_body": self.grab["body"] if self.grab else None,
                "bodies": np.concatenate([self.data.xpos, self.data.xquat], axis=1).tolist(), "tasks": self.tasks()}
