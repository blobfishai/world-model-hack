"""Record a scripted Reactor LingBot World 2 walk from a seed image, at native 1664×960 @ 48 fps."""
from __future__ import annotations

import asyncio
import json
import subprocess
import sys
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Callable

from reactor_sdk import Reactor

from task_rooms.capture import VideoCapture
from task_rooms.config import required_key, safe_error
from task_rooms.media import file_digest, inspect_video
from task_rooms.reactor_video import supported_commands

MODEL_NAME = "reactor/lingbot-world-2"
FPS = 48
# rotation_speed_deg applies per latent frame. Measured: 0.5 s chunks of ~24 pixel frames carry 3 latent frames.
LATENT_FPS = 6
ROTATION_DEG = 4.  # pans: about 24°/s
TURN_DEG = 10.  # leveling and turning toward a door: about 60°/s
LEVEL_UP = 70.  # head-mounted footage looks steeply down at the work surface
AXES = ("move_longitudinal", "move_lateral", "look_horizontal", "look_vertical")
REQUIRED = {"set_image", "set_prompt", "set_seed", "start", "pause", "set_rotation_speed_deg",
            *(f"set_{axis}" for axis in AXES)}
LOGGED = {"state", "image_accepted", "prompt_accepted", "conditions_ready", "chunk_complete",
          "generation_started", "generation_complete", "generation_paused", "command_error"}


@dataclass
class Segment:
    label: str
    seconds: float
    move_longitudinal: str = "idle"
    move_lateral: str = "idle"
    look_horizontal: str = "idle"
    look_vertical: str = "idle"
    rotation: float = ROTATION_DEG


def rotate(label: str, degrees: float, **axis: str) -> Segment:
    return Segment(label, round(abs(degrees) / (TURN_DEG * LATENT_FPS), 2), rotation=TURN_DEG, **axis)


def level() -> Segment:
    # LingBot moves along the look axis, so walking from a downward view would dive into the surface.
    return rotate("look_up", LEVEL_UP, look_vertical="up")


def hub_script(pitch_hint: str) -> list[Segment]:
    """The hub starts from the real beginning image, then looks around it."""
    script = [Segment("settle", 1.)]
    if pitch_hint == "down":
        script.append(level())
    return script + [Segment("pan_right", 6., look_horizontal="right"), Segment("pan_left", 3., look_horizontal="left")]


def room_script(parent_pitch_hint: str, bearing: float = 0.) -> list[Segment]:
    """A child room starts from the parent's arrival view, turns to its door and walks in under the child's prompt."""
    script = [level()] if parent_pitch_hint == "down" else []
    if abs(bearing) >= 5:
        script.append(rotate("turn", bearing, look_horizontal="right" if bearing > 0 else "left"))
    return script + [Segment("walk_in", 3., move_longitudinal="forward"),
                     Segment("pan_right", 6., look_horizontal="right"), Segment("pan_left", 3., look_horizontal="left")]


@dataclass
class ScanResult:
    model: str
    session_id: str | None
    seed: int
    prompt: str
    path: str
    sha256: str
    received_frames: int
    elapsed_seconds: float
    video: dict
    chunks: list[dict]
    segments: list[dict]
    arrival_frame: int | None
    walk_in_end_seconds: float | None


def arrival_frame(chunks: list[dict], segments: list[dict], recorded: int) -> int | None:
    """Last frame of the forward walk, located with the model's own per-chunk action reports."""
    walk = next((s for s in segments if s["label"] == "walk_in"), None)
    if walk is None:
        return None
    emitted, end = 0, None
    for chunk in chunks:
        emitted += chunk["frames"]
        tokens = str(chunk.get("action") or "").split("+")
        if "w" in tokens and emitted > walk["start_frame"]:
            end = emitted - 1
    if end is None:
        # Older runtimes may not report actions; fall back to when the next segment began.
        following = segments[segments.index(walk) + 1] if segments.index(walk) + 1 < len(segments) else None
        end = (following["start_frame"] if following else recorded) - 1
    return max(0, min(end, recorded - 1))


def extract_frame_at(video: Path, index: int, destination: Path) -> Path:
    temporary = destination.with_suffix(".tmp.jpg")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(video), "-vf", f"select=eq(n\\,{index})",
                    "-frames:v", "1", "-q:v", "2", str(temporary)], check=True, capture_output=True, timeout=90)
    if not temporary.is_file() or temporary.stat().st_size == 0:
        raise ValueError("The arrival frame could not be extracted from the scan")
    temporary.replace(destination)
    return destination


