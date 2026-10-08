"""Browser control and honest policy playback of the actual robot environment."""
from __future__ import annotations

import importlib.util
import json
import threading
import time
from pathlib import Path
from typing import Annotated, Literal
from uuid import uuid4

import numpy as np
from fastapi import HTTPException
from fastapi.responses import FileResponse
from pydantic import Field, FiniteFloat, model_validator

from task_rooms.config import runtime_root

from .compiler import render_metadata
from .gym_bundle import digest
from .gym_env import RoomRobotEnv
from .schema import StrictModel
from .templates import ROOMS

Source = Literal["training", "current"]


class StartRobot(StrictModel):
    source: Source = "training"
    revision: str
    task: str | None = None
    seed: int = Field(default=42, ge=0, le=2**32 - 1)


class RobotCommand(StrictModel):
    type: Literal["action", "advance", "reset", "run", "pause", "take_control"]
    action: Annotated[list[FiniteFloat], Field(min_length=4, max_length=4)] | None = None
    controller: Literal["scripted", "policy"] | None = None
    seed: int | None = Field(default=None, ge=0, le=2**32 - 1)
    paused: bool | None = None

    @model_validator(mode="after")
    def valid_command(self):
        if self.type == "action" and (self.action is None or any(abs(v) > 1 for v in self.action)):
            raise ValueError("Robot action needs four finite values between -1 and 1")
        if self.type == "run" and self.controller is None:
            raise ValueError("Choose the scripted controller or trained policy")
        if self.type == "pause" and self.paused is None:
            raise ValueError("Pause needs a boolean")
        return self


class RobotSession:
    def __init__(self, scene: dict, task: str | None, seed: int, policy_path: Path | None):
        self.env = RoomRobotEnv(spec=scene["spec"], task=task)
        self.geoms = render_metadata(self.env.model)
        self.revision = scene["revision"]
        self.policy_path = policy_path
        self.policy = None
        self.lock = threading.RLock()
        self.last_used = time.monotonic()
        self.closed = False
        self.reset(seed)

    def reset(self, seed):
        self.seed = seed
        self.observation, self.info = self.env.reset(seed=seed)
        self.controller = "manual"
        self.paused = self.terminated = self.truncated = False
        self.grip = 1.
        self.reward = self.return_sum = 0.
        self.start_distance = self.info["distance"]

    def scripted_action(self):
        env = self.env
        if env.task["kind"] == "reach":
            target, grip = env.goal, 1
        elif env.task["kind"] == "lift":
            obj = next(o for o in env.room_spec.objects if o.id == env.task["object_id"])
            grasp_height = obj.size[2] / 2 - .015
            step = env.elapsed_steps
            if step < 22:
                offset, grip = .24, 1
            elif step < 46:
                offset, grip = grasp_height, 1
            elif step < 76:
                offset, grip = grasp_height, -1
            else:
                offset, grip = grasp_height + .15, -1
            target = env.initial_center + [0, 0, offset]
        else:
            raise ValueError("Use manual controls for push tasks; the scripted demo supports reach and lift")
        return np.r_[np.clip((target - env.data.ctrl[:3]) / .025, -1, 1), grip]

    def command(self, command: RobotCommand):
        with self.lock:
            if self.closed:
                raise ValueError("This robot session has ended; reconnect to the room")
            self.last_used = time.monotonic()
            if command.type == "reset":
                self.reset(self.seed if command.seed is None else command.seed)
            elif command.type == "pause":
                self.paused = command.paused
            elif command.type == "take_control":
                self.controller = "manual"
                self.paused = False
            elif command.type == "run":
                if command.controller == "policy":
                    if not self.policy_path:
                        raise ValueError("The saved policy applies to its training scene and task. Replay a listed evaluation run.")
                    if self.policy is None:
                        try:
                            import torch
                            from stable_baselines3 import PPO
                        except ImportError as exc:
                            raise ValueError("Policy playback needs the training dependencies; start pnpm rooms:dev") from exc
                        torch.set_num_threads(1)
                        self.policy = PPO.load(self.policy_path, env=self.env, device="cpu")
                elif self.env.task["kind"] == "push":
                    raise ValueError("The scripted demo supports reach and lift; use manual controls for this push task")
                self.reset(self.seed if command.seed is None else command.seed)
                self.controller = command.controller
            elif not (self.paused or self.terminated or self.truncated):
                if command.type == "action":
                    self.controller = "manual"
                    action = np.asarray(command.action, dtype=np.float32)
                elif self.controller == "scripted":
                    action = self.scripted_action()
                elif self.controller == "policy":
                    action, _ = self.policy.predict(self.observation, deterministic=True)
                else:
                    action = np.array([0, 0, 0, self.grip], dtype=np.float32)
                self.grip = float(action[3])
                self.observation, self.reward, self.terminated, self.truncated, self.info = self.env.step(action)
                self.return_sum += self.reward
            return self.state()

    def state(self):
        env = self.env
        progress = float(np.clip(1 - self.info["distance"] / max(self.start_distance, .001), 0, 1))
        return {"type": "state", "tick": env.elapsed_steps * 25, "time": round(env.elapsed_steps * .05, 3),
                "paused": self.paused, "replaying": self.controller != "manual", "recorded_commands": env.elapsed_steps,
                "grabbed_body": None, "bodies": np.concatenate([env.data.xpos, env.data.xquat], axis=1).tolist(),
                "tasks": [{"id": env.task["id"], "label": env.task["label"], "progress": progress}],
                "robot": {**self.info, "controller": self.controller, "seed": self.seed, "task": env.task,
                          "steps": env.elapsed_steps, "max_steps": env.max_episode_steps,
                          "done": bool(self.terminated or self.truncated), "terminated": self.terminated,
                          "truncated": self.truncated, "reward": self.reward, "return": self.return_sum,
                          "gripper_open": self.grip > 0, "tool_position": env.tool_position.tolist()}}

    def close(self):
        with self.lock:
            self.closed = True
            self.env.close()


