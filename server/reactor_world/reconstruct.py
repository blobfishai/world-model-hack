"""Reconstruct a room's physics from its Reactor scan: Gemini → WorldRoomSpec → MJCF, with repair passes."""
from __future__ import annotations

import hashlib
import json
import subprocess
from pathlib import Path
from typing import Callable

import numpy as np
from pydantic import ValidationError

from room_sim.builds import extract_frames
from room_sim.compiler import compile_room, validate_physics
from task_rooms.config import safe_error

from . import gemini
from .schema import PhysicsSummary, WorldRoom, WorldRoomSpec, WorldTask

# Shared conventions with room_sim.builds.infer_scene, which is bound to the four legacy rooms.
RULES = (
    "Use meters, Z-up, X left-to-right, Y away from the main viewpoint, origin at the floor center. "
    "Objects use BASE-CENTER positions, full width/depth/height, yaw radians; local front is -Y. "
    "Every color must be a six-digit #RRGGBB hex string (for example #f5f0e4), never a color name. "
    "Object IDs must be unique lowercase slugs starting with a letter, using letters, numbers, hyphens, or underscores. "
    "Table, cabinet, drawer, and shelf dimensions must each be at least 0.2 meters. version must be 1. "
    "Use supported parametric furniture and small rigid objects. Cabinet means a hinged front door; drawer means a sliding tray. "
    "Counter is a SOLID block. Sink is a fixed hollow rectangular basin: its size describes the basin only, "
    "not a floor-to-counter cabinet; its base is normally 0.5–0.7m above the floor. "
    "Use a sink for a visible recessed wash basin and keep any surrounding counter blocks outside its cavity. "
    "Never place an object inside a solid counter. Place supported objects with their base at or just above the support's top. "
    "Set movable=true only for small rigid objects; furniture stays fixed. Provide evidence frame indexes for every object. "
    "Do not simulate people, fluids, fabric, appliances' internal functions, or unseen rooms. "
    "Leave clear space in front of doors and drawers. Place objects just above support surfaces, avoiding intersections. "
    "Bound all objects inside the room dimensions. Cup and bowl are hollow circular containers; tray is a hollow rectangle. "
    "Mass/friction are material priors. Record uncertainty in notes. Scale is estimated; say so in notes. "
    "Describe visible colors, materials, and lighting in appearance."
)


def trim(scan: Path, start: float, destination: Path) -> Path:
    destination.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{max(0., start):.3f}", "-i", str(scan), "-an",
                    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", str(destination)],
                   check=True, capture_output=True, timeout=120)
    return destination


def prompt(room_id: str, task: WorldTask) -> str:
    objects = "; ".join(f"{o.id} ({o.label}, kind {o.kind}, about {o.size[0]:.2f}×{o.size[1]:.2f}×{o.size[2]:.2f} m)"
                        for o in task.objects) or "none listed"
    robot = task.robot_task
    clearance = (f"Keep at least 0.6 m of clear floor beside the fixed support under {robot.object}, on a side facing open "
                 "floor, where a robot arm on a pedestal can stand. " if robot and robot.feasible else "")
    return (
        f"room_id must be {room_id}. These 12 timestamped frames come from a Reactor LingBot World 2 world-model "
        "walkthrough generated from household footage; the camera turns in place inside one room. Reconstruct that "
        "single room as a consistent functional physical approximation; when frames disagree, prefer the layout most "
        f"frames support. The room's task: {task.goal} Include these task objects with exactly these ids and kinds and "
        f"about these sizes: {objects}. Small task objects are movable. If a task object is not clearly visible, still "
        "place it where the task implies on the most plausible support, cite the frame that shows that support, and add a "
        f"note. {clearance}{RULES}")


