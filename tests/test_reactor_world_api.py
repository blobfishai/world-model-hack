import functools
import io
import json
import subprocess
import time
import zipfile

import pytest
from fastapi.testclient import TestClient

from reactor_world import planner, playground_export
from reactor_world.schema import PhysicsSummary
from room_sim.api import create_app

from reactor_world_fixtures import counter_room, hub_plan


@pytest.fixture
def data_root(tmp_path):
    root = tmp_path / "data"
    (root / "000").mkdir(parents=True)
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24", "-t", "3",
                    "-pix_fmt", "yuv420p", str(root / "000" / "3_video.mp4")], check=True)
    (root / "download_manifest.json").write_text(json.dumps({"files": [{"local_path": "000/3_video.mp4"}]}))
    return root


@pytest.fixture
def service(tmp_path, data_root, monkeypatch):
    monkeypatch.setenv("REACTOR_WORLD_DATA", str(data_root))
    monkeypatch.setenv("REACTOR_WORLD_AUTOSCAN", "0")
    monkeypatch.setenv("GOOGLE_API_KEY", "test-key")
    calls = []
    monkeypatch.setattr(planner, "plan_hub", lambda image, task_type, raw_path: calls.append(image) or hub_plan())
    app = create_app(tmp_path / "rooms")
    with TestClient(app) as client:
        yield client, app, calls


def wait(client, url, done, timeout=20):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        body = client.get(url).json()
        if done(body):
            return body
        time.sleep(.05)
    pytest.fail(f"Timed out waiting on {url}: {body}")


def test_sources_frames_and_world_planning(service):
    client, _, calls = service
    sources = client.get("/worlds/sources").json()
    assert [s["id"] for s in sources["sources"]] == ["3"]
    assert sources["sources"][0]["duration"] == pytest.approx(3, abs=.1)
    frame = client.get("/worlds/sources/3/frame", params={"t": 1, "w": 160})
    assert frame.status_code == 200 and frame.headers["content-type"] == "image/jpeg"
    assert client.get("/worlds/sources/99/frame").status_code == 404
    assert client.post("/worlds", json={"source": "3", "t": 30}).status_code == 422
    created = client.post("/worlds", json={"source": "3", "t": 0})
    assert created.status_code == 202
    world = wait(client, f"/worlds/{created.json()['id']}", lambda w: w["status"] != "planning")
    assert world["status"] == "ready" and len(calls) == 1
    assert sorted(world["rooms"]) == ["0", "1", "2", "3", "4", "5", "root"]
    assert world["start_url"].startswith(f"/api/worlds/{world['id']}/rooms/root/media/start")
    assert world["rooms"]["root"]["media"]["arrival"] and world["rooms"]["0"]["media"]["arrival"] is None
    assert world["source"]["sha256"] and world["rooms"]["0"]["jobs"]["scan"]["status"] == "idle"
    assert client.get(world["start_url"].removeprefix("/api")).headers["content-type"] == "image/jpeg"
    # The same start video and time reuse the existing world.
    assert client.post("/worlds", json={"source": "3", "t": 0}).json()["id"] == world["id"] and len(calls) == 1
    assert client.get("/worlds").json()[0]["id"] == world["id"]


def test_jobs_check_keys_paths_and_order(service, monkeypatch):
    client, _, _ = service
    world = wait(client, f"/worlds/{client.post('/worlds', json={'source': '3'}).json()['id']}", lambda w: w["status"] != "planning")
    base = f"/worlds/{world['id']}/rooms"
    assert client.get("/worlds/0000000000000000").status_code == 404
    assert client.post(f"{base}/9.9/physics").status_code == 404
    assert client.get(f"{base}/0/media/../../world.json").status_code == 404
    assert client.post(f"{base}/0/physics").status_code == 409  # needs a Reactor scan first
    assert client.post(f"{base}/0/playground").status_code == 409  # needs physics first
    assert client.post(f"{base}/0/sessions").status_code == 409
    monkeypatch.delenv("REACTOR_API_KEY", raising=False)
    assert client.post(f"{base}/0/scan").status_code == 503


