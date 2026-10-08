import asyncio
import json
from pathlib import Path

import pytest

from task_rooms import room_experiment
from task_rooms.probe import VideoReview
from task_rooms.reactor_video import GenerationResult


@pytest.mark.parametrize("review_fails", [False, True])
def test_experiment_keeps_footage_even_when_task_or_reviewer_fails(monkeypatch, tmp_path: Path, review_fails):
    identifier = "a" * 24
    folder = tmp_path / "experiments" / identifier
    folder.mkdir(parents=True)
    job_path = folder / "job.json"
    job_path.write_text(json.dumps({"environment": "kitchen", "prompt": "Place the plate on the counter",
                                    "task": "Place the plate", "seed": 123, "attempt": 1}))
    observed_sources = []

    def prepare(source, destination, start, seconds):
        observed_sources.append((source, start, seconds))
        destination.write_bytes(b"original video")
        return {"source_sha256": "original-source-hash"}

    async def generate(source, output, prompt, *, seed, progress):
        assert source.read_bytes() == b"original video"
        assert prompt == "Place the plate on the counter"
        assert seed == 123
        progress("Generated chunk 0")
        output.write_bytes(b"generated video")
        return GenerationResult("reactor/sana-streaming", "test-session", seed, prompt, str(output),
                                "generated-hash", 240, 10, {"frames": 240}, "video_track")

    def review(*_args):
        if review_fails:
            raise RuntimeError("review temporarily unavailable")
        return VideoReview(requested_action_visible=False, different_action_from_source=False,
                           environment_preserved=True, object_identities_preserved=True,
                           temporal_coherence=True, observed_actions="Original washing action.",
                           failure_reasons=["Placement was not visible."])

    monkeypatch.setattr(room_experiment, "configure", lambda: None)
    monkeypatch.setattr(room_experiment, "runtime_root", lambda: tmp_path)
    monkeypatch.setattr(room_experiment, "prepare_clip", prepare)
    monkeypatch.setattr(room_experiment, "generate_video", generate)
    monkeypatch.setattr(room_experiment, "review_video", review)
    monkeypatch.setenv("GOOGLE_API_KEY", "test-key")
    assert asyncio.run(room_experiment.run(identifier)) == 0
    saved = json.loads(job_path.read_text())
    assert observed_sources == [(room_experiment.PROJECT_ROOT / "data/000/3_video.mp4", 8, 10)]
    assert saved["status"] == "ready"
    assert saved["review"]["verdict"] == ("unreviewed" if review_fails else "mismatch")
    assert (folder / "generated-1.mp4").read_bytes() == b"generated video"
    assert saved["source"]["source_sha256"] == "original-source-hash"
