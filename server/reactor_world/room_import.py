"""Carry a selected robot room and its reviewed Reactor recording into Playground."""
from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path

from room_sim.worlds import scenario
from task_rooms.config import PROJECT_ROOT
from task_rooms.media import file_digest, inspect_video

from .schema import Job, RobotTask, RoomJobs, SourceRef, TaskObject, World, WorldRoom, WorldTask
from .store import WorldStore, now


def import_robot_room(store: WorldStore, path: str, assets: Path | None = None) -> World:
    scene, theme, kind, seed = scenario(path)
    assets = assets or PROJECT_ROOT / "public/reactor-gyms"
    video, image, receipt_file = (assets / f"{theme['id']}.{suffix}" for suffix in ("mp4", "jpg", "json"))
    receipt = json.loads(receipt_file.read_text())
    if receipt.get("status") != "ready":
        raise ValueError("This room's Reactor recording has not been reviewed yet")
    digest = file_digest(video)
    if not receipt.get("video_sha256") or digest != receipt["video_sha256"]:
        raise ValueError("This room's Reactor recording does not match its reviewed receipt")
    if not image.is_file():
        raise ValueError("This room's reference frame is missing")
    identifier = hashlib.sha256(f"robot-room-v1:{path}:{kind}:{digest}".encode()).hexdigest()[:16]
    with store.lock:
        existing = store.load(identifier)
        if existing is not None:
            return existing
        target = next(obj for obj in scene["spec"]["objects"] if obj["id"] == "target")
        goal = {"reach": f"Position the gripper over the {theme['object']}",
                "push": f"Push the {theme['object']} onto the goal",
                "lift": f"Grasp and lift the {theme['object']}"}[kind]
        task = WorldTask(title=goal, goal=goal, objects=[TaskObject(id="target", label=theme["object"],
                         kind=target["kind"], size=target["size"])], robot_task=RobotTask(kind=kind, object="target"))
        stamp = now()
        root = WorldRoom(path="root", parent=None, depth=0, title=theme["name"], relation="source", door_label=theme["name"],
                         bearing=0, prompt=receipt.get("prompt") or f"Photorealistic {theme['name']}. {theme['description']}",
                         seed=seed % 2**31, task=task,
                         jobs=RoomJobs(scan=Job(status="ready", progress=100, message="Imported reviewed Reactor footage", updated_at=stamp)))
        world = World(id=identifier, status="ready", source=SourceRef(id=f"gym-{theme['id']}",
                      file=f"public/reactor-gyms/{theme['id']}.mp4", t=0, task_type=kind, sha256=digest),
                      hub_title=theme["name"], summary=theme["description"], rooms={"root": root},
                      planner={"method": "reviewed-reactor-room-import", "room_path": path},
                      created_at=stamp, updated_at=stamp,
                      attribution="Reactor LingBot World 2 · generated room footage from an authored reference image")
        folder = store.room_folder(identifier, "root")
        shutil.copy2(video, folder / "scan.mp4")
        shutil.copy2(image, folder / "arrival.jpg")
        shutil.copy2(image, store.folder(identifier) / "start.jpg")
        shutil.copy2(receipt_file, folder / "generation-receipt.json")
        info = inspect_video(video)
        generation = receipt.get("walk_generation") or {}
        store.write_json(identifier, "root", "scan.json", {
            "model": generation.get("model", "reactor/lingbot-world-2"), "session_id": generation.get("session_id"),
            "seed": generation.get("seed"), "prompt": generation.get("prompt", root.prompt), "sha256": digest,
            "imported": True, "source_room": path, "walk_in_end_seconds": 0,
            "video": {"width": info.width, "height": info.height, "fps": info.fps, "duration_seconds": info.duration_seconds},
        })
        return store.save(world)
