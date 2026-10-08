"""An actuated Cartesian robot and tasks grounded in a reconstructed room."""
from __future__ import annotations

import xml.etree.ElementTree as ET

import mujoco
import numpy as np

from .compiler import compile_room, values
from .schema import RoomSpec

ROBOT = "__robot"
FINGER_LIMITS = (.004, .13)


def workspace(spec: RoomSpec) -> tuple[np.ndarray, np.ndarray]:
    w, d, h = spec.dimensions
    return np.array([-w / 2 + .2, -d / 2 + .15, .06]), np.array([w / 2 - .2, d / 2 - .15, h - .2])


def compile_robot(spec: RoomSpec) -> str:
    """Append a 3-axis, parallel-jaw robot. Only actuators move the robot."""
    root = ET.fromstring(compile_room(spec))
    world = root.find("worldbody")
    assert world is not None
    lower, upper = workspace(spec)
    robot = ET.SubElement(world, "body", name=ROBOT, gravcomp="1")
    actuator = ET.SubElement(root, "actuator")
    contact = ET.SubElement(root, "contact")
    for i, axis in enumerate("xyz"):
        name = f"{ROBOT}_{axis}"
        limits = values([lower[i], upper[i]])
        ET.SubElement(robot, "joint", name=name, type="slide", axis=values(np.eye(3)[i]),
                      limited="true", range=limits, damping="10", armature=".05")
        ET.SubElement(actuator, "position", name=name, joint=name, kp="600", kv="50",
                      ctrllimited="true", ctrlrange=limits, forcelimited="true", forcerange="-100 100")
    ET.SubElement(robot, "geom", name=f"{ROBOT}_palm", type="box", pos="0 0 .075",
                  size=".155 .035 .025", mass=".6", rgba=".15 .22 .3 1")
    ET.SubElement(robot, "site", name=f"{ROBOT}_tool", pos="0 0 0", size=".008", rgba=".2 .8 1 1")
    for sign, side in [(-1, "left"), (1, "right")]:
        name = f"{ROBOT}_{side}"
        finger = ET.SubElement(robot, "body", name=name, pos=f"{sign * .012} 0 0", gravcomp="1")
        ET.SubElement(finger, "joint", name=name, type="slide", axis=f"{sign} 0 0",
                      limited="true", range=values(FINGER_LIMITS), damping="2")
        ET.SubElement(finger, "geom", name=f"{name}_pad", type="box", size=".012 .025 .045",
                      mass=".08", friction="1.5 .02 .002", rgba=".3 .7 .8 1")
        ET.SubElement(actuator, "position", name=name, joint=name, kp="300", kv="12",
                      ctrllimited="true", ctrlrange=values(FINGER_LIMITS), forcelimited="true", forcerange="-30 30")
        ET.SubElement(contact, "exclude", body1=ROBOT, body2=name)
    ET.SubElement(contact, "exclude", body1=f"{ROBOT}_left", body2=f"{ROBOT}_right")
    ET.SubElement(world, "site", name="__goal", type="sphere", size=".045", rgba=".3 .9 .5 .35")
    visual = ET.SubElement(root, "visual")
    ET.SubElement(visual, "global", offwidth="640", offheight="480")
    ET.indent(root)
    return ET.tostring(root, encoding="unicode")


def _inside_surface(point, obj, support) -> bool:
    c, s = np.cos(support.yaw), np.sin(support.yaw)
    local = np.array([[c, s], [-s, c]]) @ (point[:2] - support.position[:2])
    # A circumscribed footprint remains conservative for rotated objects.
    radius = np.linalg.norm(obj.size[:2]) / 2
    return bool(np.all(np.abs(local) + radius + .025 <= np.array(support.size[:2]) / 2))


def task_catalog(spec: RoomSpec, model, data) -> list[dict]:
    """Reach/lift targets and supported push goals; no video-to-action labels."""
    tasks = []
    lower, upper = workspace(spec)
    for obj in spec.objects:
        if not obj.movable:
            continue
        body = model.body(obj.id).id
        center = data.xipos[body].copy()
        reach = center + [0, 0, max(.14, obj.size[2] / 2 + .08)]
        if np.any(reach < lower) or np.any(reach > upper):
            continue
        common = {"object_id": obj.id, "tolerance": .045}
        tasks.append({**common, "id": f"reach:{obj.id}", "kind": "reach",
                      "label": f"Reach above {obj.label.lower()}", "goal": reach.tolist()})
        # Lift only objects that fit between the fixed-orientation fingers.
        extent_x = abs(np.cos(obj.yaw)) * obj.size[0] + abs(np.sin(obj.yaw)) * obj.size[1]
        if extent_x < .22 and obj.size[2] >= .1 and center[2] + .15 <= upper[2]:
            tasks.append({**common, "id": f"lift:{obj.id}", "kind": "lift",
                          "label": f"Lift {obj.label.lower()} 15 cm", "goal": (center + [0, 0, .15]).tolist()})
        base_z = data.xpos[body, 2]
        supports = [s for s in spec.objects if not s.movable and s.kind in {"table", "counter", "box"}
                    and abs(s.position[2] + s.size[2] - base_z) < .035]
        for offset in ([.2, 0, 0], [-.2, 0, 0], [0, .2, 0], [0, -.2, 0]):
            goal = center + offset
            if np.any(goal[:2] < lower[:2]) or np.any(goal[:2] > upper[:2]):
                continue
            if base_z > .035 and not any(_inside_surface(center, obj, s) and _inside_surface(goal, obj, s) for s in supports):
                continue
            # Reject paths intersecting another object's conservative XY bounds.
            blocked = False
            for other in spec.objects:
                if other.id == obj.id or other in supports:
                    continue
                if other.position[2] + other.size[2] <= base_z + .015 or other.position[2] >= base_z + obj.size[2]:
                    continue
                radius = (np.linalg.norm(obj.size[:2]) + np.linalg.norm(other.size[:2])) / 2 + .02
                segment = goal[:2] - center[:2]
                t = np.clip(np.dot(np.array(other.position[:2]) - center[:2], segment) / np.dot(segment, segment), 0, 1)
                if np.linalg.norm(center[:2] + t * segment - other.position[:2]) < radius:
                    blocked = True
                    break
            if not blocked:
                tasks.append({**common, "id": f"push:{obj.id}", "kind": "push",
                              "label": f"Move {obj.label.lower()} 20 cm", "goal": goal.tolist()})
                break
    return tasks
