"""Independent playable robot tasks for the generated room worlds."""
from __future__ import annotations

import hashlib
import json
import shutil
import tempfile
import threading
import time
from pathlib import Path
from uuid import uuid4

from fastapi import HTTPException
from fastapi.responses import FileResponse
from pydantic import Field
from starlette.background import BackgroundTask

from task_rooms.config import PROJECT_ROOT
from .playground import RobotCommand
from .panda_world import PandaWorldSession, mesh_assets
from .schema import RoomSpec, StrictModel

THEMES = json.loads((PROJECT_ROOT / "public/robot-worlds/worlds.json").read_text())


class StartWorld(StrictModel):
    path: str = Field(default="root", pattern=r"^(root|[0-9](\.[0-9]){0,11})$")


class WorldCommand(StrictModel):
    sequence: int = Field(ge=1)
    command: RobotCommand


def scenario(path: str):
    StartWorld(path=path)
    parts = [] if path == "root" else [int(p) for p in path.split(".")]
    index = 0
    for digit in parts:
        index = (index + digit + 1) % len(THEMES)
    theme = THEMES[index]
    kind = ("reach", "push", "lift")[(index + len(parts)) % 3] if len(parts) > 1 else theme["task"]
    seed = int(hashlib.sha256(path.encode()).hexdigest()[:8], 16)
    x = -.16 + (seed % 9) * .04
    y = -.08 + ((seed // 9) % 5) * .04
    spec = RoomSpec.model_validate({
        "room_id": "kitchen", "name": theme["name"], "dimensions": [4.5, 4, 2.8],
        "appearance": theme["description"], "notes": [
            f"Generated appearance world: {theme['id']}; room path: {path}.",
            "The tabletop and robot use MuJoCo rigid-body physics. Generated room artwork is visual scenery.",
            "The robot is the articulated seven-joint Franka Panda from MuJoCo Menagerie, including physical finger and arm collisions."
        ],
        "objects": [
            {"id": "table", "label": "Robot workbench", "kind": "table", "position": [0, 0, 0],
             "size": [1.6, 1.1, .75], "color": theme["floor"]},
            {"id": "target", "label": theme["object"].capitalize(), "kind": theme["kind"],
             "position": [x, y, .755], "size": [.055, .055, .10], "movable": True,
             "mass": .15, "friction": .6, "color": theme["color"]}
        ]})
    revision = hashlib.sha256(spec.model_dump_json().encode()).hexdigest()[:24]
    return {"spec": spec.model_dump(), "revision": revision, "source_job": None,
            "world": {"path": path, "theme": theme["id"], "kind": kind}}, theme, kind, seed


class WorldSessions:
    def __init__(self):
        self.sessions = {}
        self.lock = threading.RLock()

    @staticmethod
    def state(robot):
        state = robot.state()
        state["robot"]["task"] = dict(robot.env.task)
        return state

    def create(self, path):
        with self.lock:
            for identifier, entry in list(self.sessions.items()):
                if time.monotonic() - entry["robot"].last_used > 600:
                    entry["robot"].close()
                    self.sessions.pop(identifier)
            if len(self.sessions) >= 12:
                raise HTTPException(409, "Close another robot world tab before starting a task")
            scene, theme, kind, seed = scenario(path)
            robot = PandaWorldSession(scene, f"{kind}:target", seed, None)
            robot.env.max_episode_steps = 2400
            robot.env.randomization = 0
            robot.reset(seed)
            identifier = uuid4().hex
            self.sessions[identifier] = {"robot": robot, "scene": scene, "theme": theme, "sequence": 0, "push_demo": False}
            return {"id": identifier, "revision": scene["revision"], "spec": scene["spec"],
                    "geoms": robot.geoms, "goal": robot.env.goal.tolist(), "state": self.state(robot),
                    "sequence": 0, "theme": theme, "path": path}

    def get(self, identifier):
        entry = self.sessions.get(identifier)
        if entry is None:
            raise HTTPException(404, "This robot world session ended. Re-enter the room to continue.")
        return entry

    def command(self, identifier, config):
        with self.lock:
            entry = self.get(identifier)
            if config.sequence != entry["sequence"] + 1:
                raise HTTPException(409, "Robot command sequence changed; reconnect to the room")
            if config.command.controller == "policy":
                raise HTTPException(422, "This generated world has no trained policy")
            robot, command = entry["robot"], config.command
            robot.command(command)
            state = self.state(robot)
            if entry["push_demo"]:
                state["robot"]["controller"] = "scripted"
            entry["sequence"] = config.sequence
            return {"state": state, "sequence": config.sequence}

    def discard(self, identifier):
        with self.lock:
            entry = self.sessions.pop(identifier, None)
            if entry:
                entry["robot"].close()

    def close(self):
        with self.lock:
            for identifier in list(self.sessions):
                self.discard(identifier)


def install_worlds(app):
    service = WorldSessions()
    app.state.robot_worlds = service

    @app.get("/robot-worlds/panda-meshes")
    def panda_meshes():
        return mesh_assets()

    @app.post("/robot-worlds/sessions", status_code=201)
    def create(config: StartWorld):
        return service.create(config.path)

    @app.post("/robot-worlds/sessions/{identifier}")
    def command(identifier: str, config: WorldCommand):
        try:
            return service.command(identifier, config)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc

    @app.delete("/robot-worlds/sessions/{identifier}")
    def discard(identifier: str):
        service.discard(identifier)
        return {"closed": True}

    @app.post("/robot-worlds/sessions/{identifier}/gym")
    def export(identifier: str):
        with service.lock:
            entry = service.get(identifier)
            scene, theme, task = entry["scene"], entry["theme"], entry["robot"].env.task["id"]
        folder = Path(tempfile.mkdtemp(prefix="robot-world-gym-"))
        try:
            assets = PROJECT_ROOT / "public/robot-worlds"
            references = [(assets / f"{theme['id']}.png", "generated_appearance_reference")]
            video = assets / f"{theme['id']}.mp4"
            if video.is_file():
                references.append((video, "reactor_ambient_appearance"))
            references.append((assets / "image-prompts.json", "image_generation_prompts"))
            generated = PROJECT_ROOT / "public/reactor-gyms"
            receipt = generated / f"{theme['id']}.json"
            if receipt.is_file() and json.loads(receipt.read_text()).get("status") == "ready":
                references.append((receipt, "reactor_world_provenance_not_geometry"))
                for suffix, role in (("mp4", "reactor_world_visual_reference"), ("jpg", "reactor_world_seed_image")):
                    asset = generated / f"{theme['id']}.{suffix}"
                    if asset.is_file():
                        references.append((asset, role))
            entry["robot"].export(scene, folder / "gym")
            appearance = folder / "gym" / "appearance"
            appearance.mkdir()
            for source, _ in references:
                if source.is_file(): shutil.copy2(source, appearance / source.name)
            for suffix in ("jpg", "mp4", "json"):
                source = assets / "generated" / f"{theme['id']}.{suffix}"
                if source.is_file(): shutil.copy2(source, appearance / f"lingbot-{source.name}")
            archive = shutil.make_archive(str(folder / "gym"), "zip", folder, "gym")
            return FileResponse(archive, media_type="application/zip", filename=f"{theme['id']}-robot-gym.zip",
                                background=BackgroundTask(shutil.rmtree, folder))
        except BaseException:
            shutil.rmtree(folder, ignore_errors=True)
            raise