def test_physics_session_and_playground_export(service, monkeypatch):
    client, app, _ = service
    world = wait(client, f"/worlds/{client.post('/worlds', json={'source': '3'}).json()['id']}", lambda w: w["status"] != "planning")
    store = app.state.reactor_worlds.store
    spec = counter_room(f"w{world['id'][:8]}-0")
    store.write_json(world["id"], "0", "scene.json", {"spec": spec.model_dump(mode="json"), "revision": "r1", "goal": [0, 1, 1]})

    def built(state):
        state.rooms["0"].jobs.physics.status = "ready"
        state.rooms["0"].physics = PhysicsSummary(revision="r1", objects=3, valid=True, goal=[0, 1, 1])
    store.mutate(world["id"], built)
    base = f"/worlds/{world['id']}/rooms/0"
    session = client.post(f"{base}/sessions")
    assert session.status_code == 201 and session.json()["goal"] == [0, 1, 1]
    with client.websocket_connect(f"/sessions/{session.json()['id']}") as ws:
        assert ws.receive_json()["type"] == "state"
    monkeypatch.setattr(playground_export, "export_room", functools.partial(playground_export.export_room, validate=False))
    assert client.post(f"{base}/playground").status_code == 202
    room = wait(client, f"/worlds/{world['id']}", lambda w: w["rooms"]["0"]["jobs"]["export"]["status"] in {"ready", "failed"})["rooms"]["0"]
    assert room["jobs"]["export"]["status"] == "ready", room["jobs"]["export"]
    assert room["export"]["env_name"] == f"PandaPickCubeRoom_{world['id'][:8]}_0" and room["export"]["download_url"]
    archive = zipfile.ZipFile(io.BytesIO(client.get(f"{base}/playground/download").content))
    names = set(archive.namelist())
    bundle = next(iter(names)).split("/")[0]
    for required in ("room_envs/room_pick.py", "room_envs/__init__.py", "train.py", "smoke_test.py", "colab.ipynb", "manifest.json"):
        assert f"{bundle}/{required}" in names
    manifest = json.loads(archive.read(f"{bundle}/manifest.json"))
    assert manifest["playground"]["base_env"] == "PandaPickCube" and manifest["task"]["object"] == "sponge"
    assert all(entry["sha256"] for entry in manifest["files"])
    json.loads(archive.read(f"{bundle}/colab.ipynb"))


@pytest.mark.skipif(__import__("importlib").util.find_spec("mujoco_playground") is None, reason="needs the playground extra")
def test_robot_simulation_socket_and_reactor_demo_job(service, monkeypatch):
    from reactor_world import jobs as world_jobs
    from task_rooms.reactor_video import GenerationResult

    client, app, _ = service
    world = wait(client, f"/worlds/{client.post('/worlds', json={'source': '3'}).json()['id']}", lambda w: w["status"] != "planning")
    store = app.state.reactor_worlds.store
    spec = counter_room(f"w{world['id'][:8]}-0")
    store.write_json(world["id"], "0", "scene.json", {"spec": spec.model_dump(mode="json"), "revision": "r1"})

    def built(state):
        state.rooms["0"].jobs.physics.status = "ready"
        state.rooms["0"].physics = PhysicsSummary(revision="r1", objects=3, valid=True)
    store.mutate(world["id"], built)
    base = f"/worlds/{world['id']}/rooms/0"
    info = client.post(f"{base}/robot")
    assert info.status_code == 201, info.text
    session = info.json()
    assert session["kind"] == "place" and [s["kind"] for s in session["state"]["steps"]][-1] == "release"
    with client.websocket_connect(f"/worlds/robot-sessions/{session['id']}") as ws:
        frame = ws.receive_bytes()
        assert frame[:2] == b"\xff\xd8"
        state = ws.receive_json()
        assert state["type"] == "state" and state["mode"] == "manual"
        ws.send_json({"type": "demo"})
        ws.send_json({"type": "teleport"})
        seen_error = seen_demo = False
        for _ in range(40):
            message = ws.receive()
            if message.get("text"):
                data = json.loads(message["text"])
                seen_error |= data.get("type") == "error"
                seen_demo |= data.get("mode") == "demo"
            if seen_error and seen_demo:
                break
        assert seen_error and seen_demo
    assert session["id"] not in app.state.reactor_worlds.store.root.name  # closed sessions leave no state behind

    async def fake_reactor(source, output, prompt, **kwargs):
        output.write_bytes(source.read_bytes())
        return GenerationResult("reactor/sana-streaming", "session-x", 1, prompt, str(output), "sha", 1, 1., {}, "video_track")
    monkeypatch.setattr(world_jobs, "generate_video", fake_reactor)
    monkeypatch.setenv("REACTOR_API_KEY", "test-key")
    assert client.post(f"{base}/demo").status_code == 202
    room = wait(client, f"/worlds/{world['id']}", lambda w: w["rooms"]["0"]["jobs"]["demo"]["status"] in {"ready", "failed"},
                timeout=120)["rooms"]["0"]
    assert room["jobs"]["demo"]["status"] == "ready", room["jobs"]["demo"]
    assert room["robot_demo"]["success"] and room["robot_demo"]["reactor"]
    assert room["media"]["demo"] and room["media"]["demo_reactor"]
    assert client.get(room["media"]["demo_reactor"].removeprefix("/api")).headers["content-type"] == "video/mp4"
