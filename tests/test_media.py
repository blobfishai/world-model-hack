from pathlib import Path
import math
import subprocess

import pytest

from task_rooms.media import file_digest, inspect_video, prepare_clip, storyboard


@pytest.fixture
def video(tmp_path: Path) -> Path:
    path = tmp_path / "original.mp4"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24",
         "-t", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(path)],
        check=True, capture_output=True, timeout=30,
    )
    return path


def test_source_is_preserved_and_trim_is_a_playable_video(video: Path, tmp_path: Path):
    before = file_digest(video)
    clip = tmp_path / "clip.mp4"
    receipt = prepare_clip(video, clip, start=0.5, seconds=2)
    info = inspect_video(clip)
    assert file_digest(video) == before == receipt["source_sha256"]
    assert receipt["clip_sha256"] == file_digest(clip)
    assert info.frames == 48
    assert (info.width, info.height, info.fps) == (1280, 704, 24)
    assert abs(info.duration_seconds - 2) < 0.05
    storyboard(clip, tmp_path / "storyboard.jpg", count=4)
    assert (tmp_path / "storyboard.jpg").stat().st_size > 1000


@pytest.mark.parametrize("start,seconds", [(2, 2), (-1, 2), (0, 1), (math.nan, 2), (0, math.inf)])
def test_invalid_windows_do_not_create_an_output(video: Path, tmp_path: Path, start, seconds):
    output = tmp_path / "invalid.mp4"
    with pytest.raises(ValueError):
        prepare_clip(video, output, start, seconds)
    assert not output.exists()
