from __future__ import annotations

import math
import xml.etree.ElementTree as ET

import mujoco
import numpy as np

from .schema import RoomSpec


def values(v):
    return " ".join(f"{float(x):.8g}" for x in v)


def compile_room(spec: RoomSpec, *, enclosure: bool = True) -> str:
    root = ET.Element("mujoco", model=spec.room_id)
    ET.SubElement(root, "compiler", angle="radian", inertiafromgeom="auto")
    option = ET.SubElement(root, "option", timestep="0.002", gravity="0 0 -9.81", integrator="implicitfast")
    ET.SubElement(option, "flag", filterparent="disable")
    default = ET.SubElement(root, "default")
    ET.SubElement(default, "geom", friction="0.7 0.01 0.001", condim="4", solref="0.01 1")
    world = ET.SubElement(root, "worldbody")
    ET.SubElement(world, "light", pos="0 0 4", dir="0 0 -1", diffuse="0.8 0.8 0.8")
    count = 0

    def geom(body, pos, size, rgba, kind="box", yaw=0, **extra):
        nonlocal count
        count += 1
        return ET.SubElement(body, "geom", name=f"g{count}", type=kind, pos=values(pos),
                             size=values(size), rgba=rgba, euler=f"0 0 {yaw}", **extra)

    w, d, h = spec.dimensions
    if enclosure:
        geom(world, [0, 0, -.06], [w / 2, d / 2, .06], "0.79 0.75 0.67 1")
        # The editor uses a cutaway; the task world supplies its own connected shell.
        geom(world, [0, d / 2 + .05, h / 2], [w / 2, .05, h / 2], "0.9 0.88 0.82 1")
        geom(world, [-w / 2 - .05, 0, h / 2], [.05, d / 2, h / 2], "0.84 0.85 0.8 1")

    for o in spec.objects:
        body = ET.SubElement(world, "body", name=o.id, pos=values(o.position), euler=f"0 0 {o.yaw}")
        if o.movable:
            ET.SubElement(body, "freejoint", name=f"{o.id}_free")
            x, y, z = o.size
            inertia = [o.mass * (y*y + z*z) / 12, o.mass * (x*x + z*z) / 12, o.mass * (x*x + y*y) / 12]
            ET.SubElement(body, "inertial", mass=str(o.mass), pos=f"0 0 {z / 2}", diaginertia=values(inertia))
        rgba = values([int(o.color[i:i + 2], 16) / 255 for i in (1, 3, 5)] + [1])
        x, y, z = o.size
        density = o.mass / max(x * y * z, 1e-5) if o.movable else 500
        # A default applies to this object's whole composite, including moving parts.
        def g(pos, size, parent=body, kind="box", yaw=0):
            return geom(parent, pos, size, rgba, kind, yaw, density=str(density),
                        friction=f"{o.friction} 0.01 0.001")

        def tray(parent, width, depth, height, base=0):
            t = min(.015, width / 10, depth / 10, height / 4)
            g([0, 0, base + t / 2], [width / 2, depth / 2, t / 2], parent)
            for s in [-1, 1]:
                g([s * (width - t) / 2, 0, base + height / 2], [t / 2, depth / 2, height / 2], parent)
                g([0, s * (depth - t) / 2, base + height / 2], [width / 2 - t, t / 2, height / 2], parent)

        if o.kind == "table":
            t = min(.055, z / 8)
            g([0, 0, z - t / 2], [x / 2, y / 2, t / 2])
            for a in [-1, 1]:
                for b in [-1, 1]:
                    g([a * (x / 2 - .06), b * (y / 2 - .06), (z - t) / 2], [.035, .035, (z - t) / 2])
        elif o.kind in {"cabinet", "drawer", "shelf"}:
            t = min(.035, x / 12, y / 12)
            for a in [-1, 1]:
                g([a * (x - t) / 2, 0, z / 2], [t / 2, y / 2, z / 2])
                g([0, 0, t / 2 if a == -1 else z - t / 2], [x / 2 - t, y / 2, t / 2])
            g([0, (y - t) / 2, z / 2], [x / 2 - t, t / 2, z / 2])
            if o.kind == "shelf":
                for level in [1 / 3, 2 / 3]:
                    g([0, 0, z * level], [x / 2 - t, y / 2 - t, t / 2])
            elif o.kind == "cabinet":
                door = ET.SubElement(body, "body", name=f"{o.id}_door", pos=values([-x / 2, -y / 2 - t, .03]))
                ET.SubElement(door, "joint", name=f"{o.id}_joint", type="hinge", axis="0 0 1",
                              limited="true", range=f"{-o.joint.opening} 0", damping="1", frictionloss="0.2")
                g([x / 2, 0, (z - .05) / 2], [x / 2, t / 2, (z - .05) / 2], door)
                g([x - .07, -.045, z * .55], [.025], door, kind="sphere")
            else:
                drawer = ET.SubElement(body, "body", name=f"{o.id}_drawer", pos=f"0 0 {t * 1.5}")
                ET.SubElement(drawer, "joint", name=f"{o.id}_joint", type="slide", axis="0 -1 0",
                              limited="true", range=f"0 {o.joint.travel}", damping="3", frictionloss="0.3")
                tray(drawer, x - 2.5 * t, y - 2.5 * t, z * .72)
                g([0, -y / 2 - .03, z * .38], [x * .18, .025, .025], drawer)
        elif o.kind in {"cup", "bowl"}:
            radius = min(x, y) / 2
            t = min(.012, radius / 5, z / 5)
            g([0, 0, t / 2], [radius, t / 2], kind="cylinder")
            for i in range(16):
                angle = i * math.tau / 16
                r = radius - t / 2
                g([r * math.cos(angle), r * math.sin(angle), z / 2],
                  [t / 2, radius * math.sin(math.pi / 16) + .001, z / 2], yaw=angle)
        elif o.kind in {"tray", "sink"}:
            tray(body, x, y, z)
        elif o.kind in {"bottle", "cylinder"}:
            g([0, 0, z * .4], [min(x, y) / 2, z * .4], kind="cylinder")
            g([0, 0, z * .9], [min(x, y) * .27, z * .1], kind="cylinder")
        elif o.kind in {"sofa", "bed"}:
            g([0, 0, z * .32], [x / 2, y / 2, z * .32])
            g([0, y * .42, z * .75], [x / 2, y * .08, z * .25])
            if o.kind == "sofa":
                for a in [-1, 1]:
                    g([a * x * .45, 0, z * .6], [x * .05, y / 2, z * .25])
        else:
            g([0, 0, z / 2], [x / 2, y / 2, z / 2])
    ET.indent(root)
    return ET.tostring(root, encoding="unicode")


