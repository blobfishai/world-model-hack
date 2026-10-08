import importlib.util
import json
import os
import xml.etree.ElementTree as ET

import numpy as np
import pytest

from reactor_world.playground_export import ExportError, SceneWriter, plan_layout
from reactor_world.schema import RobotTask, WorldTask

from reactor_world_fixtures import counter_room, sponge_task


def layout_and_xml(spec=None, task=None):
    spec = spec or counter_room()
    layout = plan_layout(spec, task or sponge_task())
    return spec, layout, SceneWriter(layout, spec).write()


def test_robot_frame_puts_the_base_beside_the_support_and_its_top_at_zero():
    spec, layout, _ = layout_and_xml()
    assert layout.support.id == "counter" and layout.side == "front"
    assert layout.frame.top == pytest.approx(.9)
    assert .35 <= layout.distance <= .8
    start = np.array([(a + b) / 2 for a, b in zip(*layout.spawn)])
    goal = np.array([(a + b) / 2 for a, b in zip(*layout.goal)])
    assert start[0] > .25 and abs(start[1]) < .3 and start[2] == pytest.approx(.02)
    # The goal is a reachable spot on the counter beside the bowl, away from where the sponge starts.
    bowl = np.array(layout.frame.point(next(o for o in spec.objects if o.id == "bowl").position))
    assert np.linalg.norm(goal[:2] - bowl[:2]) < .25 and np.linalg.norm(goal[:2] - start[:2]) >= .1
    for bound in (*layout.spawn, *layout.goal):
        assert max(abs(v) for v in bound) < .95 and bound[2] >= 0


def test_scene_uses_playground_names_and_only_mjx_safe_collisions():
    _, _, xml = layout_and_xml()
    root = ET.fromstring(xml)
    includes = [e.get("file") for e in root.findall("include")]
    assert includes == ["mjx_panda.xml", "sensor.xml"]
    geoms = root.iter("geom")
    names = {g.get("name") for g in root.iter("geom")}
    assert {"floor", "box", "room_floor"} <= names
    assert root.find("worldbody/body[@name='box']/freejoint") is not None
    assert root.find("worldbody/body[@name='mocap_target']").get("mocap") == "true"
    for geom in geoms:
        if geom.get("type") == "cylinder":
            assert geom.get("contype") == "0" and geom.get("conaffinity") == "0"
    floor = next(g for g in root.iter("geom") if g.get("name") == "floor")
    center, half = [float(v) for v in floor.get("pos").split()], [float(v) for v in floor.get("size").split()]
    assert center[2] + half[2] == pytest.approx(0, abs=1e-6)
    qpos = root.find("keyframe/key[@name='home']").get("qpos").split()
    assert len(qpos) == 16
    option = root.find("option")
    assert option.get("iterations") == "5" and option.get("ls_iterations") == "8"


def test_unworkable_layouts_explain_why():
    with pytest.raises(ExportError, match="no clear floor|No clear floor"):
        plan_layout(counter_room(against_walls=True), sponge_task())
    with pytest.raises(ExportError, match="too wide"):
        plan_layout(counter_room(sponge_size=(.2, .2, .04)), sponge_task())
    floating = counter_room()
    floating.objects[2].position[2] = 1.3
    with pytest.raises(ExportError, match="does not rest"):
        plan_layout(floating, sponge_task())
    no_robot = WorldTask(title="Fold", goal="Fold the towel", objects=[], robot_task=None)
    with pytest.raises(ExportError, match="no single-arm"):
        plan_layout(counter_room(), no_robot)


def test_lift_targets_rise_above_the_spawn_region():
    task = sponge_task()
    task.robot_task = RobotTask(kind="lift", object="sponge")
    _, layout, _ = layout_and_xml(task=WorldTask.model_validate(task.model_dump()))
    assert layout.goal[0][2] >= layout.spawn[0][2] + .2 and layout.goal[1][2] <= .8


@pytest.mark.skipif(importlib.util.find_spec("mujoco_playground") is None, reason="needs the playground extra")
def test_scene_compiles_with_the_menagerie_panda_and_mjx_jax():
    import mujoco
    from mujoco import mjx
    from mujoco_playground._src import mjx_env
    from mujoco_playground._src.manipulation.franka_emika_panda import panda

    mjx_env.ensure_menagerie_exists()
    _, layout, xml = layout_and_xml()
    model = mujoco.MjModel.from_xml_string(xml, assets=panda.get_assets())
    assert model.nq == 16 and model.nu == 8
    data = mujoco.MjData(model)
    mujoco.mj_resetDataKeyframe(model, data, model.key("home").id)
    mujoco.mj_forward(model, data)
    robot = {model.geom(n).id for n in ("left_finger_pad", "right_finger_pad", "hand_capsule")}
    assert not [c for c in data.contact[: data.ncon] if (c.geom1 in robot or c.geom2 in robot) and c.dist < 0]
    box = model.body("box").id
    start = data.xpos[box].copy()
    for _ in range(200):
        data.ctrl[:] = model.key_ctrl[0]
        mujoco.mj_step(model, data)
    assert np.linalg.norm(data.xpos[box] - start) < .01
    mjx.put_model(model, impl="jax")


@pytest.mark.skipif(os.environ.get("REACTOR_WORLD_SLOW_TESTS") != "1" or importlib.util.find_spec("mujoco_playground") is None,
                    reason="JIT-compiles MJX on CPU; set REACTOR_WORLD_SLOW_TESTS=1")
def test_exported_environment_runs_jitted_steps(tmp_path):
    from reactor_world.playground_export import build_bundle, run_bundle_script
    spec, layout, _ = layout_and_xml()
    bundle = tmp_path / "bundle"
    build_bundle(spec, sponge_task(), layout, bundle, references=[],
                 world={"id": "0123abcd0123abcd", "source": {"file": "data/000/3_video.mp4", "t": 0}},
                 room={"path": "0", "title": "Sponge"})
    result = run_bundle_script(bundle, "smoke_test.py", "--impl", "jax", "--json", "checks.json")
    assert result.returncode == 0, result.stderr[-2000:]
    assert json.loads((bundle / "checks.json").read_text())["passed"]
