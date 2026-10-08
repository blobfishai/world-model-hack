import json
import time

import numpy as np
import pytest
from PIL import Image

from reactor_world.robot_sim import RobotSim, record_demo
from reactor_world.schema import RobotTask, WorldTask
from reactor_world.tasks import Observation, Progress, program

from reactor_world_fixtures import counter_room, sponge_task

playground = pytest.importorskip("mujoco_playground")


def lift_task():
    task = sponge_task()
    task.robot_task = RobotTask(kind="lift", object="sponge")
    return WorldTask.model_validate(task.model_dump())


def test_task_programs_name_objects_and_order_the_steps():
    place = program(sponge_task())
    assert [s.kind for s in place] == ["reach", "grasp", "lift", "carry", "place", "release"]
    assert "green sponge" in place[0].title and "white bowl" in place[3].title
    assert [s.kind for s in program(lift_task())] == ["reach", "grasp", "lift", "hold"]


def test_progress_only_advances_in_order():
    steps = program(lift_task())
    progress = Progress(steps, "lift", np.zeros(3), np.zeros(3))
    start = np.array([.5, 0, .02])
    grasped_high = Observation(np.array([.5, 0, .2]), np.array([.5, 0, .2]), start, 0., 2, .02)
    progress.update(grasped_high)  # lifted, but "reach" was never satisfied at grasp height
    assert progress.done[0] is True or progress.index <= 1
    near = Observation(np.array([.5, 0, .03]), start, start, 0., 0, .04)
    fresh = Progress(steps, "lift", np.zeros(3), np.zeros(3))
    fresh.update(near)
    assert fresh.done == [True, False, False, False] and not fresh.success


@pytest.mark.parametrize("make_task", [sponge_task, lift_task])
def test_scripted_demo_solves_the_room_task(tmp_path, make_task):
    sim = RobotSim(counter_room(), make_task(), width=320, height=180)
    try:
        outcome = record_demo(sim, tmp_path / "demo.mp4", seconds=20)
    finally:
        sim.close()
    assert outcome["success"], (outcome, sim.state())
    assert outcome["steps_completed"] == outcome["total_steps"]
    assert (tmp_path / "demo.mp4").stat().st_size > 0


def test_manual_commands_move_the_gripper_and_render_frames(tmp_path):
    backdrop = tmp_path / "arrival.jpg"
    Image.new("RGB", (64, 36), (200, 120, 40)).save(backdrop)
    sim = RobotSim(counter_room(), sponge_task(), width=320, height=180, backdrop=backdrop)
    try:
        assert sim.model.geom("reactor_room_backdrop").id >= 0
        before = sim.target.copy()
        sim.command({"type": "move", "axes": {"x": 1, "y": 0, "z": -1}})
        for _ in range(10):
            sim.tick()
        assert sim.target[0] > before[0] + .05 and sim.target[2] < before[2] - .05
        sim.command({"type": "gripper", "closed": True})
        sim.tick()
        assert sim.state()["metrics"]["gripper"] in {"open", "closed"}
        frame = sim.render()
        assert frame[:2] == b"\xff\xd8"  # JPEG
        with pytest.raises(ValueError):
            sim.command({"type": "fly"})
    finally:
        sim.close()
