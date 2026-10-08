"""Gemini plans the hub and task rooms from the beginning image (one structured call per level)."""
from __future__ import annotations

import hashlib
import os
from pathlib import Path

from . import gemini
from .schema import ChildrenPlan, HubPlan, SourceRef, World, WorldRoom
from .sources import ATTRIBUTION
from .store import now

PLANNER_VERSION = 2  # 2: sharpest well-lit frame within 1.5 s of the requested start
ARC = 150  # child doors spread across the front of each room, in degrees

KINDS = ("Use kinds: table, counter, sink, shelf, cabinet, drawer, sofa, bed for furniture, and box, book, cylinder, "
         "bottle, cup, bowl, tray for objects. Use box for sponges, cloths and blocks; tray or bowl for plates.")
TASK_RULES = (
    "Every task has: title; goal (one or two sentences with a concrete, checkable success condition); objects "
    "(2–6 objects involved: id as a lowercase_slug, label, kind, realistic size in meters [width, depth, height]); and "
    "robot_task for one Franka Panda arm: kind \"lift\" (pick the object up) or \"place\" (move the object relative to an "
    "anchor object with relation \"beside\", \"on\" or \"in\"). The robot object must be a small rigid object whose "
    "narrowest horizontal side is at most 7.5 cm (sponge, cup, bottle, block, utensil, small box) resting on a counter, "
    "table, shelf or similar support, and the anchor must also be a task object. Set robot_task to null when the task "
    "has no such object. " + KINDS)
ROOM_RULES = (
    "For each room give: title (imperative task name, at most 6 words); door_label (room name, at most 3 words); "
    "prompt (at most 600 characters: what you see when you walk into the room at eye level, keeping the same home's "
    "materials, palette and lighting, naming the task objects and where they rest; no people, hands, text or camera "
    "jargon); relation; and task.")


def world_id(signature: str, t: float) -> str:
    model = os.environ.get("GEMINI_MODEL", "gemini-3.8-flash")
    return hashlib.sha256(f"{signature}:{t:.2f}:planner-v{PLANNER_VERSION}:{model}".encode()).hexdigest()[:16]


def room_seed(identifier: str, path: str) -> int:
    return int(hashlib.sha256(f"{identifier}:{path}".encode()).hexdigest()[:8], 16) % (2**31 - 1)


def spread(count: int, behind: bool = False) -> list[float]:
    """Door bearings (degrees, + right). At a work surface the open room, and its doors, lie behind the player."""
    if count <= 1:
        return [180. if behind else 0.] * count
    start = 180 - ARC / 2 if behind else -ARC / 2
    return [round((start + ARC * i / (count - 1) + 180) % 360 - 180, 1) for i in range(count)]


def plan_hub(image: Path, task_type: str | None, raw_path: Path) -> HubPlan:
    activity = f" of {task_type.replace('_', ' ')}" if task_type else ""
    prompt = (
        "You are designing an explorable, photoreal world for Reactor's LingBot World 2 world model, plus robot-learning "
        f"task rooms. The image is the first frame of an egocentric (head-mounted camera) household video{activity}. "
        "LingBot starts generating from exactly this image and the user walks around with WASD and mouse-look.\n"
        "Return: hub_title (short name for this space); summary (one sentence about the space and activity); hub_prompt "
        "(at most 600 characters: room type, layout, surfaces, materials, colors, lighting and the visible objects with "
        "their positions, written as a first-person eye-level walkable space in present tense; no people, hands, text "
        "or camera jargon); camera_pitch_hint (\"down\" when the camera looks steeply down at a work surface, otherwise "
        "\"level\"); hub_task (the task done or set up in the image); rooms: exactly 6 adjacent spaces of the SAME home, "
        "each reached through a doorway and each staging a different task derived from the objects and activity in the "
        "image — 2 \"similar\" (same skill, different object or placement), 1 \"subskill\" (one component step), "
        "2 \"harder\" (more steps or precision), 1 \"variation\" (same task, different arrangement or setting).\n"
        f"{ROOM_RULES}\n{TASK_RULES}")
    return gemini.generate(HubPlan, [prompt, gemini.image_part(image)], raw_path=raw_path)


def plan_children(image: Path, room: WorldRoom, raw_path: Path) -> ChildrenPlan:
    prompt = (
        f"The image is the arrival view of the room \"{room.title}\" in a world generated from egocentric household "
        f"footage. Its task: {room.task.goal}\nPropose 6 further rooms that branch from this room through doorways, in "
        "the same home: mix \"similar\", \"subskill\", \"harder\" and \"variation\" relations relative to this room's "
        f"task.\n{ROOM_RULES}\n{TASK_RULES}")
    return gemini.generate(ChildrenPlan, [prompt, gemini.image_part(image)], raw_path=raw_path)


def build_world(identifier: str, source: SourceRef, plan: HubPlan) -> World:
    paths = [str(i) for i in range(len(plan.rooms))]
    rooms = {"root": WorldRoom(path="root", parent=None, children=paths, depth=0, title=plan.hub_task.title,
                               relation="source", door_label=plan.hub_title[:40] or "Start", bearing=0,
                               prompt=plan.hub_prompt, camera_pitch_hint=plan.camera_pitch_hint,
                               seed=room_seed(identifier, "root"), task=plan.hub_task)}
    for path, room, bearing in zip(paths, plan.rooms, spread(len(plan.rooms), behind=plan.camera_pitch_hint == "down")):
        rooms[path] = WorldRoom(path=path, parent="root", depth=1, title=room.title, relation=room.relation,
                                door_label=room.door_label, bearing=bearing, prompt=room.prompt,
                                seed=room_seed(identifier, path), task=room.task)
    stamp = now()
    return World(id=identifier, status="ready", source=source, hub_title=plan.hub_title, summary=plan.summary,
                 rooms=rooms, planner={"version": PLANNER_VERSION, "model": os.environ.get("GEMINI_MODEL", "gemini-3.8-flash")},
                 created_at=stamp, updated_at=stamp, attribution=ATTRIBUTION)


def add_children(world: World, parent: str, plan: ChildrenPlan) -> list[str]:
    room = world.rooms[parent]
    if room.depth >= 5:
        raise ValueError("Rooms can nest five levels deep")
    paths = [f"{parent}.{i}" if parent != "root" else str(i) for i in range(len(plan.rooms))]
    for path, child, bearing in zip(paths, plan.rooms, spread(len(plan.rooms))):
        world.rooms[path] = WorldRoom(path=path, parent=parent, depth=room.depth + 1, title=child.title,
                                      relation=child.relation, door_label=child.door_label, bearing=bearing,
                                      prompt=child.prompt, seed=room_seed(world.id, path), task=child.task)
    room.children = paths
    return paths
