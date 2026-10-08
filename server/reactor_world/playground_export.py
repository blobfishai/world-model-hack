"""Export a reconstructed world room as a MuJoCo Playground (MJX) Franka Panda environment.

Playground's PandaPickCube assumes the robot base at the origin, its task surface (geom "floor") at z = 0,
and the object within one meter (`step` terminates when |object| > 1 m or z < 0). The export therefore writes
the room in a robot frame: the base stands on a pedestal beside the support surface, rotated so the object
lies along +x, with the support top at z = 0. All collision geometry is boxes and planes, which MJX's JAX
backend supports; containers become a base plus four walls instead of the editor's sixteen staves.
"""
from __future__ import annotations

import json
import math
import os
import re
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from datetime import datetime, timezone
from importlib.util import find_spec
from pathlib import Path
from typing import Callable

import numpy as np

from room_sim.compiler import values
from room_sim.schema import RoomObject
from task_rooms.config import safe_error
from task_rooms.media import file_digest

from . import bundle_templates as templates
from .schema import ExportSummary, WorldRoomSpec, WorldTask
from .sources import ATTRIBUTION, SOURCE_URL

PLAYGROUND_VERSION = "0.2.0"
MENAGERIE_COMMIT = "1b86ece576591213e2b666ebf59508454200ca97"
PANDA_HOME = [0, .3, 0, -1.57079, 0, 2.0, -.7853, .04, .04]
PANDA_CTRL = [0, .3, 0, -1.57079, 0, 2.0, -.7853, .04]
BASE_OUTSIDE = .12   # minimum distance of the base center beyond the support edge
MAX_OUTSIDE = .4
PEDESTAL = .3
REACH = (.35, .8)
PREFERRED = .55
COLLIDE_WITHIN = 1.1
SLAB = .04
GRASP = .075
CLAMPED_GRASP = .07
FIXED_SUPPORTS = {"table", "counter", "sink", "shelf", "cabinet", "drawer", "box", "tray", "bed", "sofa", "book"}


class ExportError(ValueError):
    """The room cannot host the Playground task; the message says why."""


def rot(yaw: float) -> np.ndarray:
    c, s = math.cos(yaw), math.sin(yaw)
    return np.array([[c, -s], [s, c]])


def quat_z(yaw: float) -> str:
    return values([math.cos(yaw / 2), 0, 0, math.sin(yaw / 2)])


def rgba(color: str, alpha: float = 1) -> str:
    return values([int(color[i:i + 2], 16) / 255 for i in (1, 3, 5)] + [alpha])


def hollow_thickness(width: float, depth: float, height: float) -> float:
    # Matches room_sim.compiler's tray(): the supported floor of a sink or tray sits this far above its base.
    return min(.015, width / 10, depth / 10, height / 4)


def support_top(obj: RoomObject) -> float:
    if obj.kind in {"sink", "tray"}:
        return obj.position[2] + hollow_thickness(*obj.size)
    return obj.position[2] + obj.size[2]


def local_xy(point, obj: RoomObject) -> np.ndarray:
    return rot(-obj.yaw) @ (np.asarray(point[:2], float) - np.asarray(obj.position[:2], float))


@dataclass
class Frame:
    """Room frame (Z up, origin at the floor center) → robot frame (base at origin, object along +x)."""
    base: np.ndarray
    yaw: float
    top: float

    def point(self, p) -> list[float]:
        q = rot(-self.yaw) @ (np.asarray(p[:2], float) - self.base)
        return [float(q[0]), float(q[1]), float(p[2]) - self.top]

    def heading(self, yaw: float) -> float:
        return yaw - self.yaw


@dataclass
class Layout:
    frame: Frame
    support: RoomObject
    target: RoomObject
    side: str
    distance: float
    size: list[float]
    spawn: tuple[list[float], list[float]]
    goal: tuple[list[float], list[float]]
    notes: list[str] = field(default_factory=list)


def find_support(spec: WorldRoomSpec, target: RoomObject) -> tuple[RoomObject, float]:
    best = None
    for obj in spec.objects:
        if obj.movable or obj.id == target.id or obj.kind not in FIXED_SUPPORTS:
            continue
        inside = np.all(np.abs(local_xy(target.position, obj)) <= np.asarray(obj.size[:2]) / 2 - .005)
        gap = target.position[2] - support_top(obj)
        if inside and -.02 <= gap <= .05 and (best is None or abs(gap) < best[0]):
            best = (abs(gap), obj)
    if best is None:
        raise ExportError(f"{target.id} does not rest on a fixed counter, table, sink, shelf or similar support")
    return best[1], support_top(best[1])