def infer(room_id: str, task: WorldTask, frames: list[dict], folder: Path, raw_path: Path,
          previous: dict | None = None, feedback: list[str] | None = None) -> WorldRoomSpec:
    text = prompt(room_id, task)
    if feedback:
        text += f"\nRepair the scene using execution feedback. Previous candidate: {json.dumps(previous)}\nFeedback: {json.dumps(feedback)}"
    contents: list = [text]
    for frame in frames:
        contents.extend([f"Frame {frame['index']} at {frame['timestamp']}s", gemini.image_part(folder / frame["file"])])
    spec = gemini.generate(WorldRoomSpec, contents, raw_path=raw_path)
    spec.room_id = room_id
    spec.scale_status = "estimated"
    valid = {frame["index"] for frame in frames}
    if any(not o.evidence or any(e.frame not in valid for e in o.evidence) for o in spec.objects):
        raise ValueError("Every reconstructed object must cite an available evidence frame")
    return spec


def task_goal(spec: WorldRoomSpec, task: WorldTask) -> list[float] | None:
    """Where the robot task should end, in room coordinates (for the physics view's goal marker)."""
    robot = task.robot_task
    objects = {o.id: o for o in spec.objects}
    if robot is None or robot.object not in objects:
        return None
    obj = objects[robot.object]
    position = np.asarray(obj.position, float)
    if robot.kind == "lift" or robot.anchor not in objects:
        return [round(float(v), 3) for v in position + [0, 0, obj.size[2] + .15]]
    anchor = objects[robot.anchor]
    center = np.asarray(anchor.position, float)
    if robot.relation == "beside":
        direction = position[:2] - center[:2]
        direction /= max(np.linalg.norm(direction), 1e-6)
        point = center[:2] + direction * (np.linalg.norm(anchor.size[:2]) / 2 + np.linalg.norm(obj.size[:2]) / 2 + .04)
        return [round(float(point[0]), 3), round(float(point[1]), 3), round(float(position[2]), 3)]
    return [round(float(center[0]), 3), round(float(center[1]), 3), round(float(center[2] + anchor.size[2]), 3)]


def reconstruct_room(store, world_id: str, path: str, progress: Callable[[str], None] = print) -> PhysicsSummary:
    world = store.require(world_id)
    room: WorldRoom = world.rooms[path]
    folder = store.room_folder(world_id, path)
    scan = folder / "scan.mp4"
    if not scan.is_file():
        raise ValueError("Generate this room's Reactor scan first")
    receipt = store.read_json(world_id, path, "scan.json") or {}
    work = folder / "physics"
    progress("Extracting evidence frames from the Reactor scan")
    start = receipt.get("walk_in_end_seconds") or 0.
    source = trim(scan, start, work / "source.mp4")
    frames = extract_frames(source, work / "frames")
    room_id = f"w{world_id[:8]}-{path}"
    attempts, previous, feedback, spec, validation = [], None, None, None, None
    for attempt in range(3):
        progress(f"Reconstructing the room with Gemini (attempt {attempt + 1} of 3)")
        try:
            candidate = infer(room_id, room.task, frames, work / "frames", work / f"response-{attempt}.json", previous, feedback)
            previous = candidate.model_dump(mode="json")
            result = validate_physics(compile_room(candidate))
            attempts.append({"attempt": attempt, "valid": result["valid"], "errors": result["errors"]})
            if result["valid"]:
                spec, validation = candidate, result
                break
            feedback = result["errors"]
        except (ValidationError, ValueError) as exc:
            message = safe_error(exc)[:1500]
            attempts.append({"attempt": attempt, "valid": False, "errors": [message]})
            feedback = [message]
    store.write_json(world_id, path, "physics/attempts.json", attempts)
    if spec is None:
        raise ValueError(f"Reconstruction failed physics validation after 3 attempts: {'; '.join(feedback or [])[:400]}")
    payload = spec.model_dump(mode="json")
    revision = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()[:32]
    goal = task_goal(spec, room.task)
    present = {o.id for o in spec.objects}
    store.write_json(world_id, path, "scene.json", {
        "spec": payload, "revision": revision, "validation": validation, "attempts": attempts, "goal": goal,
        "missing_task_objects": [o.id for o in room.task.objects if o.id not in present],
        "source": {"scan_sha256": receipt.get("sha256"), "trim_start_seconds": start, "frames": frames}})
    return PhysicsSummary(revision=revision, objects=len(spec.objects), valid=True, goal=goal)