class Playground:
    def __init__(self, store, training_root: Path | None = None):
        self.store = store
        self.training_root = training_root or runtime_root() / "training"
        self.sessions: dict[str, tuple[str, RobotSession]] = {}
        self.lock = threading.RLock()

    def training(self, room):
        folder = self.training_root / f"{room}-ppo"
        if not (folder / "report.json").is_file() or not (folder / "scene.json").is_file():
            return None
        report = json.loads((folder / "report.json").read_text())
        scene = json.loads((folder / "scene.json").read_text())
        if scene["spec"]["room_id"] != room:
            raise ValueError("The saved training scene belongs to another room")
        if report.get("scene_sha256") != digest(folder / "scene.json"):
            raise ValueError("The saved policy's scene has changed; restore its verified training snapshot")
        policy = folder / "policy.zip"
        return {"scene": scene, "report": report, "policy": policy if policy.is_file() else None}

    def scene(self, room, source):
        if room not in ROOMS:
            raise HTTPException(404, "Unknown room")
        training = self.training(room)
        if source == "training" and training:
            return training["scene"], "training", training
        with self.store.lock:
            return self.store.get(room), "current", training

    def catalog(self, room, source):
        scene, source, training = self.scene(room, source)
        with RoomRobotEnv(spec=scene["spec"]) as env:
            tasks = env.tasks
        report = None
        if training:
            saved = training["report"]
            report = {key: saved[key] for key in ("algorithm", "task", "actual_timesteps", "success_rate", "evaluation", "seed")}
            report["policy_available"] = bool(training["policy"] and importlib.util.find_spec("stable_baselines3"))
        return {"room": room, "revision": scene["revision"], "source": source, "name": scene["spec"]["name"],
                "scale_status": scene["spec"]["scale_status"], "tasks": tasks, "training": report,
                "video_url": f"/api/rooms/{room}/playground/video?source={source}" if scene.get("source_job") else None}

    def create(self, room, config):
        with self.lock:
            for key, (_, session) in list(self.sessions.items()):
                if time.monotonic() - session.last_used > 600:
                    session.close(); self.sessions.pop(key)
            if len(self.sessions) >= 8:
                raise HTTPException(409, "Close another robot playground tab before opening one")
            scene, source, training = self.scene(room, config.source)
            if config.revision != scene["revision"]:
                raise HTTPException(409, "The room changed. Reconnect to load the current version.")
            task = config.task or (training["report"]["task"] if source == "training" and training else None)
            policy = training["policy"] if source == "training" and training and task == training["report"]["task"] else None
            session = RobotSession(scene, task, config.seed, policy)
            session_id = uuid4().hex
            self.sessions[session_id] = (room, session)
            return {"id": session_id, "revision": scene["revision"], "spec": scene["spec"], "geoms": session.geoms,
                    "goal": session.env.goal.tolist(), "state": session.state(), "source": source,
                    "policy_available": bool(policy and importlib.util.find_spec("stable_baselines3"))}

    def get(self, room, session_id):
        with self.lock:
            entry = self.sessions.get(session_id)
            if not entry or entry[0] != room:
                raise HTTPException(404, "Robot session ended. Reconnect to continue.")
            return entry[1]

    def discard(self, room, session_id):
        with self.lock:
            session = self.get(room, session_id)
            self.sessions.pop(session_id)
            session.close()

    def close(self):
        with self.lock:
            for _, session in self.sessions.values():
                session.close()
            self.sessions.clear()


def install_playground(app, store):
    service = Playground(store)
    app.state.playground = service

    @app.get("/rooms/{room}/playground")
    def catalog(room: str, source: Source = "training"):
        try:
            return service.catalog(room, source)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc

    @app.get("/rooms/{room}/playground/video")
    def source_video(room: str, source: Source = "training"):
        scene, _, _ = service.scene(room, source)
        job = scene.get("source_job", "") or ""
        if len(job) != 32 or any(c not in "0123456789abcdef" for c in job):
            raise HTTPException(404, "This room has no source footage")
        path = store.root / "builds" / job / "source.mp4"
        if not path.is_file():
            raise HTTPException(404, "Source footage is missing")
        return FileResponse(path, media_type="video/mp4")

    @app.post("/rooms/{room}/robot-sessions", status_code=201)
    def create(room: str, config: StartRobot):
        try:
            return service.create(room, config)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc

    @app.post("/rooms/{room}/robot-sessions/{session_id}")
    def command(room: str, session_id: str, command: RobotCommand):
        try:
            return service.get(room, session_id).command(command)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc

    @app.delete("/rooms/{room}/robot-sessions/{session_id}")
    def close(room: str, session_id: str):
        service.discard(room, session_id)
        return {"closed": True}