def _blocks(point: np.ndarray, radius: float, obj: RoomObject) -> bool:
    local = local_xy(point, obj)
    nearest = np.clip(local, -np.asarray(obj.size[:2]) / 2, np.asarray(obj.size[:2]) / 2)
    return bool(np.linalg.norm(local - nearest) < radius)


def place_robot(spec: WorldRoomSpec, support: RoomObject, target: RoomObject, top: float) -> tuple[Frame, str, float]:
    width, depth = support.size[:2]
    obj_local = local_xy(target.position, support)
    w, d, _ = spec.dimensions
    radius = PEDESTAL / 2 * math.sqrt(2)
    reasons, options = [], []
    for side, normal in (("front", (0, -1)), ("back", (0, 1)), ("left", (-1, 0)), ("right", (1, 0))):
        n = np.array(normal, float)
        edge = obj_local.copy()
        if n[0]:
            edge[0] = n[0] * width / 2
        else:
            edge[1] = n[1] * depth / 2
        # Stand back from the edge when the object is close to it, so the arm works near its preferred reach.
        inset = float(np.linalg.norm(edge - obj_local))
        outside = float(np.clip(PREFERRED - inset, BASE_OUTSIDE, MAX_OUTSIDE))
        base = np.asarray(support.position[:2], float) + rot(support.yaw) @ (edge + n * outside)
        distance = float(np.linalg.norm(np.asarray(target.position[:2]) - base))
        if not REACH[0] <= distance <= REACH[1]:
            reasons.append(f"{side}: object {distance:.2f} m from the base")
            continue
        if abs(base[0]) > w / 2 - PEDESTAL / 2 or abs(base[1]) > d / 2 - PEDESTAL / 2:
            reasons.append(f"{side}: pedestal outside the room")
            continue
        blocker = next((o.id for o in spec.objects if o is not support and not o.movable
                        and o.position[2] < top - .02 and _blocks(base, radius, o)), None)
        if blocker:
            reasons.append(f"{side}: {blocker} occupies the pedestal space")
            continue
        heading = math.atan2(target.position[1] - base[1], target.position[0] - base[0])
        options.append((abs(distance - PREFERRED), Frame(base, heading, top), side, distance))
    if not options:
        raise ExportError(f"No clear floor beside {support.id} within the Panda's reach ({'; '.join(reasons)})")
    _, frame, side, distance = min(options, key=lambda option: option[0])
    return frame, side, distance


def _support_rect(frame: Frame, support: RoomObject) -> tuple[np.ndarray, np.ndarray]:
    corners = [frame.point(np.r_[np.asarray(support.position[:2]) + rot(support.yaw) @ np.array([a * support.size[0] / 2, b * support.size[1] / 2]), 0])
               for a in (-1, 1) for b in (-1, 1)]
    xy = np.array([c[:2] for c in corners])
    return xy.min(axis=0), xy.max(axis=0)


def surface_obstacles(spec: WorldRoomSpec, frame: Frame, support: RoomObject, target: RoomObject,
                      top: float, anchor: RoomObject | None) -> list[tuple[np.ndarray, np.ndarray]]:
    """Robot-frame boxes of other objects resting on the task surface (spawn and goal regions must avoid them)."""
    boxes = []
    for obj in spec.objects:
        if obj is support or obj.id == target.id or (anchor is not None and obj.id == anchor.id):
            continue
        if abs(obj.position[2] - top) > .05:
            continue
        corners = np.array([frame.point(np.r_[np.asarray(obj.position[:2]) + rot(obj.yaw) @ np.array([a * obj.size[0] / 2, b * obj.size[1] / 2]), 0])[:2]
                            for a in (-1, 1) for b in (-1, 1)])
        boxes.append((corners.min(axis=0), corners.max(axis=0)))
    return boxes


def clear_of(point: np.ndarray, half: float, boxes) -> bool:
    return all(np.any(point + half <= low) or np.any(point - half >= high) for low, high in boxes)


