"""Bounded LingBot World 2 capability gate: one hub scan and one child room scan, reviewed by Gemini.

Paid: two short Reactor sessions (about $0.30) plus Gemini calls. Scans are stored in the world, so the
website reuses them instead of generating again.
"""
from __future__ import annotations

import asyncio
import json
import os
from datetime import datetime, timezone
from typing import Literal

from pydantic import Field

from room_sim.schema import StrictModel
from task_rooms.config import safe_error

from . import gemini
from .jobs import WorldJobs
from .store import WorldStore


class ScanReview(StrictModel):
    follows_motion: bool = Field(description="camera motion matches the commanded script")
    consistent_with_reference: bool = Field(description="the opening frames continue the seed image's scene")
    entered_new_room: bool = Field(description="for a child room: after the walk-in the view shows the room the prompt describes, distinct from the seed image's room; for the hub: true if it stays in the hub")
    task_objects_visible: bool = Field(description="the task objects named in the prompt are visible somewhere in the scan")
    visual_quality: Literal["high", "acceptable", "poor"]
    observations: str = Field(max_length=1200)

    def passes(self) -> bool:
        return self.follows_motion and self.consistent_with_reference and self.entered_new_room and self.visual_quality != "poor"


def review(store: WorldStore, world_id: str, path: str) -> ScanReview:
    world = store.require(world_id)
    room = world.rooms[path]
    folder = store.room_path(world_id, path)
    receipt = json.loads((folder / "scan.json").read_text())
    seed = (store.folder(world_id) / "start.jpg") if room.parent is None else store.room_path(world_id, room.parent) / "arrival.jpg"
    script = ", ".join(f"{s['label']} at {s['start_seconds'] - receipt['segments'][0]['start_seconds']:.1f}s" for s in receipt["segments"])
    text = ("Review this Reactor LingBot World 2 world-model video. The first image is the seed image the session started "
            f"from; the video is the generated stream. Scripted camera: {script}. Scene prompt: {room.prompt}\n"
            f"Room kind: {'hub (starts at the seed image)' if room.parent is None else 'child room entered by walking forward'}. "
            f"Task objects: {', '.join(o.label for o in room.task.objects) or 'none'}. Judge only what is visible.")
    return gemini.generate(ScanReview, [text, gemini.image_part(seed), gemini.video_part(folder / "scan.mp4")],
                           raw_path=folder / "probe-review.json")


async def run(source: str, t: float, child: str) -> dict:
    os.environ["REACTOR_WORLD_AUTOSCAN"] = "0"
    store = WorldStore()
    jobs = WorldJobs(store)
    world = jobs.create_world(source, t)
    await asyncio.gather(*jobs.tasks)
    world = store.require(world.id)
    if world.status != "ready":
        raise RuntimeError(world.error or "World planning failed")
    print(f"World {world.id}: {world.hub_title} — {len(world.rooms) - 1} rooms planned")
    report = {"world": world.id, "source": world.source.model_dump(), "started_at": datetime.now(timezone.utc).isoformat(),
              "model": "reactor/lingbot-world-2", "rooms": {}}
    for path in ("root", child):
        room = store.room(world.id, path)
        if room.jobs.scan.status != "ready":
            print(f"Scanning {path}: {room.title}")
            store.set_job(world.id, path, "scan", status="queued")
            try:
                await jobs._scan(world.id, path)
            except Exception as error:
                report["rooms"][path] = {"title": room.title, "error": safe_error(error)}
                continue
        receipt = json.loads((store.room_path(world.id, path) / "scan.json").read_text())
        result = await asyncio.to_thread(review, store, world.id, path)
        report["rooms"][path] = {"title": room.title, "prompt": room.prompt, "session_id": receipt["session_id"],
                                 "frames": receipt["received_frames"], "video": receipt["video"],
                                 "chunk_actions": sorted({c["action"] for c in receipt["chunks"] if c.get("action")}),
                                 "arrival_frame": receipt["arrival_frame"], "review": result.model_dump(),
                                 "passes": result.passes()}
        print(json.dumps({path: report["rooms"][path]["review"]}, indent=2))
    report["walk_strategy_qualified"] = bool(report["rooms"].get(child, {}).get("passes"))
    report["recommended_arrival_strategy"] = "walk" if report["walk_strategy_qualified"] else "helios"
    report["finished_at"] = datetime.now(timezone.utc).isoformat()
    target = store.folder(world.id) / "probe-report.json"
    target.write_text(json.dumps(report, indent=2) + "\n")
    print(f"Report: {target}")
    return report
