"""Start videos from data/ and their beginning images, cropped for LingBot World 2."""
from __future__ import annotations

import importlib.util
import json
import os
import re
import subprocess
from functools import lru_cache
from pathlib import Path

from PIL import Image, ImageFilter, ImageStat

from task_rooms.config import PROJECT_ROOT
from task_rooms.media import inspect_video

ATTRIBUTION = "Eidon AI / Solidic Labs Inc · Egocentric POV · CC-BY-4.0"
SOURCE_URL = "https://huggingface.co/buckets/eidon-ai/egocentric-pov"
# LingBot World 2 streams 1664×960; seed images use the same 26:15 frame.
WIDTH, HEIGHT = 1664, 960
DARK_LUMA = .08


def data_root() -> Path:
    return Path(os.environ.get("REACTOR_WORLD_DATA", PROJECT_ROOT / "data")).resolve()


@lru_cache(maxsize=1)
def _metadata(root: str, stamp: float) -> dict[int, dict]:
    if importlib.util.find_spec("pyarrow") is None:
        return {}
    import pyarrow.parquet as pq
    return {int(row["recording_id"]): row for row in pq.read_table(Path(root) / "metadata.parquet").to_pylist()}


@lru_cache(maxsize=64)
def _probe(path: str, size: int, mtime: int) -> dict:
    info = inspect_video(Path(path))
    return {"duration": round(info.duration_seconds, 3), "width": info.width, "height": info.height,
            "fps": round(info.fps, 3)}


def list_sources(root: Path | None = None) -> list[dict]:
    root = root or data_root()
    manifest = root / "download_manifest.json"
    if manifest.is_file():
        paths = [root / entry["local_path"] for entry in json.loads(manifest.read_text())["files"]]
    else:
        paths = sorted(root.glob("[0-9][0-9][0-9]/*_video.mp4"))
    parquet = root / "metadata.parquet"
    metadata = _metadata(str(root), parquet.stat().st_mtime) if parquet.is_file() else {}
    sources = []
    for path in paths:
        match = re.fullmatch(r"([0-9]{1,6})_video\.mp4", path.name)
        if not match or not path.is_file():
            continue
        identifier = match.group(1)
        stat = path.stat()
        row = metadata.get(int(identifier), {})
        task_type = row.get("task_type")
        label = f"Recording {identifier}" + (f" · {task_type.replace('_', ' ')}" if task_type else "")
        sources.append({"id": identifier, "file": path.relative_to(root.parent).as_posix() if root.parent in path.parents else str(path),
                        "label": label, "task_type": task_type, "qc_status": row.get("qc_status"),
                        **_probe(str(path), stat.st_size, stat.st_mtime_ns),
                        "poster_url": f"/api/worlds/sources/{identifier}/frame?t=1&w=480"})
    return sorted(sources, key=lambda source: int(source["id"]))


def resolve_source(identifier: str, root: Path | None = None) -> tuple[Path, dict]:
    if not re.fullmatch(r"[0-9]{1,6}", identifier):
        raise KeyError("Unknown start video")
    root = root or data_root()
    for source in list_sources(root):
        if source["id"] == identifier:
            path = Path(source["file"])
            return (path if path.is_absolute() else root.parent / path), source
    raise KeyError("Unknown start video")


def signature(path: Path) -> str:
    stat = path.stat()
    return f"{path.name}:{stat.st_size}:{stat.st_mtime_ns}"


def extract_frame(path: Path, t: float, destination: Path, width: int | None = None) -> Path:
    """One frame at `t`, center-cropped to 26:15 and resized (Lanczos) for the world model."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    crop = "crop='min(iw,ih*26/15)':'min(ih,iw*15/26)'"
    scale = f"scale={WIDTH}:{HEIGHT}:flags=lanczos" if width is None else f"scale={int(width)}:-2:flags=lanczos"
    temporary = destination.with_suffix(".tmp.jpg")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{max(0., t):.3f}", "-i", str(path), "-frames:v", "1",
                    "-an", "-vf", f"{crop},{scale}", "-q:v", "2", str(temporary)],
                   check=True, capture_output=True, timeout=60)
    if not temporary.is_file() or temporary.stat().st_size == 0:
        raise ValueError(f"No frame could be decoded at {t:.2f}s")
    temporary.replace(destination)
    return destination


def luma(path: Path) -> float:
    with Image.open(path) as image:
        return ImageStat.Stat(image.convert("L")).mean[0] / 255


def sharpness(path: Path) -> float:
    """Edge variance of a downscaled frame; head-mounted footage often opens with motion blur."""
    with Image.open(path) as image:
        edges = image.convert("L").resize((416, 240)).filter(ImageFilter.FIND_EDGES)
        return ImageStat.Stat(edges).var[0]


def beginning_image(path: Path, t: float, destination: Path, duration: float) -> float:
    """Extract the start frame: the sharpest well-lit frame within 1.5 s of `t` (LingBot inherits its detail).

    The earliest frame wins unless a later one is clearly sharper, so the world still starts at the beginning.
    """
    candidates = []
    for step in range(13):
        moment = round(min(t + step * .25, max(0., duration - .1)), 3)
        frame = destination.with_name(f"{destination.stem}.candidate-{step}.jpg")
        extract_frame(path, moment, frame)
        if luma(frame) >= DARK_LUMA:
            candidates.append((moment, sharpness(frame), frame))
        if candidates and step >= 6:
            break
    if not candidates:
        extract_frame(path, t, destination)
        chosen = round(t, 3)
    else:
        first = candidates[0]
        best = max(candidates, key=lambda candidate: candidate[1])
        moment, _, frame = best if best[1] > first[1] * 1.15 else first
        frame.replace(destination)
        chosen = moment
    for leftover in destination.parent.glob(f"{destination.stem}.candidate-*.jpg"):
        leftover.unlink(missing_ok=True)
    return chosen
