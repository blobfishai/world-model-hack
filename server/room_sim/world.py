"""One persistent MuJoCo world, with server-owned task state and tool predicates."""
from __future__ import annotations

import math
import xml.etree.ElementTree as ET

import mujoco
import numpy as np

from .compiler import compile_room, values
from .physics import PhysicsSession
from .schema import Interaction, RoomObject, RoomSpec
from .world_schema import PlayerState, TaskDefinition, TaskRoomDefinition, TaskWorldSpec, WorldCommand

GRID = 32


def task(id, title, instruction, tool):
    return TaskDefinition(id=id, title=title, instruction=instruction, tool=tool)


ROOMS = [
    TaskRoomDefinition(id="dishes", title="Dishes", color="#b5c7a3", origin=[-7, 3, 0], station=[-7, 3.4, 0],
        appearance="A warm beige kitchen counter, stainless sink, cream ceramic plates and a green sponge. Soft daylight.",
        tasks=[task("scrub", "Scrub a plate", "Choose the sponge and drag across the plate until its surface is clean.", "sponge"),
               task("rinse", "Rinse a plate", "Use your hand to drag the plate under the blue stream. Hold it there for two seconds.", "hand"),
               task("wash-stack", "Wash and stack", "Scrub the plate, hold it under the tap, then release it on the marked stack to the right.", "sponge")]),
    TaskRoomDefinition(id="laundry", title="Laundry", color="#b6c7e1", origin=[0, 3, 0], station=[0, 3.2, 0],
        appearance="A bedroom laundry station: blue bed cover with fine yellow lines, mint and green garments, folded clothing.",
        tasks=[task("half", "Fold in half", "Drag the garment's left edge across to its right edge.", "hand"),
               task("narrow", "Make a narrow fold", "Fold the left edge inward, then fold the right edge inward.", "hand"),
               task("fold-stack", "Fold and stack", "Fold both sides inward, then drag the folded garment onto the marked stack.", "hand")]),
    TaskRoomDefinition(id="drawing", title="Drawing", color="#ddbd8f", origin=[7, 3, 0], station=[7, 3.4, 0],
        appearance="An artist's wooden desk, white paper on a dark clipboard, a yellow pencil, a precise graphite cross drawing.",
        tasks=[task("line", "Trace a line", "Drag the pencil along the pale horizontal guide on the paper.", "pencil"),
               task("cross", "Trace a cross", "Trace both arms of the pale cross with the pencil.", "pencil"),
               task("shade", "Shade the cross", "Use overlapping pencil strokes to fill the pale cross.", "pencil")]),
]
ROOM_BY_ID = {r.id: r for r in ROOMS}


def object_(id, kind, position, size, color, movable=False, mass=.2):
    return RoomObject(id=id, label=id.replace("_", " "), kind=kind, position=position, size=size,
                      color=color, movable=movable, mass=mass)


def station_spec(family):
    if family == "dishes":
        objects = [
            object_("counter", "counter", [0, 1.6, 0], [4.6, 1.2, .9], "#c4b39a"),
            object_("sink", "sink", [-.7, 1.6, .901], [1.3, .9, .15], "#a9b9b4"),
            object_("plate", "bowl", [-.7, 1.5, .923], [.43, .43, .035], "#f4eedc", True, .35),
            object_("sponge", "box", [.55, 1.5, .906], [.18, .13, .055], "#78a763"),
            object_("stack", "bowl", [1.35, 1.5, .902], [.52, .52, .035], "#f1e8d1"),
        ]
    elif family == "laundry":
        objects = [
            object_("bed", "counter", [0, 1.25, 0], [3.6, 1.9, .66], "#4876b0"),
            object_("garment", "box", [-.55, 1.25, .665], [.9, .65, .04], "#97bba5", True, .25),
            object_("stack", "box", [1.1, 1.25, .661], [.9, .85, .10], "#466a66"),
        ]
    else:
        objects = [
            object_("desk", "table", [0, 1.6, 0], [2.8, 1.5, .9], "#a6845f"),
            object_("clipboard", "box", [-.15, 1.45, .903], [.95, 1.1, .035], "#494f49"),
            object_("pencil", "box", [.6, 1.45, .906], [.04, .42, .04], "#e2b94e"),
            object_("cup", "cup", [.85, 1.95, .906], [.2, .2, .23], "#d8d0b8"),
        ]
    # The established compiler takes local room coordinates; the world composes them below.
    return RoomSpec(room_id="kitchen", name=family, dimensions=[6, 6, 3.3], objects=objects)


