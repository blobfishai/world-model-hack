from pathlib import Path

import pytest

from task_rooms.capture import VideoCapture
from task_rooms.media import inspect_video


def test_received_frames_are_saved_as_a_playable_mp4(tmp_path: Path):
    output = tmp_path / "received.mp4"
    capture = VideoCapture(output)
    bgra = bytes([20, 80, 140, 255]) * (320 * 180)
    for _ in range(48):
        capture.add(bgra, 320, 180)
    capture.finish()
    capture.finish()
    info = inspect_video(output)
    assert info.frames == capture.frames == 48
    assert abs(info.duration_seconds - 2) < 0.05


def test_resolution_change_is_reported_as_a_capture_failure(tmp_path: Path):
    capture = VideoCapture(tmp_path / "changed.mp4")
    capture.add(bytes(320 * 180 * 4), 320, 180)
    capture.add(bytes(160 * 90 * 4), 160, 90)
    with pytest.raises(ValueError, match="changed output resolution"):
        capture.finish()
