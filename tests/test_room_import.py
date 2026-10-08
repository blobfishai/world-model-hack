import json
import shutil
import subprocess

import pytest
from PIL import Image

from reactor_world.room_import import import_robot_room
from reactor_world.store import WorldStore
from task_rooms.media import file_digest


@pytest.fixture
def reviewed_assets(tmp_path):
    assets = tmp_path / "assets"
    assets.mkdir()
    clip = assets / "clip.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24", "-t", "1",
                    "-pix_fmt", "yuv420p", str(clip)], check=True)
    for theme in ("greenhouse", "kitchen", "warehouse"):
        shutil.copy2(clip, assets / f"{theme}.mp4")
        Image.new("RGB", (320, 180), (40, 120, 80)).save(assets / f"{theme}.jpg")
        (assets / f"{theme}.json").write_text(json.dumps({
            "status": "ready", "video_sha256": file_digest(clip),
            "walk_generation": {"model": "reactor/lingbot-world-2", "session_id": "reviewed-fixture",
                                "width": 1664, "height": 960, "fps": 48},
        }))
    return assets


@pytest.mark.parametrize("path,kind,theme", [("root", "reach", "greenhouse"), ("0", "push", "kitchen"), ("1", "lift", "warehouse")])
def test_import_reuses_reviewed_clip_preserves_task_and_actual_media_size(tmp_path, reviewed_assets, path, kind, theme):
    store = WorldStore(tmp_path / "worlds")
    world = import_robot_room(store, path, reviewed_assets)
    assert set(world.rooms) == {"root"}
    root = world.rooms["root"]
    assert root.task.robot_task.kind == kind
    assert root.jobs.scan.status == "ready" and root.jobs.physics.status == "idle"
    assert world.planner["room_path"] == path
    assert world.source.id == f"gym-{theme}"
    folder = store.room_folder(world.id, "root")
    assert (folder / "scan.mp4").read_bytes() == (reviewed_assets / f"{theme}.mp4").read_bytes()
    scan = json.loads((folder / "scan.json").read_text())
    assert scan["video"]["width"] == 320 and scan["video"]["fps"] == 24
    assert scan["session_id"] == "reviewed-fixture"
    assert import_robot_room(store, path, reviewed_assets).id == world.id


def test_import_rejects_unreviewed_or_modified_footage(tmp_path, reviewed_assets):
    store = WorldStore(tmp_path / "worlds")
    (reviewed_assets / "warehouse.mp4").write_bytes(b"replaced footage")
    with pytest.raises(ValueError, match="does not match"):
        import_robot_room(store, "1", reviewed_assets)
    receipt = reviewed_assets / "kitchen.json"
    data = json.loads(receipt.read_text())
    data["status"] = "pending"
    receipt.write_text(json.dumps(data))
    with pytest.raises(ValueError, match="not been reviewed"):
        import_robot_room(store, "0", reviewed_assets)
