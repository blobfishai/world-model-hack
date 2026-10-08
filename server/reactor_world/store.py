"""World records and room artifacts under .task-rooms/reactor-worlds/{world}/."""
from __future__ import annotations

import json
import os
import re
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from room_sim.builds import atomic_json
from task_rooms.config import runtime_root

from .schema import PATH_PATTERN, WORLD_ID, JobName, World, WorldRoom

ACTIVE = {"queued", "generating"}


def pid_alive(pid: int | None) -> bool:
    if pid is None:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


class WorldStore:
    def __init__(self, root: Path | None = None):
        self.root = (root or runtime_root() / "reactor-worlds").resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()

    def folder(self, world_id: str) -> Path:
        if not re.fullmatch(WORLD_ID, world_id):
            raise KeyError("Unknown world")
        return self.root / world_id

    def room_path(self, world_id: str, path: str) -> Path:
        if not re.fullmatch(PATH_PATTERN, path):
            raise KeyError("Unknown room")
        return self.folder(world_id) / "rooms" / path

    def room_folder(self, world_id: str, path: str) -> Path:
        folder = self.room_path(world_id, path)
        folder.mkdir(parents=True, exist_ok=True)
        return folder

    def load(self, world_id: str) -> World | None:
        target = self.folder(world_id) / "world.json"
        with self.lock:
            return World.model_validate_json(target.read_text()) if target.is_file() else None

    def require(self, world_id: str) -> World:
        world = self.load(world_id)
        if world is None:
            raise KeyError("Unknown world")
        return world

    def save(self, world: World) -> World:
        with self.lock:
            world.updated_at = now()
            atomic_json(self.folder(world.id) / "world.json", world.model_dump(mode="json"))
            return world

    def mutate(self, world_id: str, change: Callable[[World], None]) -> World:
        with self.lock:
            world = self.require(world_id)
            change(world)
            return self.save(world)

    def room(self, world_id: str, path: str) -> WorldRoom:
        world = self.require(world_id)
        if path not in world.rooms:
            raise KeyError("Unknown room")
        return world.rooms[path]

    def set_job(self, world_id: str, path: str, name: JobName, **changes) -> World:
        def change(world: World):
            job = getattr(world.rooms[path].jobs, name)
            for key, value in changes.items():
                setattr(job, key, value)
            if "status" in changes:
                job.owner = os.getpid() if job.status in ACTIVE else None
            job.updated_at = now()
        return self.mutate(world_id, change)

    @staticmethod
    def running(job) -> bool:
        """Active and owned by a live process (several rooms-server processes may share one store)."""
        return job.status in ACTIVE and pid_alive(job.owner)

    def write_json(self, world_id: str, path: str, name: str, value) -> Path:
        target = self.room_folder(world_id, path) / name
        atomic_json(target, value)
        return target

    def read_json(self, world_id: str, path: str, name: str) -> dict | None:
        target = self.room_folder(world_id, path) / name
        return json.loads(target.read_text()) if target.is_file() else None

    def worlds(self) -> list[World]:
        result = []
        for folder in sorted(self.root.iterdir()):
            if re.fullmatch(WORLD_ID, folder.name) and (folder / "world.json").is_file():
                result.append(World.model_validate_json((folder / "world.json").read_text()))
        return result

    def recover_interrupted(self) -> int:
        """Jobs whose owning process has exited cannot resume; mark them failed."""
        count = 0
        with self.lock:
            for world in self.worlds():
                changed = world.status == "planning" and not pid_alive(world.planner_pid)
                if changed:
                    world.status, world.error = "failed", "Planning was interrupted by a server restart; create the world again"
                for room in world.rooms.values():
                    for name in ("scan", "physics", "export", "children", "demo"):
                        job = getattr(room.jobs, name)
                        if job.status in ACTIVE and not self.running(job):
                            job.status, job.error, job.message = "failed", "Interrupted by a server restart", ""
                            job.updated_at = now()
                            changed = True
                            count += 1
                if changed:
                    self.save(world)
        return count