def carve(low: np.ndarray, high: np.ndarray, origin: np.ndarray, half: float, boxes) -> tuple[np.ndarray, np.ndarray]:
    """Shrink the spawn box around `origin` so a centered object of half-size `half` never overlaps an obstacle."""
    low, high = low.copy(), high.copy()
    for box_low, box_high in boxes:
        box_low, box_high = box_low - half - .01, box_high + half + .01
        if np.any(high <= box_low) or np.any(low >= box_high):
            continue
        # Cut along the axis that keeps the larger region, on the obstacle's side of the origin.
        options = []
        for axis in (0, 1):
            if box_low[axis] > origin[axis]:
                options.append((axis, "high", box_low[axis]))
            elif box_high[axis] < origin[axis]:
                options.append((axis, "low", box_high[axis]))
        if not options:
            continue
        def area(option):
            axis, side, value = option
            trial_low, trial_high = low.copy(), high.copy()
            (trial_high if side == "high" else trial_low)[axis] = value
            return float(np.prod(np.maximum(trial_high - trial_low, 0)))
        axis, side, value = max(options, key=area)
        if side == "high":
            high[axis] = min(high[axis], value)
        else:
            low[axis] = max(low[axis], value)
    return low, np.maximum(high, low)


def beside_point(center: np.ndarray, anchor: RoomObject, frame: Frame, low: np.ndarray, high: np.ndarray,
                 start: np.ndarray, half: float, boxes=()) -> np.ndarray | None:
    """A spot on the support next to the anchor: reachable, and far enough from the start to need moving."""
    heading = frame.heading(anchor.yaw)
    extents = np.abs(rot(heading)) @ (np.asarray(anchor.size[:2], float) / 2)
    candidates = []
    for axis in (0, 1):
        for sign in (-1, 1):
            point = center.copy()
            point[axis] += sign * (extents[axis] + half + .04)
            point = np.clip(point, low, high)
            # Clipping can pull the spot back under the anchor; keep it clear of the anchor's footprint.
            clear = np.any(np.abs(point - center) >= extents + half + .01)
            distance = float(np.linalg.norm(point))
            if clear and clear_of(point, half + .01, boxes) and REACH[0] - .05 <= distance <= REACH[1] \
                    and np.linalg.norm(point - start) >= .1:
                candidates.append((distance, point))
    return min(candidates, key=lambda c: c[0])[1] if candidates else None