def validate_physics(xml: str) -> dict:
    model = mujoco.MjModel.from_xml_string(xml)
    data = mujoco.MjData(model)
    errors = []

    def collisions(stage):
        pairs = {}
        for i in range(data.ncon):
            contact = data.contact[i]
            if contact.dist >= -.015:
                continue
            names = tuple(sorted(model.body(int(model.geom_bodyid[g])).name or "room shell"
                                 for g in contact.geom))
            pairs[names] = max(pairs.get(names, 0), -float(contact.dist))
        return [f"{stage} overlap between {a} and {b} ({depth:.3f}m penetration)"
                for (a, b), depth in pairs.items()]

    mujoco.mj_forward(model, data)
    errors.extend(collisions("Initial"))
    mujoco.mj_step(model, data, nstep=500)
    if not np.isfinite(data.qpos).all() or not np.isfinite(data.qvel).all():
        errors.append("Simulation produced a non-finite state")
    if np.max(np.abs(data.qvel), initial=0) > .5:
        errors.append("Objects did not settle; check overlapping objects and support heights")
    errors.extend(collisions("Settled"))
    if any(data.xpos[i, 2] < -.1 for i in range(1, model.nbody)):
        errors.append("An object fell below the floor")
    return {"valid": not errors, "errors": errors[:12], "bodies": model.nbody,
            "geometries": model.ngeom, "joints": model.njnt, "settled_seconds": float(data.time),
            "mujoco_version": mujoco.__version__}


def render_metadata(model) -> list[dict]:
    names = {int(mujoco.mjtGeom.mjGEOM_BOX): "box", int(mujoco.mjtGeom.mjGEOM_SPHERE): "sphere",
             int(mujoco.mjtGeom.mjGEOM_CYLINDER): "cylinder"}
    return [{"id": i, "body_id": int(model.geom_bodyid[i]), "body_name": model.body(int(model.geom_bodyid[i])).name,
             "type": names[int(model.geom_type[i])], "size": model.geom_size[i].tolist(),
             "position": model.geom_pos[i].tolist(), "quaternion": model.geom_quat[i].tolist(),
             "color": model.geom_rgba[i].tolist(),
             "movable": bool(model.body_dofnum[model.geom_bodyid[i]])}
            for i in range(model.ngeom)]
