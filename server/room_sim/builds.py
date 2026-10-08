from __future__ import annotations

import json
import os
import subprocess
import threading
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from google import genai
from google.genai import types

from task_rooms.config import PROJECT_ROOT, required_key, safe_error
from task_rooms.media import file_digest, inspect_video

from .compiler import compile_room, validate_physics
from .schema import RoomSpec
from .templates import ROOMS, example_room


def now():
    return datetime.now(timezone.utc).isoformat()


def atomic_json(path: Path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(f".{uuid4().hex}.tmp")
    temporary.write_text(json.dumps(value, indent=2))
    temporary.replace(path)


class RoomStore:
    def __init__(self, root: Path | None = None):
        self.root = root or Path(os.environ.get("ROOM_SIM_HOME", PROJECT_ROOT / "data/room-sim"))
        self.root.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.jobs = {}
        for path in (self.root / "builds").glob("*/job.json"):
            job = json.loads(path.read_text())
            self.jobs[job["id"]] = job

    def recover_interrupted(self):
        """Only the running service recovers jobs; imports and CLI reads must not write."""
        with self.lock:
            for job in self.jobs.values():
                if job["status"] not in {"ready", "needs_review", "failed"}:
                    self.update_job(job, status="failed", progress=100,
                                    error="Build interrupted by server restart; upload again to retry")

    def get(self, room: str):
        if room not in ROOMS:
            raise KeyError(room)
        path = self.root / "rooms" / room / "scene.json"
        if path.exists():
            data = json.loads(path.read_text())
            RoomSpec.model_validate(data["spec"])
            return data
        spec = example_room(room)
        return {"spec": spec.model_dump(), "revision": "example", "source_job": None,
                "validation": validate_physics(compile_room(spec)), "updated_at": None}

    def save(self, room: str, spec: RoomSpec, validation: dict, source_job=None):
        revision = uuid4().hex
        data = {"spec": spec.model_dump(), "revision": revision, "source_job": source_job,
                "validation": validation, "updated_at": now()}
        folder = self.root / "rooms" / room
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "scene.xml").write_text(compile_room(spec))
        atomic_json(folder / "scene.json", data)
        return data

    def update_job(self, job, **changes):
        with self.lock:
            job.update(changes, updated_at=now())
            atomic_json(self.root / "builds" / job["id"] / "job.json", job)

    def new_job(self, room):
        with self.lock:
            if any(j["room_id"] == room and j["status"] not in {"ready", "needs_review", "failed"}
                   for j in self.jobs.values()):
                raise ValueError("This room already has a reconstruction in progress")
            job = {"id": uuid4().hex, "room_id": room, "status": "uploading", "progress": 0,
                   "error": None, "frames": [], "created_at": now()}
            self.jobs[job["id"]] = job
            self.update_job(job)
            return job


def extract_frames(source: Path, folder: Path) -> list[dict]:
    info = inspect_video(source)
    if not 1 <= info.duration_seconds <= 180 or info.fps <= 0 or max(info.width, info.height) > 8192:
        raise ValueError("Upload a 1–180 second room video, up to 8K resolution")
    folder.mkdir(exist_ok=True)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(source), "-an",
                    "-vf", f"fps={12 / info.duration_seconds},scale=768:-2", "-frames:v", "12",
                    str(folder / "frame-%02d.jpg")], capture_output=True, check=True, timeout=90)
    frames = [{"index": i, "file": p.name, "timestamp": round((i + .5) * info.duration_seconds / 12, 3)}
              for i, p in enumerate(sorted(folder.glob("frame-*.jpg")))]
    if not frames:
        raise ValueError("The video could not be decoded into evidence frames")
    return frames


def reconstruction_schema() -> dict:
    """Use the portable structured-output subset; Pydantic enforces full bounds locally."""
    schema = RoomSpec.model_json_schema()
    definitions = schema.get("$defs", {})

    def expand(node):
        if isinstance(node, list):
            return [expand(value) for value in node]
        if not isinstance(node, dict):
            return node
        if "$ref" in node:
            return expand(definitions[node["$ref"].split("/")[-1]])
        result = {}
        for key in ("type", "description", "properties", "items", "required"):
            if key in node:
                if key == "properties":
                    result[key] = {name: expand(value) for name, value in node[key].items()}
                else:
                    result[key] = expand(node[key])
        if "enum" in node and all(isinstance(value, str) for value in node["enum"]):
            result["enum"] = node["enum"]
        return result

    return expand(schema)