def plan_layout(spec: WorldRoomSpec, task: WorldTask) -> Layout:
    robot = task.robot_task
    if robot is None:
        raise ExportError("This room's task has no single-arm robot subtask")
    if not robot.feasible:
        raise ExportError(robot.reason or "The robot task is not feasible for a Panda gripper")
    objects = {o.id: o for o in spec.objects}
    target = objects.get(robot.object)
    if target is None:
        raise ExportError(f"The reconstruction has no {robot.object}; rebuild physics so the task object is present")
    notes = []
    width, depth, height = target.size
    if robot.kind in {"lift", "place"} and min(width, depth) > .12:
        raise ExportError(f"The reconstructed {target.id} is {min(width, depth) * 100:.0f} cm across; too wide for the Panda gripper")
    if robot.kind in {"lift", "place"} and min(width, depth) > GRASP:
        scale = CLAMPED_GRASP / min(width, depth)
        width, depth = (width * scale, depth) if width <= depth else (width, depth * scale)
        notes.append(f"{target.id}'s narrow side was clamped to {CLAMPED_GRASP * 100:.0f} cm for the gripper")
    height = float(np.clip(height, .02, .3))
    # The Panda closes its fingers along the robot's x axis; the object's reconstructed yaw is only an estimate,
    # so the export turns its narrow side toward the fingers.
    width, depth = sorted((width, depth))
    support, top = find_support(spec, target)
    frame, side, distance = place_robot(spec, support, target, top)
    origin = frame.point(target.position)
    low, high = _support_rect(frame, support)
    margin = max(width, depth) / 2 + .02
    spawn_low, spawn_high = [], []
    for axis in (0, 1):
        lo = max(low[axis] + margin, origin[axis] - .12)
        hi = min(high[axis] - margin, origin[axis] + .12)
        if axis == 0:
            lo, hi = max(lo, .3), min(hi, .75)
        if lo > hi:
            lo = hi = float(np.clip(origin[axis], low[axis] + margin, high[axis] - margin)) if low[axis] + margin <= high[axis] - margin else origin[axis]
        spawn_low.append(round(lo, 4))
        spawn_high.append(round(hi, 4))
    anchor_object = objects.get(robot.anchor or "") if robot.kind == "place" else None
    boxes = surface_obstacles(spec, frame, support, target, top, anchor_object)
    # Spawning also avoids the anchor; the goal may sit on or beside it.
    carved_low, carved_high = carve(np.array(spawn_low), np.array(spawn_high), np.array(origin[:2]), max(width, depth) / 2,
                                    surface_obstacles(spec, frame, support, target, top, None))
    spawn_low, spawn_high = [round(float(v), 4) for v in carved_low], [round(float(v), 4) for v in carved_high]
    rest = round(height / 2, 4)
    spawn = ([*spawn_low, rest], [*spawn_high, rest])
    if robot.kind == "lift":
        goal = ([*spawn_low, rest + .2], [*spawn_high, rest + .35])
    elif robot.kind == "reach":
        goal = ([*spawn_low, rest + .03], [*spawn_high, rest + .03])
    elif robot.kind == "push":
        start = np.asarray(origin[:2])
        candidates = []
        for axis, sign in ((1, 1), (1, -1), (0, 1), (0, -1)):
            point = start.copy()
            point[axis] += sign * .18
            corridor = [start + (point - start) * alpha for alpha in np.linspace(0, 1, 12)]
            if all(np.all(p >= low + margin) and np.all(p <= high - margin)
                   and .3 <= p[0] <= .75 and np.linalg.norm(p) < .8
                   and clear_of(p, max(width, depth) / 2 + .01, boxes) for p in corridor):
                candidates.append(point)
        if not candidates:
            raise ExportError(f"No clear 18 cm pushing path on {support.id}")
        point = candidates[0]
        # Small spawn randomization keeps every episode on the checked corridor.
        spawn = ([round(origin[0] - .015, 4), round(origin[1] - .015, 4), rest],
                 [round(origin[0] + .015, 4), round(origin[1] + .015, 4), rest])
        goal = ([round(point[0] - .025, 4), round(point[1] - .025, 4), rest],
                [round(point[0] + .025, 4), round(point[1] + .025, 4), rest])
    else:
        anchor = objects.get(robot.anchor or "")
        if anchor is None:
            raise ExportError(f"The reconstruction has no anchor {robot.anchor}; rebuild physics")
        center = np.array(frame.point(anchor.position)[:2])
        anchor_top = anchor.position[2] + anchor.size[2] - top
        if robot.relation == "beside":
            point = beside_point(center, anchor, frame, low + margin, high - margin, np.array(origin[:2]), max(width, depth) / 2, boxes)
            if point is None:
                raise ExportError(f"No reachable spot beside {anchor.id} on {support.id}")
            z = rest
        else:
            point = center
            floor = anchor.position[2] + (hollow_thickness(*anchor.size) if anchor.kind in {"sink", "tray", "cup", "bowl"} else anchor.size[2]) - top
            z = (floor if robot.relation == "in" else anchor_top) + rest + .01
            if z < rest:
                z = anchor_top + rest + .05
                notes.append(f"{anchor.id}'s interior is below the support surface, so the target hovers just above it")
        jitter = .03 if robot.relation == "beside" else .015
        goal = ([round(point[0] - jitter, 4), round(point[1] - jitter, 4), round(z, 4)],
                [round(point[0] + jitter, 4), round(point[1] + jitter, 4), round(z, 4)])
    spawn = tuple([round(float(v), 4) for v in bound] for bound in spawn)
    goal = tuple([round(float(v), 4) for v in bound] for bound in goal)
    for bound in (*spawn, *goal):
        if np.linalg.norm(bound[:2]) > .85 or not 0 <= bound[2] <= .8 or max(abs(v) for v in bound) >= .95:
            raise ExportError("The task region falls outside the Panda workspace or PandaPickCube's 1 m episode bounds")
    return Layout(frame, support, target, side, float(distance), [round(float(v), 4) for v in (width, depth, height)],
                  spawn, goal, notes)