def compile_world():
    root = ET.fromstring(compile_room(station_spec("dishes"), enclosure=False))
    root.set("model", "task-world")
    world = root.find("worldbody")
    world.clear()
    colliders = []

    def box(name, position, size, color, collision=True):
        ET.SubElement(world, "geom", name=name, type="box", pos=values(position),
                      size=values([s / 2 for s in size]), rgba=values(color))
        if collision:
            colliders.append({"x": position[0], "y": position[1], "width": size[0], "depth": size[1]})

    box("floor", [0, 1.5, -.08], [20.2, 9.2, .16], [.77, .78, .7, 1], False)
    box("back_wall", [0, 6.1, 1.65], [20.2, .2, 3.3], [.85, .87, .8, 1])
    box("hall_wall", [0, -3.1, 1.65], [20.2, .2, 3.3], [.76, .81, .72, 1])
    for x in [-10.1, 10.1]:
        box(f"outer_{x}", [x, 1.5, 1.65], [.2, 9.2, 3.3], [.8, .83, .75, 1])
    for x in [-3.5, 3.5]:
        box(f"partition_{x}", [x, 3, 1.65], [.2, 6, 3.3], [.82, .85, .78, 1])
    for room in ROOMS:
        cx = room.origin[0]
        # A 1.8 m clear opening joins each room to the same corridor.
        left, right = (cx - 3 if cx != 0 else -3.5), (cx + 3 if cx != 0 else 3.5)
        if cx < 0: right = -3.5
        if cx > 0: left = 3.5
        for suffix, a, b in [("left", left, cx - .9), ("right", cx + .9, right)]:
            box(f"{room.id}_{suffix}_wall", [(a + b) / 2, 0, 1.65], [b - a, .18, 3.3], [.86, .87, .81, 1])
        box(f"{room.id}_lintel", [cx, 0, 2.95], [1.8, .18, .7], [.86, .87, .81, 1], False)
        local = station_spec(room.id)
        fragment = ET.fromstring(compile_room(local, enclosure=False)).find("worldbody")
        for body in fragment.findall("body"):
            pos = [float(v) for v in body.get("pos").split()]
            body.set("pos", values(np.array(pos) + room.origin))
            for element in body.iter():
                if "name" in element.attrib:
                    element.set("name", f"{room.id}_{element.get('name')}")
            world.append(body)
        for obj in local.objects:
            if not obj.movable and obj.position[2] == 0:
                colliders.append({"x": cx + obj.position[0], "y": 3 + obj.position[1],
                                  "width": obj.size[0], "depth": obj.size[1]})
    spec = TaskWorldSpec(rooms=ROOMS, spawn=[-7, 2.6, 0], colliders=colliders)
    return ET.tostring(root, encoding="unicode"), spec


def drawing_mask(task_id):
    result = set()
    for x in range(GRID):
        for y in range(GRID):
            u, v = (x + .5) / GRID, (y + .5) / GRID
            width = .13 if task_id == "shade" else .035
            horizontal = .15 < u < .85 and abs(v - .5) < width
            vertical = .15 < v < .85 and abs(u - .5) < width
            if horizontal or (task_id != "line" and vertical): result.add(y * GRID + x)
    return result


