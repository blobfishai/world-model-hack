from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from google import genai
from google.genai import types
from pydantic import BaseModel, Field

from .config import PROJECT_ROOT, configure, required_key, runtime_root, safe_error
from .media import prepare_clip, storyboard
from .reactor_video import generate_video


class VideoReview(BaseModel):
    requested_action_visible: bool
    different_action_from_source: bool
    environment_preserved: bool
    object_identities_preserved: bool
    temporal_coherence: bool
    observed_actions: str
    failure_reasons: list[str] = Field(default_factory=list)

    def passes(self) -> bool:
        return all([self.requested_action_visible, self.different_action_from_source,
                    self.environment_preserved, self.object_identities_preserved, self.temporal_coherence])


CASES = [
    {"id": "different-goal", "relation": "similar", "task":
     "Move the green-and-white plate from the sink to the clear counter on the right and release it flat there. Do not scrub it."},
    {"id": "additional-step", "relation": "subskill", "task":
     "Lift the green-and-white plate, rotate it upright so its face is vertical, then rotate it back and place it flat on the counter."},
    {"id": "harder-task", "relation": "harder", "task":
     "Lift the green-and-white plate with the right hand, transfer it into the left hand, then carefully place it flat on the counter without moving the other dishes."},
]


def task_prompt(task: str) -> str:
    return (
        f"Change the demonstrated hand action to perform this task: {task} "
        "Show the complete action and its final object placement. Preserve the same kitchen, sink, counter, "
        "plate identity, other dishes, lighting, and original egocentric camera viewpoint. "
        "Only the hands and objects participating in the requested action should move differently. "
        "Keep all other furniture and objects in their original locations. Maintain temporal consistency."
    )


def review_video(source: Path, generated: Path, task: str) -> VideoReview:
    client = genai.Client(api_key=required_key("GOOGLE_API_KEY"), http_options=types.HttpOptions(timeout=90000))
    try:
        result = client.models.generate_content(
            model=os.environ.get("GEMINI_MODEL", "gemini-3.8-flash"),
            contents=[
                "First video: the original source recording.",
                types.Part.from_bytes(data=source.read_bytes(), mime_type="video/mp4"),
                "Second video: the candidate synthetic task demonstration.",
                types.Part.from_bytes(data=generated.read_bytes(), mime_type="video/mp4"),
                f"Requested task: {task}\n"
                "Act as a strict video reviewer. Describe only actions visibly executed in the second video. "
                "Check that the requested action and its final goal occur, that the action differs from the "
                "first video, that the same physical scene and object identities persist, and that there "
                "are no object teleports, morphs, scene changes, or impossible hand/object motion. "
                "Recoloring, restyling, camera motion, or repeating the original action is not a new task. "
                "If any requirement is uncertain or obscured, mark that requirement false and explain why.",
            ],
            config=types.GenerateContentConfig(
                response_mime_type="application/json", response_json_schema=VideoReview.model_json_schema(),
                temperature=0,
            ),
        )
        if not result.text:
            raise RuntimeError("The video reviewer returned no assessment")
        return VideoReview.model_validate_json(result.text)
    finally:
        client.close()


async def run(args: argparse.Namespace) -> int:
    configure()
    required_key("REACTOR_API_KEY")
    required_key("GOOGLE_API_KEY")
    directory = runtime_root() / "probes" / (datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid4().hex[:6])
    directory.mkdir(parents=True)
    source = directory / "source.mp4"
    report = {"status": "running", "model": "reactor/sana-streaming", "cases": [],
              "created_at": datetime.now(timezone.utc).isoformat(), "visual_review_required": True}
    report_path = directory / "report.json"

    def save() -> None:
        report_path.write_text(json.dumps(report, indent=2))

    def progress(message: str) -> None:
        print(message, flush=True)

    try:
        progress(f"Probe evidence: {directory}")
        report["source"] = await asyncio.to_thread(prepare_clip, args.source, source, args.start, args.seconds)
        await asyncio.to_thread(storyboard, source, directory / "source-storyboard.jpg")
        save()
        for case in CASES:
            progress(f"Testing {case['id']}: {case['task']}")
            entry = {**case, "status": "running"}
            report["cases"].append(entry)
            save()
            output = directory / f"{case['id']}.mp4"
            generated = await generate_video(source, output, task_prompt(case["task"]), seed=args.seed, progress=progress)
            entry["generation"] = asdict(generated)
            await asyncio.to_thread(storyboard, output, directory / f"{case['id']}-storyboard.jpg")
            review = await asyncio.to_thread(review_video, source, output, case["task"])
            entry["review"] = review.model_dump()
            entry["status"] = "accepted_by_reviewer" if review.passes() else "rejected"
            progress(f"{case['id']}: {entry['status']}; {review.observed_actions}")
            save()
        report["status"] = "needs_visual_review" if all(c["status"] == "accepted_by_reviewer" for c in report["cases"]) else "failed"
        save()
        progress(f"Capability gate: {report['status']}\nReport: {report_path}")
        return 0 if report["status"] == "needs_visual_review" else 2
    except Exception as exc:
        report["status"] = "blocked"
        report["error"] = safe_error(exc)
        save()
        progress(f"Capability gate blocked: {safe_error(exc)}\nReport: {report_path}")
        return 2


def main() -> None:
    parser = argparse.ArgumentParser(description="Test video-conditioned task actions before enabling generated rooms.")
    parser.add_argument("--source", type=Path, default=PROJECT_ROOT / "data/000/3_video.mp4")
    parser.add_argument("--start", type=float, default=8)
    parser.add_argument("--seconds", type=float, default=10)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()
    if args.seed < 0:
        parser.error("--seed must be non-negative")
    sys.exit(asyncio.run(run(args)))


if __name__ == "__main__":
    main()
