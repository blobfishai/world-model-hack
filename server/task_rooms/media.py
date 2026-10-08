from __future__ import annotations

import asyncio
import hashlib
import io
import json
import math
import subprocess
from dataclasses import asdict, dataclass
from pathlib import Path

from PIL import Image, ImageDraw


async def publish_clip(source: Path, camera, source_finished: asyncio.Event, stop: asyncio.Event) -> int:
    """Play local footage into a video track; hold its final frame while inference drains."""
    info = await asyncio.to_thread(inspect_video, source)
    process = await asyncio.create_subprocess_exec(
        "ffmpeg", "-v", "error", "-i", str(source), "-an", "-pix_fmt", "bgra",
        "-f", "rawvideo", "pipe:1", stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    assert process.stdout is not None
    frame_size = info.width * info.height * 4
    last_frame = None
    frame_count = 0
    tick = 0
    started = asyncio.get_running_loop().time()
    try:
        while not stop.is_set():
            if not source_finished.is_set():
                try:
                    frame = await process.stdout.readexactly(frame_size)
                    frame_count += 1
                    last_frame = frame
                except asyncio.IncompleteReadError as exc:
                    if exc.partial:
                        raise ValueError("Decoder returned a truncated video frame") from exc
                    if not last_frame:
                        raise ValueError("Source video decoder returned no frames")
                    source_finished.set()
                    frame = last_frame
            else:
                frame = last_frame
            camera.push_frame(frame, width=info.width, height=info.height)
            tick += 1
            await asyncio.sleep(max(0, started + tick / info.fps - asyncio.get_running_loop().time()))
        return frame_count
    finally:
        if process.returncode is None:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), 3)
            except TimeoutError:
                process.kill()
                await process.wait()


@dataclass(frozen=True)
class VideoInfo:
    duration_seconds: float
    width: int
    height: int
    frames: int | None
    fps: float


def inspect_video(path: Path) -> VideoInfo:
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
         "format=duration:stream=width,height,nb_frames,avg_frame_rate,duration",
         "-of", "json", str(path)],
        capture_output=True, text=True, check=True, timeout=30,
    )
    data = json.loads(result.stdout)
    if not data.get("streams"):
        raise ValueError("The file has no video stream")
    stream = data["streams"][0]
    numerator, denominator = stream["avg_frame_rate"].split("/")
    fps = float(numerator) / float(denominator) if float(denominator) else 0.0
    frames = stream.get("nb_frames", "N/A")
    duration = stream.get("duration") or data["format"]["duration"]
    return VideoInfo(float(duration), int(stream["width"]), int(stream["height"]),
                     int(frames) if frames != "N/A" else None, fps)


def file_digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def prepare_clip(source: Path, destination: Path, start: float, seconds: float) -> dict:
    """Create a video input without cropping any part of the photographed scene."""
    info = inspect_video(source)
    if not all(math.isfinite(value) for value in (start, seconds)):
        raise ValueError("Clip times must be finite")
    if start < 0 or seconds < 2 or seconds > 30 or start + seconds > info.duration_seconds:
        raise ValueError("Choose a 2–30 second window inside the decoded source duration")
    destination.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-ss", str(start), "-i", str(source),
         "-t", str(seconds), "-vf",
         "scale=1280:704:force_original_aspect_ratio=decrease,pad=1280:704:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24",
         "-an", "-c:v", "libx264", "-preset", "fast", "-crf", "21", "-pix_fmt", "yuv420p",
         "-movflags", "+faststart", str(destination)],
        capture_output=True, check=True, timeout=120,
    )
    output = inspect_video(destination)
    if output.frames is None or output.frames < 33:
        raise ValueError("Reactor video input needs at least 33 decoded frames")
    return {
        "source_path": str(source.resolve()), "source_sha256": file_digest(source),
        "start_seconds": start, "end_seconds": start + seconds,
        "clip_sha256": file_digest(destination), "video": asdict(output),
        "attribution": "Eidon AI / Solidic Labs Inc, Egocentric POV, CC-BY-4.0",
        "source_url": "https://huggingface.co/buckets/eidon-ai/egocentric-pov",
    }


def storyboard(path: Path, destination: Path, count: int = 8) -> None:
    info = inspect_video(path)
    columns = 4
    sheet = Image.new("RGB", (384 * columns, 242 * math.ceil(count / columns)), "#17191c")
    draw = ImageDraw.Draw(sheet)
    for index in range(count):
        timestamp = info.duration_seconds * (index + 0.5) / count
        result = subprocess.run(
            ["ffmpeg", "-v", "error", "-ss", str(timestamp), "-i", str(path),
             "-frames:v", "1", "-vf", "scale=384:216", "-f", "image2pipe",
             "-vcodec", "mjpeg", "pipe:1"], capture_output=True, check=True, timeout=30,
        )
        frame = Image.open(io.BytesIO(result.stdout)).convert("RGB")
        x, y = (index % columns) * 384, (index // columns) * 242
        draw.text((x + 8, y + 6), f"{timestamp:.2f}s", fill="white")
        sheet.paste(frame, (x, y + 24))
    sheet.save(destination, quality=90)
