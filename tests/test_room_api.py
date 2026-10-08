import json
import subprocess
import time

import pytest
from fastapi.testclient import TestClient

from room_sim.api import create_app
from room_sim.builds import RoomStore, reconstruction_schema, run_build
from room_sim.schema import Evidence
from room_sim.templates import example_room


@pytest.fixture
def app(tmp_path):
    return create_app(tmp_path / "rooms")


def test_room_catalog_sessions_and_cleanup(app):
    with TestClient(app) as client:
        assert len(client.get("/rooms").json()) == 4
        assert client.get("/rooms/not-a-room").status_code == 404
        result = client.post("/rooms/kitchen/sessions")
        assert result.status_code == 201
        session = result.json()
        with client.websocket_connect(f"/sessions/{session['id']}") as ws:
            assert ws.receive_json()["type"] == "state"
            ws.send_json({"type": "grab", "body_id": 0, "point": [0, 0, 0]})
            for _ in range(20):
                response = ws.receive_json()
                if response["type"] == "error":
                    assert "movable" in response["error"]
                    break
            else:
                pytest.fail("The server did not reject the static grab")
        assert session["id"] not in app.state.sessions


def test_edit_is_persistent_and_invalidates_existing_sessions(app):
    with TestClient(app) as client:
        session = client.post("/rooms/bedroom/sessions").json()
        spec = client.get("/rooms/bedroom").json()["spec"]
        spec["objects"][2]["color"] = "#ffddaa"
        response = client.put("/rooms/bedroom/scene", json=spec)
        assert response.status_code == 200
        assert not app.state.sessions[session["id"]]["physics"].valid
        assert client.get("/rooms/bedroom").json()["spec"]["objects"][2]["color"] == "#ffddaa"
        spec["room_id"] = "bathroom"
        assert client.put("/rooms/bedroom/scene", json=spec).status_code == 422


def test_missing_model_key_and_invalid_layout_have_clear_errors(app, monkeypatch):
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    with TestClient(app) as client:
        assert client.post("/rooms/kitchen/build", files={"video": ("a.mp4", b"invalid")}).status_code == 503
        spec = example_room("kitchen").model_dump()
        spec["objects"][0]["position"] = [100, 0, 0]
        assert client.put("/rooms/kitchen/scene", json=spec).status_code == 422
        assert client.get("/room-builds/../scene.json").status_code == 404


def test_video_build_extracts_evidence_and_saves_provenance(app, tmp_path, monkeypatch):
    source = tmp_path / "input.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=white:s=96x64:r=12:d=2",
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", str(source)], check=True, timeout=20)
    calls = []

    def infer(room, frames, folder, reference, previous, feedback):
        calls.append(frames)
        assert len(frames) == 12
        assert all((folder / f["file"]).is_file() for f in frames)
        spec = example_room(room)
        for o in spec.objects:
            o.evidence = [Evidence(frame=0, observation="Test fixture")]
        return spec

    monkeypatch.setattr("room_sim.builds.infer_scene", infer)
    monkeypatch.setenv("GOOGLE_API_KEY", "fixture-key")
    store = app.state.store
    job = store.new_job("kitchen")
    store.update_job(job, filename="input.mp4")
    destination = store.root / "builds" / job["id"] / "source.mp4"
    destination.write_bytes(source.read_bytes())
    invalidated = []
    run_build(store, job, destination, "", invalidated.append)
    assert job["status"] == "ready"
    assert calls and invalidated == ["kitchen"]
    assert store.get("kitchen")["source_job"] == job["id"]
    provenance = json.loads((destination.parent / "source.json").read_text())
    assert len(provenance["sha256"]) == 64
    with TestClient(app) as client:
        assert client.get(f"/room-builds/{job['id']}/frames/{calls[0][0]['file']}").status_code == 200
        assert client.get(f"/room-builds/{job['id']}/frames/other.jpg").status_code == 404


def test_interrupted_builds_are_marked_for_explicit_retry(tmp_path):
    store = RoomStore(tmp_path)
    job = store.new_job("bathroom")
    restored = RoomStore(tmp_path)
    assert restored.jobs[job["id"]]["status"] == "uploading"
    assert json.loads((tmp_path / "builds" / job["id"] / "job.json").read_text())["status"] == "uploading"
    restored.recover_interrupted()
    assert restored.jobs[job["id"]]["status"] == "failed"


def test_model_schema_inlines_references_and_retains_room_and_asset_types():
    schema = reconstruction_schema()
    assert "$ref" not in json.dumps(schema)
    assert schema["properties"]["room_id"]["enum"] == ["kitchen", "living-room", "bedroom", "bathroom"]
    assert "drawer" in schema["properties"]["objects"]["items"]["properties"]["kind"]["enum"]
