import asyncio
from pathlib import Path

import pytest

from reactor_world import lingbot
from task_rooms.media import inspect_video

AXES = {"move_longitudinal": {"forward": "w", "back": "s"}, "move_lateral": {"strafe_left": "a", "strafe_right": "d"},
        "look_horizontal": {"left": "left", "right": "right"}, "look_vertical": {"up": "up", "down": "down"}}


class FakeLingbot:
    """Streams 16×8 frames in 12-frame chunks and reports the composite action like the live model."""
    sessions: list["FakeLingbot"] = []

    def __init__(self, model, key, **options):
        self.model, self.options, self.commands, self.handlers = model, options, [], {}
        self.axes = dict.fromkeys(AXES, "idle")
        self.session_id, self.paused, self.calls = "session-1", False, []
        FakeLingbot.sessions.append(self)

    def on(self, event, handler):
        self.handlers[event] = handler

    async def connect(self):
        self.calls.append("connect")

    async def request_schema(self):
        return {"paths": {f"/events/{name}": {"post": {"operationId": name}} for name in lingbot.REQUIRED}}

    def track(self, name):
        assert name == "main_video"
        return self

    def on_raw_frame(self, handler):
        self.frame = handler

    async def upload_file(self, path):
        assert Path(path).is_file()
        return {"id": "upload-1"}

    async def send_command(self, name, data):
        self.commands.append((name, data))
        axis = name.removeprefix("set_")
        if axis in AXES:
            self.axes[axis] = data[axis]
        if name == "start":
            self.stream = asyncio.get_running_loop().create_task(self.generate())
        if name == "pause":
            self.paused = True

    async def generate(self):
        index = 0
        while not self.paused:
            tokens = [AXES[axis][value] for axis, value in self.axes.items() if value != "idle"]
            for _ in range(24):
                self.frame(bytes(16 * 8 * 4), 16, 8, 0, 0, None)
            self.handlers["message"]({"type": "chunk_complete", "data": {
                "chunk_index": index, "active_action": "+".join(tokens) or "still", "frames_emitted": 24}})
            index += 1
            await asyncio.sleep(.05)

    async def disconnect(self):
        self.calls.append("disconnect")

    def close(self):
        self.calls.append("close")


@pytest.fixture
def fake(monkeypatch):
    FakeLingbot.sessions.clear()
    monkeypatch.setattr(lingbot, "Reactor", FakeLingbot)
    monkeypatch.setattr(lingbot, "required_key", lambda _name: "test-key")
    return FakeLingbot


def test_scan_seeds_the_image_runs_the_script_and_records_native_frames(fake, tmp_path: Path):
    seed = tmp_path / "seed.jpg"
    seed.write_bytes(b"jpeg")
    script = [lingbot.Segment("walk_in", .5, move_longitudinal="forward"), lingbot.Segment("pan_right", .5, look_horizontal="right")]
    result = asyncio.run(lingbot.run_scan(seed, "A sunny pantry", tmp_path / "scan.mp4", script, seed=7, progress=lambda _m: None))
    session = fake.sessions[0]
    names = [name for name, _ in session.commands]
    assert session.model == "reactor/lingbot-world-2"
    assert names[:5] == ["set_image", "set_prompt", "set_seed", "set_rotation_speed_deg", "start"]
    assert ("set_move_longitudinal", {"move_longitudinal": "forward"}) in session.commands
    assert names.index("set_look_horizontal") > names.index("set_move_longitudinal")
    assert names[-1] == "pause" and session.calls == ["connect", "disconnect", "close"]
    walk = next(s for s in result.segments if s["label"] == "walk_in")
    assert walk["move_longitudinal"] == "forward"
    forward = [c for c in result.chunks if "w" in str(c["action"]).split("+")]
    assert forward and result.arrival_frame == sum(c["frames"] for c in result.chunks[: result.chunks.index(forward[-1]) + 1]) - 1
    assert result.walk_in_end_seconds == pytest.approx(result.arrival_frame / 48, abs=1e-3)
    info = inspect_video(tmp_path / "scan.mp4")
    assert info.fps == pytest.approx(48) and info.width == 16 and (info.frames or 0) >= 144
    assert (tmp_path / "scan.events.jsonl").is_file() and (tmp_path / "scan.schema.json").is_file()
    frame = lingbot.extract_frame_at(tmp_path / "scan.mp4", result.arrival_frame, tmp_path / "arrival.jpg")
    assert frame.stat().st_size > 0


def test_a_failed_connection_releases_the_session(fake, monkeypatch, tmp_path: Path):
    async def refuse(self):
        raise ValueError("model unavailable")
    monkeypatch.setattr(FakeLingbot, "connect", refuse)
    with pytest.raises(ValueError, match="model unavailable"):
        asyncio.run(lingbot.run_scan(tmp_path / "seed.jpg", "A room", tmp_path / "scan.mp4", [], seed=1, progress=lambda _m: None))
    assert fake.sessions[0].calls == ["disconnect", "close"]


def test_scripts_look_up_from_egocentric_frames_and_walk_into_rooms():
    assert [s.label for s in lingbot.hub_script("down")] == ["settle", "look_up", "pan_right", "pan_left"]
    assert [s.label for s in lingbot.hub_script("level")] == ["settle", "pan_right", "pan_left"]
    room = lingbot.room_script("down")
    assert [s.label for s in room] == ["look_up", "walk_in", "pan_right", "pan_left"]
    assert room[1].move_longitudinal == "forward"
    assert lingbot.arrival_frame([], [{"label": "pan_right", "start_frame": 0}], 100) is None
