import json
import subprocess
import sys

import mujoco
import numpy as np
import pytest

from room_sim.panda_world import PandaWorldSession, mesh_assets
from room_sim.playground import RobotCommand
from room_sim.worlds import scenario


@pytest.mark.parametrize("path", ["1.2.1.2.3", *[f"2.{i}" for i in range(10)]])
def test_articulated_panda_completes_deeper_room_tasks_through_actuators(path):
    scene, _, kind, seed = scenario(path)
    robot = PandaWorldSession(scene, f"{kind}:target", seed)
    before = robot.data.qpos[robot.arm_q].copy()
    robot.command(RobotCommand(type="run", controller="scripted"))
    for _ in range(200):
        robot.command(RobotCommand(type="advance"))
        if robot.terminated: break
    assert robot.terminated, (path, kind, robot.phase, robot.distance())
    assert not np.allclose(before, robot.data.qpos[robot.arm_q])
    assert robot.model.nu == 8 and len(robot.arm_q) == 7
    assert np.isfinite(robot.data.qpos).all()
    if kind == "lift": assert robot.grasped()
    # Full arm collisions participate, in addition to the physical fingers.
    link_geoms = [i for i in range(robot.model.ngeom) if robot.model.body(robot.model.geom_bodyid[i]).name == "link3"]
    assert any(robot.model.geom_contype[g] for g in link_geoms)


def test_panda_export_is_a_standalone_gym_and_matches_the_visible_robot(tmp_path):
    scene, _, kind, seed = scenario("1")
    robot = PandaWorldSession(scene, f"{kind}:target", seed)
    robot.export(scene, tmp_path)
    model = mujoco.MjModel.from_xml_path(str(tmp_path / "robot.xml"))
    assert model.nu == robot.model.nu and model.nbody == robot.model.nbody
    assert json.loads((tmp_path / "manifest.json").read_text())["robot"] == "Franka Emika Panda"
    result = subprocess.run([sys.executable, "-c", "from env import PandaGym; from gymnasium.utils.env_checker import check_env; e=PandaGym(); check_env(e, skip_render_check=True)"],
                            cwd=tmp_path, capture_output=True, text=True, timeout=45)
    assert result.returncode == 0, result.stderr


def test_compiled_meshes_cover_all_panda_visual_geometries():
    scene, _, kind, seed = scenario("root")
    robot = PandaWorldSession(scene, f"{kind}:target", seed)
    assets = mesh_assets()
    visuals = [g for g in robot.geoms if g["type"] == "mesh"]
    assert len(visuals) > 40
    for geom in visuals:
        asset = assets[str(geom["mesh_id"])]
        assert len(asset["vertices"]) % 3 == 0 and len(asset["indices"]) % 3 == 0
        assert max(asset["indices"]) < len(asset["vertices"]) // 3