def infer_scene(room: str, frames: list[dict], folder: Path, reference: str,
                previous: dict | None = None, feedback: list[str] | None = None) -> RoomSpec:
    prompt = (
        f"Reconstruct the visible {ROOMS[room][0]} from these timestamped video frames as a functional physical approximation. "
        f"room_id must be {room}. Use only objects observed in these frames, never copy a generic template. "
        "Use meters, Z-up, X left-to-right, Y away from the main viewpoint, origin at the floor center. "
        "Objects use BASE-CENTER positions, full width/depth/height, yaw radians; local front is -Y. "
        "Every color must be a six-digit #RRGGBB hex string (for example #f5f0e4), never a color name. "
        "Object IDs must be unique lowercase slugs starting with a letter, using letters, numbers, hyphens, or underscores. "
        "Table, cabinet, drawer, and shelf dimensions must each be at least 0.2 meters. version must be 1. "
        "Use supported parametric furniture and small rigid objects. Cabinet means a hinged front door; drawer means a sliding tray. "
        "Counter is a SOLID block. Sink is a fixed hollow rectangular basin: its size describes the basin only, "
        "not a floor-to-counter cabinet; its base is normally 0.5–0.7m above the floor. "
        "Use a sink for a visible recessed wash basin and keep any surrounding counter blocks outside its cavity. "
        "Never place an object inside a solid counter. Place supported objects with their base at or just above the support's top. "
        "Set movable=true only for observed small rigid objects; furniture stays fixed. Provide evidence frame indexes for every object. "
        "Do not simulate people, fluids, fabric, appliances' internal functions, or unseen rooms. "
        "Leave clear space in front of doors and drawers. Place objects just above support surfaces, avoiding intersections. "
        "Bound all objects inside the room dimensions. Cup and bowl are hollow circular containers; tray is a hollow rectangle. "
        "Mass/friction are material priors. Record uncertainty in notes. Scale is estimated unless a usable reference is provided. "
        f"Known scale reference from the user: {reference or 'none; estimate scale and say so'}. "
        "Describe visible colors, materials, and lighting in appearance."
    )
    if feedback:
        prompt += f"\nRepair the scene using execution feedback. Previous candidate: {json.dumps(previous)}\nFeedback: {json.dumps(feedback)}"
    contents = [prompt]
    for frame in frames:
        contents.extend([f"Frame {frame['index']} at {frame['timestamp']}s",
                         types.Part.from_bytes(data=(folder / frame["file"]).read_bytes(), mime_type="image/jpeg")])
    client = genai.Client(api_key=required_key("GOOGLE_API_KEY"), http_options=types.HttpOptions(timeout=90000))
    try:
        response = client.models.generate_content(
            model=os.environ.get("GEMINI_MODEL", "gemini-3.8-flash"), contents=contents,
            config=types.GenerateContentConfig(response_mime_type="application/json",
                                               response_json_schema=reconstruction_schema(), temperature=0))
        if not response.text:
            raise ValueError("The reconstruction model returned an empty scene")
        (folder.parent / "model-response.json").write_text(response.text)
        spec = RoomSpec.model_validate_json(response.text)
        if spec.room_id != room:
            raise ValueError("The model returned the wrong room type")
        if not reference.strip():
            spec.scale_status = "estimated"
        valid_frames = {f["index"] for f in frames}
        if any(not o.evidence or any(e.frame not in valid_frames for e in o.evidence) for o in spec.objects):
            raise ValueError("Every reconstructed object must cite an available evidence frame")
        return spec
    finally:
        client.close()


def run_build(store: RoomStore, job: dict, source: Path, reference: str, invalidate):
    folder = source.parent
    try:
        store.update_job(job, status="extracting", progress=10)
        frames = extract_frames(source, folder / "frames")
        provenance = {"filename": job["filename"], "sha256": file_digest(source), "scale_reference": reference,
                      "model": os.environ.get("GEMINI_MODEL", "gemini-3.8-flash"), "frames": frames}
        atomic_json(folder / "source.json", provenance)
        store.update_job(job, status="reconstructing", progress=30, frames=frames)
        previous = None
        feedback = None
        for attempt in range(3):
            try:
                spec = infer_scene(job["room_id"], frames, folder / "frames", reference, previous, feedback)
                previous = spec.model_dump()
                store.update_job(job, status="validating", progress=65 + attempt * 10, candidate=previous)
                validation = validate_physics(compile_room(spec))
            except ValueError as exc:
                validation = {"valid": False, "errors": [safe_error(exc)]}
                raw_path = folder / "model-response.json"
                if raw_path.exists():
                    try:
                        raw = json.loads(raw_path.read_text())
                        if isinstance(raw, dict):
                            previous = raw
                            store.update_job(job, candidate=raw)
                    except json.JSONDecodeError:
                        pass
            atomic_json(folder / f"attempt-{attempt}.json", {"candidate": previous, "validation": validation})
            if validation["valid"]:
                with store.lock:
                    store.save(job["room_id"], spec, validation, job["id"])
                    invalidate(job["room_id"])
                    store.update_job(job, status="ready", progress=100, validation=validation)
                return
            feedback = validation["errors"]
        store.update_job(job, status="needs_review", progress=100, validation=validation,
                         error="Reconstruction needs corrections: " + "; ".join(feedback or []))
    except Exception as exc:
        store.update_job(job, status="failed", error=safe_error(exc), progress=100)
