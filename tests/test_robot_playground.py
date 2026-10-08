import json

import numpy as np
import pytest
from fastapi.testclient import TestClient

from room_sim.api import create_app
from room_sim.gym_bundle import digest
from room_sim.playground import RobotCommand, RobotSession
from room_sim.templates import example_room


@pytest.fixture
def client(tmp_path):
    app = create_app(tmp_path / "rooms")
    app.state.playground.training_root = tmp_path / "training"
    with TestClient(app) as value:
        yield value


def start(client, task=None):
    catalog = client.get("/rooms/kitchen/playground").json()
    response = client.post("/rooms/kitchen/robot-sessions", json={
        "revision": catalog["revision"], "task": task, "seed": 42})
    assert response.status_code == 201, response.text
    session = response.json()
    return f"/rooms/kitchen/robot-sessions/{session['id']}", session


def test_real_controls_pause_reset_and_session_cleanup(client):
    path, initial = start(client)
    assert initial["geoms"] and not initial["policy_available"]
    initial_xyz = np.array(initial["state"]["robot"]["tool_position"])
    for _ in range(6):
        moved = client.post(path, json={"type": "action", "action": [1, 0, 0, -1]}).json()
    assert moved["robot"]["steps"] == 6
    assert moved["robot"]["tool_position"][0] > initial_xyz[0] + .05
    assert not moved["robot"]["gripper_open"]
    client.post(path, json={"type": "pause", "paused": True})
    paused = client.post(path, json={"type": "advance"}).json()
    assert paused["bodies"] == moved["bodies"] and paused["robot"]["steps"] == 6
    reset = client.post(path, json={"type": "reset"}).json()
    assert reset == initial["state"]
    assert client.post(path.replace("kitchen", "bedroom"), json={"type": "advance"}).status_code == 404
    assert client.delete(path).status_code == 200
    assert client.post(path, json={"type": "advance"}).status_code == 404


def test_validation_prevents_wrong_actions_or_stale_scenes(client):
    assert client.post("/rooms/kitchen/robot-sessions", json={"revision": "old"}).status_code == 409
    assert client.get("/rooms/unknown/playground").status_code == 404
    path, _ = start(client)
    for command in ({"type": "action"}, {"type": "action", "action": [2, 0, 0, 1]},
                    {"type": "run"}, {"type": "pause"}, {"type": "reset", "seed": -1}):
        assert client.post(path, json=command).status_code == 422
    assert client.post(path, json={"type": "run", "controller": "policy"}).status_code == 422


@pytest.mark.parametrize("task", ["reach:cup", "lift:cup"])
def test_scripted_controller_completes_with_real_contacts(task):
    session = RobotSession({"spec": example_room("kitchen"), "revision": "example"}, task, 42, None)
    try:
        session.command(RobotCommand(type="run", controller="scripted"))
        for _ in range(200):
            state = session.command(RobotCommand(type="advance"))
            if state["robot"]["done"]:
                break
        assert state["robot"]["is_success"]
        if task.startswith("lift"):
            assert state["robot"]["grasped"]
        assert session.command(RobotCommand(type="advance")) == state
    finally:
        session.close()


def test_saved_policy_is_bound_to_verified_scene_and_task(client):
    service = client.app.state.playground
    folder = service.training_root / "kitchen-ppo"
    folder.mkdir(parents=True)
    scene = client.app.state.store.get("kitchen")
    (folder / "scene.json").write_text(json.dumps(scene))
    (folder / "policy.zip").write_bytes(b"test placeholder: never loaded")
    report = {"scene_sha256": digest(folder / "scene.json"), "task": "reach:cup",
              "algorithm": "PPO", "seed": 42, "evaluation": [], "actual_timesteps": 0, "success_rate": 0}
    (folder / "report.json").write_text(json.dumps(report))
    _, session = start(client)
    assert session["state"]["robot"]["task"]["id"] == "reach:cup"
    _, other = start(client, "lift:cup")
    assert not other["policy_available"]
    assert client.post(f"/rooms/kitchen/robot-sessions/{other['id']}", json={"type": "run", "controller": "policy"}).status_code == 422
    (folder / "scene.json").write_text(json.dumps({**scene, "revision": "changed"}))
    assert client.get("/rooms/kitchen/playground").status_code == 422
