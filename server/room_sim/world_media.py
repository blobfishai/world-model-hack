"""Prepare small, source-grounded demos without modifying any dataset recordings."""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

from task_rooms.config import PROJECT_ROOT, configure, runtime_root
from task_rooms.media import file_digest, inspect_video

RECORDINGS = {"dishes": [3, 5, 6, 7], "laundry": [1, 2], "drawing": [592]}
PRIMARY = {"dishes": (3, 8.), "laundry": (1, 0.), "drawing": (592, 0.)}
ATTRIBUTION = "Eidon AI / Solidic Labs Inc · Egocentric POV · CC-BY-4.0"


def media_status():
    folder = runtime_root() / "world" / "media"
    return {family: {"recording": recording, "recordings": RECORDINGS[family],
                     "available": (PROJECT_ROOT / f"data/000/{recording}_video.mp4").is_file(),
                     "prepared": (folder / f"{family}.mp4").is_file(),
                     "start": 0 if (folder / f"{family}.mp4").is_file() else start,
                     "seconds": 10,
                     "sourceUrl": f"/api/rooms/media/play-{family}-source",
                     "posterUrl": f"/api/rooms/media/play-{family}-poster"}
            for family, (recording, start) in PRIMARY.items()}


def prepare(data_root: Path | None = None, destination: Path | None = None):
    import pyarrow.parquet as pq

    data_root = data_root or PROJECT_ROOT / "data"
    destination = destination or runtime_root() / "world"
    downloaded = json.loads((data_root / "download_manifest.json").read_text())
    allowed = {entry["local_path"] for entry in downloaded["files"]}
    metadata = {row["recording_id"]: row for row in pq.read_table(data_root / "metadata.parquet").to_pylist()}
    manifest = {"version": 1, "attribution": ATTRIBUTION,
                "source_url": "https://huggingface.co/buckets/eidon-ai/egocentric-pov", "recordings": [], "demos": {}}
    folder = destination / "media"
    folder.mkdir(parents=True, exist_ok=True)
    for family, ids in RECORDINGS.items():
        for recording in ids:
            relative = f"000/{recording}_video.mp4"
            if relative not in allowed or not (data_root / relative).is_file():
                raise ValueError(f"Missing downloaded recording: {relative}")
            row = metadata[recording]
            expected = {"dishes": "doing_the_dishes", "laundry": "folding_laundry", "drawing": "drawing"}[family]
            if row["qc_status"] != "valid" or row["task_type"] != expected:
                raise ValueError(f"Recording {recording} does not match the reviewed task family")
            info = inspect_video(data_root / relative)
            manifest["recordings"].append({"id": recording, "family": family, "path": relative,
                                           "duration": info.duration_seconds, "qc_status": row["qc_status"]})
        recording, start = PRIMARY[family]
        source = data_root / f"000/{recording}_video.mp4"
        duration = inspect_video(source).duration_seconds
        seconds = min(10., duration - start)
        if seconds < 2: raise ValueError(f"Recording {recording} is too short for its demonstration")
        signature = {"bytes": source.stat().st_size, "mtime_ns": source.stat().st_mtime_ns, "start": start, "seconds": seconds}
        receipt = folder / f"{family}.json"
        cached = json.loads(receipt.read_text()) if receipt.exists() else {}
        clip, poster = folder / f"{family}.mp4", folder / f"{family}.jpg"
        if cached.get("signature") != signature or not clip.exists() or not poster.exists():
            temporary = folder / f"{family}.tmp.mp4"
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", str(start), "-i", str(source),
                            "-t", str(seconds), "-an", "-vf", "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,fps=24",
                            "-c:v", "libx264", "-preset", "fast", "-crf", "23", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(temporary)],
                           check=True, capture_output=True, timeout=120)
            temporary.replace(clip)
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", "1", "-i", str(clip), "-frames:v", "1", "-vf", "scale=640:-2", str(poster)],
                           check=True, capture_output=True, timeout=30)
            cached = {"signature": signature, "recording": recording, "source_sha256": file_digest(source), "clip_sha256": file_digest(clip)}
            receipt.write_text(json.dumps(cached, indent=2))
        manifest["demos"][family] = cached
    target = destination / "manifest.json"
    temporary = target.with_suffix(".tmp")
    temporary.write_text(json.dumps(manifest, indent=2))
    temporary.replace(target)
    return manifest


def main():
    configure()
    manifest = prepare()
    print(f"Prepared {len(manifest['demos'])} demonstrations from {len(manifest['recordings'])} local recordings.")


if __name__ == "__main__":
    main()
