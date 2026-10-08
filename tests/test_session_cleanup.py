import asyncio
from pathlib import Path

import pytest

from task_rooms import reactor_video
from task_rooms.media import VideoInfo


@pytest.mark.parametrize("disconnect_fails", [False, True])
def test_connection_failure_keeps_its_cause_and_closes_native_session(monkeypatch, tmp_path: Path, disconnect_fails):
    calls = []
    messages = []

    class Session:
        def __init__(self, *_args, **_kwargs):
            pass

        def on(self, *_args):
            pass

        async def connect(self):
            raise ValueError("model unavailable")

        async def disconnect(self):
            calls.append("disconnect")
            if disconnect_fails:
                raise TimeoutError("disconnect timed out")

        def close(self):
            calls.append("close")

    monkeypatch.setattr(reactor_video, "Reactor", Session)
    monkeypatch.setattr(reactor_video, "required_key", lambda _name: "test-key")
    monkeypatch.setattr(reactor_video, "inspect_video", lambda _path: VideoInfo(2, 320, 180, 48, 24))
    with pytest.raises(ValueError, match="model unavailable"):
        asyncio.run(reactor_video.generate_video(tmp_path / "source.mp4", tmp_path / "output.mp4",
                                                "Move the plate", progress=messages.append))
    assert calls == ["disconnect", "close"]
    assert ("Reactor session released" in messages) is not disconnect_fails
    if disconnect_fails:
        assert any("Session disconnect failed" in message for message in messages)
