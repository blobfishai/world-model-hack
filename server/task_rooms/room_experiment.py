"""Run one durable, video-conditioned Reactor experiment for the room explorer."""
from __future__ import annotations

import asyncio
import json
import os
import re
import signal
import sys
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from .config import PROJECT_ROOT, configure, runtime_root, safe_error
from .media import prepare_clip
from .probe import review_video
from .reactor_video import generate_video

SOURCES = {
    "kitchen": ("000/3_video.mp4", 8),
    "laundry": ("000/1_video.mp4", 0),
    "bedroom": ("000/120_video.mp4", 0),
    "studio": ("000/592_video.mp4", 0),
}


async def run(identifier: str) -> int:
    configure()
    if not re.fullmatch(r"[a-f0-9]{24}", identifier):
        raise ValueError("Invalid experiment ID")
    folder = runtime_root() / "experiments" / identifier
    job_path = folder / "job.json"
    job = json.loads(job_path.read_text())

    def update(**changes):
        job.update(changes, updated_at=datetime.now(timezone.utc).isoformat())
        temporary = folder / f"{uuid4().hex}.tmp"
        temporary.write_text(json.dumps(job, indent=2))
        temporary.replace(job_path)

    def progress(message: str):
        update(status="generating", message=message)

    loop = asyncio.get_running_loop()
    task = asyncio.current_task()
    loop.add_signal_handler(signal.SIGTERM, task.cancel)
    try:
        recording, start = SOURCES[job["environment"]]
        update(status="preparing", message="Preparing ten seconds of the original environment video.")
        source = folder / "source.mp4"
        receipt = await asyncio.to_thread(prepare_clip, PROJECT_ROOT / "data" / recording, source, start, 10)
        update(source=receipt)
        output = folder / f"generated-{int(job['attempt'])}.mp4"
        generated = await generate_video(source, output, job["prompt"], seed=int(job["seed"]), progress=progress)
        update(status="reviewing", message="Video received. Checking whether the requested task is visible.", generation=asdict(generated))
        if os.environ.get("GOOGLE_API_KEY"):
            try:
                review = await asyncio.to_thread(review_video, source, output, job["task"])
                assessment = {**review.model_dump(), "verdict": "matched" if review.passes() else "mismatch"}
            except Exception as error:
                assessment = {"verdict": "unreviewed", "observed_actions": "The video review could not complete.",
                              "failure_reasons": [safe_error(error)]}
        else:
            assessment = {"verdict": "unreviewed", "observed_actions": "Video generated; task execution has not been reviewed.",
                          "failure_reasons": ["GOOGLE_API_KEY is not configured for the video reviewer."]}
        update(status="ready", message="Experiment saved. Re-enter this room to replay it.", review=assessment)
        return 0
    except asyncio.CancelledError:
        update(status="failed", message="The experiment was interrupted. You can run it again.")
        return 1
    except Exception as error:
        update(status="failed", message="This experiment could not finish.", error=safe_error(error))
        return 1
    finally:
        loop.remove_signal_handler(signal.SIGTERM)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python -m task_rooms.room_experiment EXPERIMENT_ID")
    raise SystemExit(asyncio.run(run(sys.argv[1])))