async def run_scan(seed_image: Path, prompt: str, output: Path, script: list[Segment], *, seed: int,
                   progress: Callable[[str], None] = print, timeout: float = 150) -> ScanResult:
    """One LingBot session: seed image + prompt, timed movement script, native-resolution recording."""
    if not prompt.strip():
        raise ValueError("A scene prompt is required")
    started = time.monotonic()
    output.parent.mkdir(parents=True, exist_ok=True)
    events_path = output.with_suffix(".events.jsonl")
    events_path.unlink(missing_ok=True)
    loop = asyncio.get_running_loop()
    frame_arrived = asyncio.Event()
    failure: list[str] = []
    counters = {"frames": 0}
    chunks: list[dict] = []
    segments: list[dict] = []
    reactor = Reactor(MODEL_NAME, required_key("REACTOR_API_KEY"), max_session_duration_seconds=int(timeout) + 30)
    # 1664×960 @ 48 fps is ~300 MB/s of raw frames: encode fast and buffer ~3 s so a busy machine never drops frames.
    capture = VideoCapture(output, fps=FPS, preset="ultrafast", queue_frames=144)

    def message(event: dict) -> None:
        name, data = event.get("type"), event.get("data") or {}
        if name in LOGGED:
            with events_path.open("a") as log:
                log.write(json.dumps({"elapsed": round(time.monotonic() - started, 3), "type": name, "data": data}) + "\n")
        if name == "chunk_complete":
            chunks.append({"index": data.get("chunk_index"), "action": data.get("active_action"),
                           "frames": int(data.get("frames_emitted", 0)), "received": counters["frames"]})
            progress(f"Generated chunk {data.get('chunk_index', '?')} ({data.get('active_action', '?')})")
        if name == "command_error":
            failure.append(f"{data.get('command', 'command')}: {data.get('reason', 'model rejected command')}")

    def error(value: BaseException) -> None:
        failure.append(safe_error(value))

    def frame(bgra, width, height, _frame_id, _timestamp_us, _user_data) -> None:
        capture.add(bgra, width, height)
        counters["frames"] += 1
        loop.call_soon_threadsafe(frame_arrived.set)

    def check() -> None:
        if failure:
            raise RuntimeError("; ".join(failure))
        if capture.error:
            raise capture.error

    reactor.on("message", message)
    reactor.on("error", error)
    session_id = None
    try:
        async with asyncio.timeout(timeout):
            progress("Connecting to Reactor LingBot World 2")
            await reactor.connect()
            session_id = reactor.session_id
            schema = await reactor.request_schema()
            output.with_suffix(".schema.json").write_text(json.dumps(schema, indent=2))
            missing = REQUIRED - supported_commands(schema)
            if missing:
                raise RuntimeError(f"The LingBot runtime lacks commands: {', '.join(sorted(missing))}")
            reactor.track("main_video").on_raw_frame(frame)
            progress("Uploading the seed image")
            reference = await reactor.upload_file(seed_image)
            await reactor.send_command("set_image", {"image": reference})
            await reactor.send_command("set_prompt", {"prompt": prompt})
            await reactor.send_command("set_seed", {"seed": seed})
            await reactor.send_command("set_rotation_speed_deg", {"rotation_speed_deg": ROTATION_DEG})
            await reactor.send_command("start", {})
            progress("Waiting for the first generated frames")
            await asyncio.wait_for(frame_arrived.wait(), 60)
            check()
            state = dict.fromkeys(AXES, "idle")
            rotation = ROTATION_DEG
            for segment in [*script, Segment("end", .8)]:
                if segment.rotation != rotation:
                    await reactor.send_command("set_rotation_speed_deg", {"rotation_speed_deg": segment.rotation})
                    rotation = segment.rotation
                for axis in AXES:
                    value = getattr(segment, axis)
                    if value != state[axis]:
                        await reactor.send_command(f"set_{axis}", {axis: value})
                        state[axis] = value
                segments.append({"label": segment.label, "seconds": segment.seconds, "start_frame": counters["frames"],
                                 "start_seconds": round(time.monotonic() - started, 3), "rotation_speed_deg": rotation, **state})
                progress(f"Camera: {segment.label.replace('_', ' ')}")
                await asyncio.sleep(segment.seconds)
                check()
            await reactor.send_command("pause", {})
            # Frames and messages use different transports; drain packets until a quiet interval.
            while True:
                frame_arrived.clear()
                try:
                    await asyncio.wait_for(frame_arrived.wait(), 2)
                except TimeoutError:
                    break
            progress("Finalizing the native-resolution recording")
            await asyncio.to_thread(capture.finish)
            info = await asyncio.to_thread(inspect_video, output)
            if (info.frames or 0) < FPS * 3:
                raise ValueError("LingBot returned too little video for a room scan")
            arrival = arrival_frame(chunks, segments, info.frames or counters["frames"])
            return ScanResult(MODEL_NAME, session_id, seed, prompt, str(output), file_digest(output),
                              counters["frames"], round(time.monotonic() - started, 3), asdict(info), chunks,
                              segments, arrival, None if arrival is None else round(arrival / FPS, 3))
    finally:
        primary_error = sys.exception()
        cleanup_error = None
        try:
            await asyncio.wait_for(reactor.disconnect(), 15)
        except Exception as disconnect_error:
            cleanup_error = disconnect_error
            progress(f"Session disconnect failed: {safe_error(disconnect_error)}; the server lease bounds the session")
        finally:
            try:
                reactor.close()
            except Exception as close_error:
                cleanup_error = cleanup_error or close_error
                progress(f"Native connection cleanup failed: {safe_error(close_error)}")
            if cleanup_error is None:
                progress("Reactor session released")
            try:
                await asyncio.to_thread(capture.finish)
            except Exception as capture_error:
                progress(f"Capture cleanup: {safe_error(capture_error)}")
        if cleanup_error is not None and primary_error is None:
            raise RuntimeError(f"Reactor session cleanup failed: {safe_error(cleanup_error)}") from cleanup_error
