from __future__ import annotations

import asyncio
import json
import sys
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Callable

from reactor_sdk import Reactor

from .capture import VideoCapture
from .config import required_key, safe_error
from .media import file_digest, inspect_video, publish_clip

MODEL_NAME = "reactor/sana-streaming"


@dataclass
class GenerationResult:
    model: str
    session_id: str | None
    seed: int
    prompt: str
    path: str
    sha256: str
    received_frames: int
    elapsed_seconds: float
    video: dict
    source_transport: str


def supported_commands(schema: dict) -> set[str]:
    return {
        endpoint.get("post", {}).get("operationId", path.rsplit("/", 1)[-1])
        for path, endpoint in schema.get("paths", {}).items()
    }


async def generate_video(
    source: Path, output: Path, prompt: str, *, seed: int = 42,
    progress: Callable[[str], None] = print, timeout: float = 150,
) -> GenerationResult:
    """One video-conditioned session, with disconnect cleanup and a bounded server lease."""
    if not prompt.strip():
        raise ValueError("A task instruction is required")
    started = time.monotonic()
    output.parent.mkdir(parents=True, exist_ok=True)
    events_path = output.with_suffix(".events.jsonl")
    loop = asyncio.get_running_loop()
    accepted = asyncio.Event()
    complete = asyncio.Event()
    frame_arrived = asyncio.Event()
    source_finished = asyncio.Event()
    emitted_enough = asyncio.Event()
    stop_playback = asyncio.Event()
    source_info = await asyncio.to_thread(inspect_video, source)
    expected_frames = source_info.frames or round(source_info.duration_seconds * source_info.fps)
    failure: list[str] = []
    counters = {"frames": 0, "emitted": 0}
    reactor = Reactor(MODEL_NAME, required_key("REACTOR_API_KEY"), max_session_duration_seconds=180)
    capture = VideoCapture(output)

    def message(event: dict) -> None:
        name, data = event.get("type"), event.get("data") or {}
        # Messages contain model state, not credentials. Persist only useful evidence.
        if name in {"state", "video_accepted", "prompt_accepted", "chunk_complete",
                    "generation_started", "generation_complete", "command_error"}:
            with events_path.open("a") as log:
                log.write(json.dumps({"elapsed": time.monotonic() - started, "type": name, "data": data}) + "\n")
        if name == "video_accepted" or (name == "state" and data.get("has_video")):
            accepted.set()
        if name == "chunk_complete":
            counters["emitted"] += int(data.get("frames_emitted", 0))
            if counters["emitted"] >= max(33, expected_frames - 24):
                emitted_enough.set()
            progress(f"Generated chunk {data.get('chunk_index', data.get('chunk', '?'))}")
        if name == "generation_complete":
            complete.set()
        if name == "command_error":
            failure.append(f"{data.get('command', 'command')}: {data.get('reason', 'model rejected command')}")
            complete.set()

    def error(value: BaseException) -> None:
        failure.append(safe_error(value))
        complete.set()

    def frame(bgra, width, height, _frame_id, _timestamp_us, _user_data) -> None:
        capture.add(bgra, width, height)
        counters["frames"] += 1
        loop.call_soon_threadsafe(frame_arrived.set)

    reactor.on("message", message)
    reactor.on("error", error)
    session_id = None
    playback = None
    try:
        async with asyncio.timeout(timeout):
            progress("Connecting to Reactor SANA-Streaming")
            await reactor.connect()
            session_id = reactor.session_id
            progress("Connected; saving the runtime model schema")
            schema = await reactor.request_schema()
            output.with_suffix(".schema.json").write_text(json.dumps(schema, indent=2))
            commands = supported_commands(schema)
            reactor.track("main_video").on_raw_frame(frame)
            if "set_video" in commands:
                source_transport = "file"
                if "set_mode" in commands:
                    await reactor.send_command("set_mode", {"mode": "file"})
                reference = await reactor.upload_file(source, mime_type="video/mp4")
                progress("Source video uploaded; waiting for model acceptance")
                await reactor.send_command("set_video", {"video": reference})
                await asyncio.wait_for(accepted.wait(), 30)
            else:
                source_transport = "video_track"
                progress("Runtime accepts a video track; publishing playback of the local source clip")
                camera = await reactor.publish_track("camera")
                await reactor.set_bitrate(max_bps=8_000_000)
                await camera.set_bitrate(max_bps=6_000_000)
                playback = asyncio.create_task(publish_clip(source, camera, source_finished, stop_playback))
            await reactor.send_command("set_seed", {"seed": seed})
            await reactor.send_command("set_prompt", {"prompt": prompt})
            progress("Starting task-action generation")
            await reactor.send_command("start", {})
            if source_transport == "file":
                await complete.wait()
            else:
                ended = asyncio.create_task(source_finished.wait())
                completed = asyncio.create_task(complete.wait())
                try:
                    done, _ = await asyncio.wait({playback, ended, completed}, return_when=asyncio.FIRST_COMPLETED)
                    if playback in done:
                        await playback
                        raise RuntimeError("Source playback stopped before the clip ended")
                    if completed in done and failure:
                        raise RuntimeError("; ".join(failure))
                    await asyncio.wait_for(emitted_enough.wait(), 45)
                    progress("Source footage processed; pausing the live editor")
                    await reactor.send_command("pause", {})
                    stop_playback.set()
                    await playback
                finally:
                    for task in (ended, completed):
                        task.cancel()
                    await asyncio.gather(ended, completed, return_exceptions=True)
            if failure:
                raise RuntimeError("; ".join(failure))
            # The completion event and video packets use different transports. Drain
            # packets until a quiet interval, bounded by the outer session timeout.
            await asyncio.wait_for(frame_arrived.wait(), 15)
            while True:
                frame_arrived.clear()
                try:
                    await asyncio.wait_for(frame_arrived.wait(), 2)
                except TimeoutError:
                    break
            progress("Finalizing the directly captured output video")
            await asyncio.to_thread(capture.finish)
            info = await asyncio.to_thread(inspect_video, output)
            if info.frames is None or info.frames < 33:
                raise ValueError("Reactor output is too short to qualify as a task demonstration")
            return GenerationResult(MODEL_NAME, session_id, seed, prompt, str(output), file_digest(output),
                                    counters["frames"], time.monotonic() - started, asdict(info), source_transport)
    finally:
        primary_error = sys.exception()
        stop_playback.set()
        if playback is not None:
            playback.cancel()
            await asyncio.gather(playback, return_exceptions=True)
        cleanup_error = None
        try:
            await asyncio.wait_for(reactor.disconnect(), 15)
        except Exception as disconnect_error:
            cleanup_error = disconnect_error
            progress(f"Session disconnect failed: {safe_error(disconnect_error)}; server lease is limited to 180 seconds")
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
