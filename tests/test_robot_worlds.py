import io
import json
import zipfile

import numpy as np
import pytest
from fastapi.testclient import TestClient

from room_sim.api import create_app
from room_sim.playground import RobotCommand
from room_sim.worlds import WorldCommand, WorldSessions, scenario


@pytest.mark.parametrize("path", ["root", *map(str, range(10)), "1.4.8"])
def test_world_task_is_playable_and_reset_is_repeatable(path):
    service = WorldSessions()
    try:
        session = service.create(path)
        identifier = session["id"]
        first = session["state"]
        sequence = 1
        service.command(identifier, WorldCommand(sequence=sequence, command=RobotCommand(type="run", controller="scripted")))
        for _ in range(200):
            sequence += 1
            result = service.command(identifier, WorldCommand(sequence=sequence, command=RobotCommand(type="advance")))
            if result["state"]["robot"]["done"]:
                break
        robot = result["state"]["robot"]
        assert robot["is_success"], (path, robot)
        if robot["task"]["kind"] == "lift":
            assert robot["grasped"]
        assert robot["distance"] < robot["task"]["tolerance"]
        assert not np.allclose(first["bodies"], result["state"]["bodies"])
        reset = service.command(identifier, WorldCommand(sequence=sequence + 1, command=RobotCommand(type="reset")))
        np.testing.assert_array_equal(first["bodies"], reset["state"]["bodies"])
        assert not reset["state"]["robot"]["done"]
    finally:
        service.close()
    assert not service.sessions


def test_ten_siblings_have_distinct_themes_and_deeper_tasks():
    themes = {scenario(str(i))[1]["id"] for i in range(10)}
    assert len(themes) == 10
    assert len({scenario(f"3.{i}")[1]["id"] for i in range(10)}) == 10
    for parent in ["root", "3", "1.4"]:
        children = [str(i) if parent == "root" else f"{parent}.{i}" for i in range(10)]
        assert scenario(parent)[1]["id"] not in {scenario(child)[1]["id"] for child in children}
    with pytest.raises(ValueError):
        scenario("../../.env")


def test_world_api_rejects_repeated_commands_invalid_actions_and_exports_exact_task(tmp_path):
    with TestClient(create_app(tmp_path)) as client:
        assert client.post("/robot-worlds/sessions", json={"path": "../../.env"}).status_code == 422
        session = client.post("/robot-worlds/sessions", json={"path": "1"}).json()
        url = f"/robot-worlds/sessions/{session['id']}"
        invalid = {"sequence": 1, "command": {"type": "action", "action": [0, 0, 0, 2]}}
        assert client.post(url, json=invalid).status_code == 422
        command = {"sequence": 1, "command": {"type": "action", "action": [.5, 0, 0, 1]}}
        result = client.post(url, json=command)
        assert result.status_code == 200
        assert result.json()["state"]["robot"]["steps"] == 1
        assert client.post(url, json=command).status_code == 409
        exported = client.post(f"{url}/gym")
        assert exported.status_code == 200
        with zipfile.ZipFile(io.BytesIO(exported.content)) as archive:
            scene = json.loads(archive.read("gym/scene.json"))
            manifest = json.loads(archive.read("gym/manifest.json"))
            assert scene["revision"] == session["revision"]
            assert scene["world"]["theme"] == "warehouse"
            assert manifest["default_task"] == "lift:target"
            assert "gym/robot.xml" in archive.namelist()
            assert any(name.endswith("warehouse.png") for name in archive.namelist())
        assert client.delete(url).status_code == 200
        assert client.post(url, json={"sequence": 2, "command": {"type": "advance"}}).status_code == 404