class SceneWriter:
    def __init__(self, layout: Layout, spec: WorldRoomSpec, *, walls: bool = True):
        self.layout, self.spec, self.frame = layout, spec, layout.frame
        self.walls = walls
        self.root = ET.Element("mujoco", model=f"room-{spec.room_id}")
        self.count = {"geoms": 0, "collision": 0}

    def geom(self, name: str | None, center, half, yaw: float, color: str, *, collide=True, kind="box", alpha=1., **extra):
        reach = np.linalg.norm(center[:2]) - np.linalg.norm(np.asarray(half[:2]))
        collide = collide and reach <= COLLIDE_WITHIN
        attributes = {"type": kind, "pos": values(center), "size": values(half), "quat": quat_z(yaw),
                      "rgba": rgba(color, alpha), "contype": "1" if collide else "0", "conaffinity": "1" if collide else "0",
                      "condim": "3", "friction": "1 .005 .0001"}
        if name:
            attributes["name"] = name
        attributes.update(extra)
        ET.SubElement(self.world, "geom", attributes)
        self.count["geoms"] += 1
        self.count["collision"] += int(collide)

    def part(self, obj: RoomObject, local, half, color=None, **extra):
        """A box given in the object's local frame (relative to its base center)."""
        offset = rot(obj.yaw) @ np.asarray(local[:2], float)
        room_point = [obj.position[0] + offset[0], obj.position[1] + offset[1], obj.position[2] + local[2]]
        self.geom(extra.pop("name", None), self.frame.point(room_point), half, self.frame.heading(obj.yaw),
                  color or obj.color, **extra)

    def hollow(self, obj: RoomObject, width, depth, height, base_name=None):
        t = hollow_thickness(width, depth, height)
        if base_name:
            # The supported floor becomes a 4 cm slab whose top is exactly the robot frame's z = 0.
            self.part(obj, [0, 0, t - SLAB / 2], [width / 2, depth / 2, SLAB / 2], name=base_name)
        else:
            self.part(obj, [0, 0, t / 2], [width / 2, depth / 2, t / 2])
        for s in (-1, 1):
            self.part(obj, [s * (width - t) / 2, 0, height / 2], [t / 2, depth / 2, height / 2])
            self.part(obj, [0, s * (depth - t) / 2, height / 2], [width / 2 - t, t / 2, height / 2])

    def furniture(self, obj: RoomObject):
        x, y, z = obj.size
        is_support = obj is self.layout.support
        if obj.kind in {"sink", "tray", "cup", "bowl"}:
            if obj.kind in {"cup", "bowl"}:
                x = y = min(x, y)
            self.hollow(obj, x, y, z, "floor" if is_support else None)
        elif obj.kind == "table":
            slab = SLAB if is_support else min(.055, z / 8)
            self.part(obj, [0, 0, z - slab / 2], [x / 2, y / 2, slab / 2], name="floor" if is_support else None)
            for a in (-1, 1):
                for b in (-1, 1):
                    self.part(obj, [a * (x / 2 - .06), b * (y / 2 - .06), (z - slab) / 2], [.035, .035, (z - slab) / 2])
        elif obj.kind in {"bottle", "cylinder"}:
            self.part(obj, [0, 0, z / 2], [x / 2, y / 2, z / 2], alpha=0)
            radius = min(x, y) / 2
            self.part(obj, [0, 0, z * .4], [radius, z * .4], kind="cylinder", collide=False)
            self.part(obj, [0, 0, z * .9], [radius * .55, z * .1], kind="cylinder", collide=False)
        elif is_support and z > SLAB + .01:
            self.part(obj, [0, 0, z - SLAB / 2], [x / 2, y / 2, SLAB / 2], name="floor")
            self.part(obj, [0, 0, (z - SLAB) / 2], [x / 2, y / 2, (z - SLAB) / 2])
        else:
            self.part(obj, [0, 0, z / 2], [x / 2, y / 2, z / 2], name="floor" if is_support else None)

    def write(self) -> str:
        layout, frame = self.layout, self.frame
        root = self.root
        ET.SubElement(root, "include", file="mjx_panda.xml")
        ET.SubElement(root, "statistic", center="0.35 0 0.1", extent="1.2")
        option = ET.SubElement(root, "option", timestep="0.005", iterations="5", ls_iterations="8", integrator="implicitfast")
        ET.SubElement(option, "flag", eulerdamp="disable")
        custom = ET.SubElement(root, "custom")
        ET.SubElement(custom, "numeric", data="12", name="max_contact_points")
        visual = ET.SubElement(root, "visual")
        ET.SubElement(visual, "headlight", diffuse=".65 .65 .65", ambient=".3 .3 .3", specular="0 0 0")
        ET.SubElement(visual, "global", azimuth="150", elevation="-25", offwidth="1280", offheight="960")
        ET.SubElement(visual, "quality", shadowsize="4096")
        asset = ET.SubElement(root, "asset")
        ET.SubElement(asset, "texture", type="skybox", builtin="gradient", rgb1="0.94 0.93 0.9", rgb2="0.72 0.75 0.72",
                      width="512", height="512")
        self.world = ET.SubElement(root, "worldbody")
        ET.SubElement(self.world, "light", pos="0.3 0 2.2", dir="0 0 -1", directional="true", castshadow="true")
        w, d, h = self.spec.dimensions
        ET.SubElement(self.world, "geom", name="room_floor", type="plane", size="0 0 0.05", pos=values([0, 0, -frame.top]),
                      rgba="0.79 0.75 0.67 1", contype="1", conaffinity="1", condim="3")
        # Context walls (visual only); walls behind the robot would hide it from the default camera.
        for center, half, yaw, color in (([0, d / 2 + .05, h / 2], [w / 2, .05, h / 2], 0, "#e6e0d1"),
                                         ([0, -d / 2 - .05, h / 2], [w / 2, .05, h / 2], 0, "#e6e0d1"),
                                         ([-w / 2 - .05, 0, h / 2], [d / 2, .05, h / 2], math.pi / 2, "#d6d9cc"),
                                         ([w / 2 + .05, 0, h / 2], [d / 2, .05, h / 2], math.pi / 2, "#d6d9cc")):
            point, heading = frame.point(center), frame.heading(yaw)
            # Keep only the wall the robot faces: its thin axis runs along the robot's +x.
            if self.walls and point[0] > .3 and abs(math.sin(heading)) > .7:
                self.geom(None, point, half, heading, color, collide=False)
        if frame.top > .02:
            self.geom(None, [0, 0, -frame.top / 2], [PEDESTAL / 2, PEDESTAL / 2, frame.top / 2], 0, "#3a3f3b", collide=False)
        for obj in self.spec.objects:
            if obj.id != layout.target.id:
                self.furniture(obj)
        x, y, z = layout.size
        start = [(a + b) / 2 for a, b in zip(*layout.spawn)]
        body = ET.SubElement(self.world, "body", name="box", pos=values(start))
        ET.SubElement(body, "freejoint")
        ET.SubElement(body, "geom", type="box", name="box", size=values([x / 2, y / 2, z / 2]), condim="3",
                      friction="1 .03 .003", rgba=rgba(layout.target.color), contype="2", conaffinity="1", solref="0.01 1",
                      mass=f"{float(np.clip(layout.target.mass, .03, 1.)):.4g}")
        mocap = ET.SubElement(self.world, "body", mocap="true", name="mocap_target", pos=values([(a + b) / 2 for a, b in zip(*layout.goal)]))
        ET.SubElement(mocap, "geom", type="box", size=values([x / 2, y / 2, z / 2]), rgba="1 0.25 0.2 0.25", contype="0", conaffinity="0")
        ET.SubElement(root, "include", file="sensor.xml")
        # Finger-pad contacts with the task object, so the exported env checks grasps and releases in code.
        sensor = ET.SubElement(root, "sensor")
        for pad in ("left_finger_pad", "right_finger_pad"):
            ET.SubElement(sensor, "contact", name=f"{pad}_box_found", geom1=pad, geom2="box", reduce="mindist", num="1", data="found")
        keyframe = ET.SubElement(root, "keyframe")
        ET.SubElement(keyframe, "key", name="home", qpos=values([*PANDA_HOME, *start, 1, 0, 0, 0]), ctrl=values(PANDA_CTRL))
        ET.indent(root)
        return ET.tostring(root, encoding="unicode")


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:32] or "room"