class TaskWorldSession:
    def __init__(self):
        xml, self.spec = compile_world()
        self.physics = PhysicsSession(station_spec("dishes"), xml=xml)
        self.player = PlayerState(position=self.spec.spawn.copy())
        self.station = None
        self.active = {r.id: r.tasks[0].id for r in ROOMS}
        self.completed = set()
        self.tools = {r.id: r.tasks[0].tool for r in ROOMS}
        self.progress = {}
        for room in ROOMS: self._reset_progress(room.id)

    def _reset_progress(self, family):
        self.progress[family] = {"cells": set(), "rinse": 0., "folds": 0, "settled": 0.}

    def reset_station(self, family):
        physics = self.physics
        for joint in range(physics.model.njnt):
            body = int(physics.model.jnt_bodyid[joint])
            if not physics.model.body(body).name.startswith(f"{family}_"): continue
            qadr = int(physics.model.jnt_qposadr[joint]); vadr = int(physics.model.jnt_dofadr[joint])
            physics.data.qpos[qadr:qadr + 7] = physics.initial[qadr:qadr + 7]
            physics.data.qvel[vadr:vadr + 6] = 0
        if family == "dishes" and self.active[family] == "rinse":
            joint = physics.model.joint("dishes_plate_free")
            # Keep the clean plate clear of both the sink rim and the sponge.
            adr = int(joint.qposadr[0]); physics.data.qpos[adr:adr+3] = [-6.8, 4.4, .93]
        physics.grab = None
        mujoco.mj_forward(physics.model, physics.data)
        self._reset_progress(family)

    def command(self, c: WorldCommand):
        if c.type == "player":
            if c.player is None: raise ValueError("Player pose is required")
            x, y, z = c.player.position
            if not (-9.85 <= x <= 9.85 and -2.85 <= y <= 5.85 and abs(z) < .01):
                raise ValueError("Player is outside the walkable floor")
            self.player = c.player
            if self.station and np.linalg.norm(np.array(self.player.position[:2]) - ROOM_BY_ID[self.station].station[:2]) > 2:
                self.station = None; self.physics.grab = None
            return
        if c.type == "release":
            self.physics.command(Interaction(type="release"), record=False)
            return
        if c.type == "station":
            self.physics.grab = None
            if c.active is False:
                self.station = None
                return
            if c.family is None or np.linalg.norm(np.array(self.player.position[:2]) - ROOM_BY_ID[c.family].station[:2]) > 2:
                raise ValueError("Walk closer to the station first")
            self.station = c.family
            return
        family = self.station
        if family is None or (c.family and c.family != family): raise ValueError("Enter this task station first")
        state = self.progress[family]
        if c.type == "select_task":
            definition = next((t for t in ROOM_BY_ID[family].tasks if t.id == c.task), None)
            if not definition: raise ValueError("Unknown task")
            self.active[family] = definition.id; self.tools[family] = definition.tool
            self.reset_station(family)
        elif c.type == "reset_task":
            self.completed.discard(f"{family}:{self.active[family]}")
            self.reset_station(family)
        elif c.type == "tool":
            if c.tool not in ({"sponge", "hand"} if family == "dishes" else {"pencil"} if family == "drawing" else {"hand"}):
                raise ValueError("That tool is not available at this station")
            self.tools[family] = c.tool; self.physics.grab = None
        elif c.type == "grab":
            if self.tools[family] != "hand": raise ValueError("Choose your hand to move an object")
            if c.body_id is None or not 0 < c.body_id < self.physics.model.nbody:
                raise ValueError("Choose a movable task object")
            name = self.physics.model.body(c.body_id).name
            if name not in {f"{family}_plate", f"{family}_garment"}: raise ValueError("Choose an object at this station")
            if family == "laundry" and state["folds"] < self.fold_goal(): raise ValueError("Finish folding before moving the garment")
            self.physics.command(Interaction(type="grab", body_id=c.body_id, point=c.point), record=False)
        elif c.type == "move":
            if c.target is None: raise ValueError("A target is required")
            local = np.array(c.target) - ROOM_BY_ID[family].origin
            if abs(local[0]) > 2.5 or not .25 < local[1] < 2.8 or not .5 < local[2] < 1.8:
                raise ValueError("Keep the object above the work surface")
            self.physics.command(Interaction(type="move", target=c.target), record=False)
        elif c.type == "stroke":
            if family == "dishes":
                if self.tools[family] != "sponge" or c.point is None: raise ValueError("Use the sponge on the plate")
                body = self.physics.model.body("dishes_plate").id
                local = self.physics.data.xmat[body].reshape(3, 3).T @ (np.array(c.point) - self.physics.data.xpos[body])
                if abs(local[2] - .035) > .065 or np.linalg.norm(local[:2]) > .24:
                    raise ValueError("The sponge must touch the plate")
                uv = [float(local[0] / .43 + .5), float(local[1] / .43 + .5)]
                self.paint(state["cells"], uv, uv, .13)
            elif family == "drawing":
                if self.tools[family] != "pencil" or c.start is None or c.end is None:
                    raise ValueError("Use the pencil inside the paper")
                self.paint(state["cells"], c.start, c.end, .045)
            else: raise ValueError("This task uses folding gestures")
        elif c.type == "fold":
            if family != "laundry" or c.start is None or c.end is None: raise ValueError("Drag a garment edge to fold it")
            direction = "left" if state["folds"] == 0 else "right"
            valid = (c.start[0] < .3 and c.end[0] > .65) if direction == "left" else (c.start[0] > .7 and c.end[0] < .35)
            if not valid or abs(c.start[1] - c.end[1]) > .4: raise ValueError(f"Drag the {direction} edge across the garment")
            if state["folds"] < self.fold_goal(): state["folds"] += 1
        self.evaluate()

    @staticmethod
    def paint(cells, start, end, radius):
        distance = math.dist(start, end)
        for t in np.linspace(0, 1, max(2, math.ceil(distance * GRID * 2))):
            u, v = np.array(start) * (1 - t) + np.array(end) * t
            for x in range(max(0, int((u-radius)*GRID)), min(GRID, math.ceil((u+radius)*GRID))):
                for y in range(max(0, int((v-radius)*GRID)), min(GRID, math.ceil((v+radius)*GRID))):
                    if math.hypot((x+.5)/GRID-u, (y+.5)/GRID-v) <= radius: cells.add(y*GRID+x)

    def fold_goal(self):
        return 1 if self.active["laundry"] == "half" else 2

    def scrub_progress(self):
        mask = {y*GRID+x for x in range(GRID) for y in range(GRID)
                if math.hypot((x+.5)/GRID-.5, (y+.5)/GRID-.5) < .45}
        return min(1., len(self.progress["dishes"]["cells"] & mask) / (len(mask) * .8))

    def evaluate(self):
        for family in ROOM_BY_ID:
            if self.task_progress(family) >= .999:
                self.completed.add(f"{family}:{self.active[family]}")

    def task_progress(self, family):
        p = self.progress[family]; active = self.active[family]
        if family == "dishes":
            scrub = self.scrub_progress(); rinse = min(1., p["rinse"] / 2)
            return scrub if active == "scrub" else rinse if active == "rinse" else (scrub + rinse + min(1., p["settled"])) / 3
        if family == "laundry":
            fold = min(1., p["folds"] / self.fold_goal())
            return (fold + min(1., p["settled"])) / 2 if active == "fold-stack" else fold
        mask = drawing_mask(active)
        return min(1., len(p["cells"] & mask) / (len(mask) * .85))

    def advance(self, steps=16):
        self.physics.advance(steps)
        dt = steps * .002
        for family, body_name, destination in [("dishes", "plate", [-5.65, 4.5]), ("laundry", "garment", [1.1, 4.25])]:
            body = self.physics.model.body(f"{family}_{body_name}").id
            pos = self.physics.data.xpos[body]
            p = self.progress[family]
            if family == "dishes" and self.station == family and self.physics.grab and self.physics.grab["body"] == body:
                cleaned = self.active[family] == "rinse" or self.scrub_progress() >= .999
                if cleaned and np.linalg.norm(pos[:2] - [-7.7, 4.5]) < .31 and .93 < pos[2] < 1.5:
                    p["rinse"] = min(2., p["rinse"] + dt)
            ready = p["rinse"] >= 2 and self.scrub_progress() >= .999 if family == "dishes" else p["folds"] >= self.fold_goal()
            released = not self.physics.grab or self.physics.grab["body"] != body
            velocity = np.zeros(6)
            mujoco.mj_objectVelocity(self.physics.model, self.physics.data, mujoco.mjtObj.mjOBJ_BODY, body, velocity, 0)
            # The smaller dish nests on the receiving plate's 7 mm-thick base.
            height = (.902, 1.02) if family == "dishes" else (.74, .84)
            if ready and released and np.linalg.norm(pos[:2] - destination) < .17 and height[0] < pos[2] < height[1] and np.linalg.norm(velocity) < .15:
                p["settled"] = min(1., p["settled"] + dt)
            elif p["settled"] < 1: p["settled"] = 0.
        self.evaluate()

    def state(self):
        p = self.physics
        return {"type": "state", "tick": p.tick, "time": round(p.tick * .002, 2),
                "bodies": np.concatenate([p.data.xpos, p.data.xquat], axis=1).tolist(),
                "station": self.station, "active": self.active.copy(), "tools": self.tools.copy(),
                "completed": sorted(self.completed), "grabbed_body": p.grab["body"] if p.grab else None,
                "progress": {f: self.task_progress(f) for f in ROOM_BY_ID},
                "details": {"scrub": self.scrub_progress(), "rinse": self.progress["dishes"]["rinse"] / 2,
                            "folds": self.progress["laundry"]["folds"], "fold_goal": self.fold_goal(),
                            "ink": sorted(self.progress["drawing"]["cells"]),
                            "clean_cells": sorted(self.progress["dishes"]["cells"])}}
