import math

import mujoco
import numpy as np
import pytest
from fastapi.testclient import TestClient

from room_sim.api import create_app
from room_sim.compiler import validate_physics
from room_sim.world import ROOM_BY_ID, TaskWorldSession, compile_world, drawing_mask
from room_sim.world_schema import WorldCommand


def send(world, **command):
    world.command(WorldCommand.model_validate(command))


def enter(world, family, task=None):
    send(world, type="player", player={"position": ROOM_BY_ID[family].station, "yaw": 0, "pitch": 0})
    send(world, type="station", family=family, active=True)
    if task: send(world, type="select_task", family=family, task=task)


def move_body(world, name, position):
    p = world.physics
    joint = p.model.joint(f"{name}_free")
    adr = int(joint.qposadr[0]); vadr = int(joint.dofadr[0])
    p.data.qpos[adr:adr+3] = position
    p.data.qpos[adr+3:adr+7] = [1, 0, 0, 0]
    p.data.qvel[vadr:vadr+6] = 0
    mujoco.mj_forward(p.model, p.data)


def scrub(world):
    body = world.physics.model.body("dishes_plate").id
    pos = world.physics.data.xpos[body]
    for x in np.linspace(-.16, .16, 9):
        for y in np.linspace(-.16, .16, 9):
            if math.hypot(x, y) < .21:
                send(world, type="stroke", point=(pos + [x, y, .035]).tolist())


def rinse(world):
    send(world, type="tool", tool="hand")
    move_body(world, "dishes_plate", [-7.7, 4.5, 1.08])
    send(world, type="grab", body_id=world.physics.model.body("dishes_plate").id, point=[-7.7, 4.5, 1.11])
    for _ in range(75): world.advance(16)
    send(world, type="release")


def test_world_has_three_connected_rooms_and_stable_physics():
    xml, spec = compile_world()
    assert len(spec.rooms) == 3 and sum(len(r.tasks) for r in spec.rooms) == 9
    assert validate_physics(xml)["valid"]
    world = TaskWorldSession()
    names = [world.physics.model.body(i).name for i in range(world.physics.model.nbody)]
    assert len(names) == len(set(names))
    assert "dishes_plate" in names and "laundry_garment" in names
    for _ in range(120): world.advance()
    assert not world.completed and np.isfinite(world.physics.data.qpos).all()


def test_station_requires_proximity_and_input_is_bounded():
    world = TaskWorldSession()
    with pytest.raises(ValueError, match="closer"): send(world, type="station", family="drawing", active=True)
    with pytest.raises(ValueError): send(world, type="player", player={"position": [99, 0, 0]})
    with pytest.raises(ValueError): send(world, type="stroke", start=[math.nan, 0], end=[1, 1])
    with pytest.raises(ValueError, match="Enter"): send(world, type="stroke", point=[0, 0, 0])


@pytest.mark.parametrize("task", ["scrub", "rinse", "wash-stack"])
def test_dish_tasks_require_real_contact_and_ordered_actions(task):
    world = TaskWorldSession(); enter(world, "dishes", task)
    if task != "rinse":
        with pytest.raises(ValueError, match="touch"): send(world, type="stroke", point=[0, 0, 0])
        assert world.task_progress("dishes") == 0
        scrub(world)
    if task != "scrub": rinse(world)
    if task == "wash-stack":
        assert f"dishes:{task}" not in world.completed
        move_body(world, "dishes_plate", [-5.65, 4.5, .944])
        for _ in range(70): world.advance(16)
    assert f"dishes:{task}" in world.completed


def test_rinsing_before_scrubbing_cannot_complete_combined_task():
    world = TaskWorldSession(); enter(world, "dishes", "wash-stack")
    rinse(world)
    assert world.progress["dishes"]["rinse"] == 0
    move_body(world, "dishes_plate", [-5.65, 4.5, .944])
    for _ in range(80): world.advance()
    assert not world.completed


def test_rinse_reset_leaves_a_flat_plate_clear_of_the_other_props():
    world = TaskWorldSession(); enter(world, "dishes", "rinse")
    for _ in range(60): world.advance()
    body = world.physics.model.body("dishes_plate").id
    np.testing.assert_allclose(world.physics.data.xpos[body], [-6.8, 4.4, .9], atol=.003)
    assert abs(world.physics.data.xquat[body][0]) > .999


@pytest.mark.parametrize("task", ["half", "narrow", "fold-stack"])
def test_laundry_tasks_require_directional_folds_and_released_placement(task):
    world = TaskWorldSession(); enter(world, "laundry", task)
    with pytest.raises(ValueError, match="left"): send(world, type="fold", start=[.5, .5], end=[.5, .5])
    send(world, type="fold", start=[.1, .5], end=[.8, .5])
    if task != "half":
        assert f"laundry:{task}" not in world.completed
        send(world, type="fold", start=[.8, .5], end=[.2, .5])
    if task == "fold-stack":
        assert "laundry:fold-stack" not in world.completed
        move_body(world, "laundry_garment", [1.1, 4.25, .77])
        for _ in range(70): world.advance()
    assert f"laundry:{task}" in world.completed


@pytest.mark.parametrize("task", ["line", "cross", "shade"])
def test_drawing_requires_coverage_of_the_selected_target(task):
    world = TaskWorldSession(); enter(world, "drawing", task)
    send(world, type="stroke", start=[.01, .01], end=[.05, .05])
    assert world.task_progress("drawing") == 0
    for cell in drawing_mask(task):
        uv = [(cell % 32 + .5)/32, (cell // 32 + .5)/32]
        send(world, type="stroke", start=uv, end=uv)
    assert f"drawing:{task}" in world.completed


def test_room_visits_and_resets_keep_other_rooms_progress_and_bodies():
    world = TaskWorldSession(); enter(world, "laundry", "half")
    send(world, type="fold", start=[.1, .5], end=[.8, .5])
    old = world.physics.data.qpos.copy()
    enter(world, "drawing", "cross")
    send(world, type="stroke", start=[.2, .5], end=[.8, .5])
    ink = world.progress["drawing"]["cells"].copy()
    enter(world, "dishes", "scrub"); send(world, type="reset_task")
    assert "laundry:half" in world.completed and world.progress["drawing"]["cells"] == ink
    np.testing.assert_array_equal(world.physics.data.qpos, old)


def test_task_world_api_and_websocket_cleanup(tmp_path):
    app = create_app(tmp_path / "rooms")
    with TestClient(app) as client:
        catalog = client.get("/task-world").json()
        assert len(catalog["spec"]["rooms"]) == 3
        response = client.post("/task-world/sessions")
        assert response.status_code == 201
        session = response.json()
        with client.websocket_connect(f"/task-world/sessions/{session['id']}") as ws:
            assert ws.receive_json()["type"] == "state"
            ws.send_json({"type": "station", "family": "dishes", "active": True})
            for _ in range(20):
                state = ws.receive_json()
                if state.get("station") == "dishes": break
            else: pytest.fail("Station entry was not acknowledged")
            ws.send_json({"type": "station", "family": "drawing", "active": True})
            for _ in range(20):
                state = ws.receive_json()
                if state.get("type") == "error": break
            else: pytest.fail("The server did not reject remote station entry")
        assert session["id"] not in app.state.world_sessions
        assert client.delete(f"/task-world/sessions/{session['id']}").status_code == 200