def _python() -> list[str]:
    if find_spec("mujoco_playground") is not None:
        return [sys.executable]
    return ["uv", "run", "--isolated", "--no-project", "--python", "3.12", "--with", f"playground=={PLAYGROUND_VERSION}",
            "--with", "pillow", "python"]


def run_bundle_script(bundle: Path, script: str, *arguments: str, timeout: int = 900) -> subprocess.CompletedProcess:
    environment = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}
    try:
        return subprocess.run([*_python(), script, *arguments], cwd=bundle, capture_output=True, text=True,
                              timeout=timeout, env=environment)
    finally:
        for cache in bundle.rglob("__pycache__"):
            shutil.rmtree(cache, ignore_errors=True)


def build_bundle(spec: WorldRoomSpec, task: WorldTask, layout: Layout, destination: Path, *, world: dict,
                 room: dict, references: list[tuple[Path, str]]) -> dict:
    """Write the standalone Playground package (no validation)."""
    if destination.exists():
        shutil.rmtree(destination)
    (destination / "room_envs" / "xmls").mkdir(parents=True)
    key = f"{world['id'][:8]}_{room['path'].replace('.', '_')}"
    env_name = f"PandaPickCubeRoom_{key}"
    xml_name = f"room_{key}.xml"
    (destination / "room_envs" / "xmls" / xml_name).write_text(SceneWriter(layout, spec).write())
    robot = task.robot_task
    description = f"{robot.kind} {robot.object}" + (f" {robot.relation} {robot.anchor}" if robot.kind == "place" else "")
    values_ = {"ENV_NAME": env_name, "XML_NAME": xml_name, "TASK_TITLE": task.title, "TASK_GOAL": task.goal,
               "ROBOT_TASK": description, "SPAWN_LOW": json.dumps(layout.spawn[0]), "SPAWN_HIGH": json.dumps(layout.spawn[1]),
               "TARGET_LOW": json.dumps(layout.goal[0]), "TARGET_HIGH": json.dumps(layout.goal[1]),
               "PLAYGROUND_VERSION": PLAYGROUND_VERSION, "ROOM_TITLE": room["title"], "WORLD_ID": world["id"],
               "SOURCE_FILE": world["source"]["file"], "SOURCE_T": f"{world['source']['t']:.2f}", "ATTRIBUTION": ATTRIBUTION,
               "SOURCE_URL": SOURCE_URL, "BUNDLE": destination.name, "TASK_KIND": robot.kind,
               "LIFT_HEIGHT": f"{0.15 if robot.kind == 'lift' else 0.05:.2f}"}
    for name, template in templates.FILES.items():
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(templates.render(template, values_))
    shutil.copy2(Path(__file__).with_name("task_kernel.py"), destination / "room_envs" / "task_kernel.py")
    folder = destination / "references"
    folder.mkdir()
    for index, (path, role) in enumerate(references):
        if path.is_file():
            shutil.copy2(path, folder / f"{index:02d}-{path.name}")
    return {"env_name": env_name, "xml_name": xml_name, "robot_task": description}


def write_manifest(destination: Path, manifest: dict) -> dict:
    files = []
    for path in sorted(p for p in destination.rglob("*") if p.is_file() and p.name != "manifest.json"):
        files.append({"path": path.relative_to(destination).as_posix(), "sha256": file_digest(path), "bytes": path.stat().st_size})
    manifest["files"] = files
    (destination / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


def export_room(store, world_id: str, path: str, progress: Callable[[str], None] = print, *, validate: bool = True) -> ExportSummary:
    world = store.require(world_id)
    room = world.rooms[path]
    scene = store.read_json(world_id, path, "scene.json")
    if scene is None:
        raise ValueError("Build physics for this room before exporting")
    spec = WorldRoomSpec.model_validate(scene["spec"])
    try:
        layout = plan_layout(spec, room.task)
    except ExportError as exc:
        return ExportSummary(feasible=False, reason=str(exc))
    folder = store.room_folder(world_id, path)
    staging = folder / "export"
    name = f"{world_id[:8]}-{path.replace('.', '-')}-{slug(room.title)}-playground"
    bundle = staging / name
    progress("Writing the MJX scene and Playground environment")
    world_folder = store.folder(world_id)
    references = [(world_folder / "start.jpg", "beginning_image"), (folder / "arrival.jpg", "reactor_arrival_frame"),
                  (folder / "scan.mp4", "reactor_lingbot_scan"), (folder / "storyboard.jpg", "reactor_scan_storyboard"),
                  (folder / "scan.json", "reactor_session_receipt"), (folder / "scene.json", "reconstructed_room"),
                  (folder / "generation-receipt.json", "original_reactor_generation_receipt"),
                  (world_folder / "plan-response.json", "world_plan"),
                  (folder / "robot-demo.mp4", "scripted_demo_simulation"), (folder / "robot-demo-reactor.mp4", "scripted_demo_reactor_render")]
    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True)
    info = build_bundle(spec, room.task, layout, bundle, world=world.model_dump(mode="json"),
                        room=room.model_dump(mode="json"), references=references)
    checks: dict = {"base_side": layout.side, "base_distance_m": round(layout.distance, 3),
                    "support": layout.support.id, "support_height_m": round(layout.frame.top, 3)}
    if room.robot_demo is not None:
        # The scripted controller solving the task in this exact scene shows the task is feasible.
        checks.update(scripted_demo_success=room.robot_demo.success,
                      scripted_demo_steps=f"{room.robot_demo.steps_completed}/{room.robot_demo.total_steps}")
    if validate:
        progress("Validating in MuJoCo and MJX (JAX); the first JIT compile can take a few minutes")
        result = run_bundle_script(bundle, "smoke_test.py", "--impl", "jax", "--json", "checks.json")
        report = bundle / "checks.json"
        if report.is_file():
            checks.update({k: v for k, v in json.loads(report.read_text()).items() if isinstance(v, (bool, int, float, str))})
        if result.returncode != 0:
            tail = (result.stderr or result.stdout).strip().splitlines()[-6:]
            raise ValueError("Playground validation failed: " + safe_error(RuntimeError(" | ".join(tail)))[:900])
        demo = folder / "robot-demo.npz"
        if demo.is_file():
            progress("Replaying the scripted demo through the MJX gym")
            shutil.copy2(demo, bundle / "demo_ctrl.npz")
            replay = run_bundle_script(bundle, "replay_demo.py", "--impl", "jax", "--json", "replay.json")
            report_path = bundle / "replay.json"
            if report_path.is_file():
                checks.update({k: v for k, v in json.loads(report_path.read_text()).items() if isinstance(v, (bool, int, float))})
            checks["replay_passed"] = replay.returncode == 0
        progress("Rendering the Playground preview")
        render = run_bundle_script(bundle, "preview.py", "--output", "preview.png", timeout=300)
        checks["preview"] = render.returncode == 0 and (bundle / "preview.png").is_file()
        if checks["preview"]:
            shutil.copy2(bundle / "preview.png", folder / "preview.png")
    scan = store.read_json(world_id, path, "scan.json") or {}
    write_manifest(bundle, {
        "format": "world-model-hack/playground-bundle/2", "env_name": info["env_name"],
        "created_at": datetime.now(timezone.utc).isoformat(),
        "playground": {"version": PLAYGROUND_VERSION, "base_env": "PandaPickCube", "default_impl": "jax",
                       "menagerie_commit": MENAGERIE_COMMIT},
        "robot": {"name": "franka_emika_panda", "source": "mujoco_menagerie mjx_panda.xml",
                  "base_in_room_frame": [round(float(v), 4) for v in layout.frame.base], "base_yaw_rad": round(layout.frame.yaw, 4),
                  "base_height_m": round(layout.frame.top, 4), "side_of_support": layout.side},
        "task": {"title": room.task.title, "goal": room.task.goal, "robot_task": info["robot_task"], "contract_version": 2,
                 "reward": "ordered stage bonuses + completion bonus + phase shaping and action cost",
                 "termination": "ordered success, invalid state, out of bounds, or 30 second wrapper limit",
                 "object": layout.target.id, "object_size_m": layout.size, "support": layout.support.id,
                 "spawn_low": layout.spawn[0], "spawn_high": layout.spawn[1],
                 "target_low": layout.goal[0], "target_high": layout.goal[1]},
        "provenance": {"world_id": world_id, "room": path, "room_title": room.title, "source_video": world.source.file,
                       "source_sha256": world.source.sha256, "beginning_image_seconds": world.source.t,
                       "reactor_model": scan.get("model"), "reactor_session_id": scan.get("session_id"),
                       "reactor_seed": scan.get("seed"), "reactor_prompt": scan.get("prompt"), "scan_sha256": scan.get("sha256"),
                       "scene_revision": scene["revision"], "reconstruction_attempts": len(scene.get("attempts", []))},
        "checks": checks, "notes": layout.notes, "attribution": ATTRIBUTION, "source_url": SOURCE_URL,
        "limitations": [
            "Room geometry is a primitive approximation reconstructed by Gemini from a Reactor-generated (not captured) walkthrough; scale is estimated.",
            "Furniture is static and non-task objects are welded; doors and drawers stay closed.",
            "Following Playground's Panda models, only the hand capsule and finger pads collide; arm links pass through scenery.",
            "Robot appearance in generated footage is not evidence of physical task success; evaluate policies in the simulator.",
        ]})
    archive = shutil.make_archive(str(staging / name), "zip", staging, name)
    Path(archive).replace(folder / "export.zip")
    progress("Playground bundle ready")
    return ExportSummary(feasible=True, env_name=info["env_name"], checks=checks)
