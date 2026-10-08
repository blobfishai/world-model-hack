"""Generate every robot-world environment with Reactor's navigable world model."""
from __future__ import annotations

import argparse
import asyncio
import json
import subprocess
from dataclasses import asdict
from datetime import datetime, timezone

from reactor_world.lingbot import MODEL_NAME, Segment, extract_frame_at, run_scan
from .config import PROJECT_ROOT, configure, runtime_root, safe_error
from .media import file_digest


def world_prompt(theme):
    return (
        f"Photorealistic first-person exploration of {theme['name']}, a full-scale robotics training facility. "
        f"{theme['description']} The room contains a real seven-joint white and black Franka Panda robot arm "
        f"bolted to a substantial workbench, a parallel two-finger gripper, and a {theme['object']} ready for manipulation. "
        "The articulated robot has rounded cast-metal link housings, visible joints, cables, rubber fingertips, "
        "and realistic proportions. Detailed working equipment, physically plausible materials, subtle wear, "
        "glass reflections, natural indirect light, contact shadows, consistent scale and camera parallax. "
        "Keep the room and all objects coherent as the viewer moves. Continuous eye-level camera, no cuts, "
        "no text, no UI, no flat image walls or low-poly scenery."
    )


async def generate(selected=None):
    configure()
    assets = PROJECT_ROOT / "public/robot-worlds"
    themes = json.loads((assets / "worlds.json").read_text())
    if selected and selected not in {t["id"] for t in themes}:
        raise ValueError("Unknown room theme")
    published = assets / "generated"
    published.mkdir(parents=True, exist_ok=True)
    results = []
    for theme in themes:
        name = theme["id"]
        if selected and name != selected:
            continue
        source = assets / f"{name}.png"
        prompt = world_prompt(theme)
        signature = {"model": MODEL_NAME, "source_sha256": file_digest(source), "prompt": prompt, "version": 1}
        folder = runtime_root() / "world-generation" / name
        folder.mkdir(parents=True, exist_ok=True)
        receipt_path = folder / "receipt.json"
        saved = json.loads(receipt_path.read_text()) if receipt_path.exists() else {}
        movie, poster = published / f"{name}.mp4", published / f"{name}.jpg"
        if (saved.get("signature") == signature and saved.get("status") == "ready"
                and movie.is_file() and poster.is_file() and saved.get("sha256") == file_digest(movie)):
            print(f"{name}: reusing generated world", flush=True)
            results.append(saved)
            continue
        receipt = {"theme": name, "signature": signature, "status": "generating"}

        def update(**fields):
            receipt.update(fields, updated_at=datetime.now(timezone.utc).isoformat())
            temporary = receipt_path.with_suffix(".tmp")
            temporary.write_text(json.dumps(receipt, indent=2))
            temporary.replace(receipt_path)

        def progress(message):
            print(f"{name}: {message}", flush=True)

        update()
        try:
            output = folder / "native.mp4"
            for attempt in range(3):
                try:
                    result = await run_scan(source, prompt, output,
                        [Segment("settle", 1.5), Segment("walk_forward", 2.5, move_longitudinal="forward"),
                         Segment("look_left", 1.5, look_horizontal="left", rotation=1.5),
                         Segment("look_right", 1.5, look_horizontal="right", rotation=1.5)],
                        seed=200 + themes.index(theme), progress=progress)
                    break
                except Exception as error:
                    if attempt == 2 or "RATE_LIMITED" not in str(error):
                        raise
                    progress("Reactor capacity is busy; retrying after a cooldown")
                    await asyncio.sleep(12 * (attempt + 1))
            staging = movie.with_suffix(".pending.mp4")
            await asyncio.to_thread(subprocess.run, ["ffmpeg", "-v", "error", "-y", "-i", str(output),
                "-an", "-vf", "scale=1280:736:force_original_aspect_ratio=increase,crop=1280:736,fps=24",
                "-c:v", "libx264", "-preset", "fast", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(staging)],
                check=True, capture_output=True, timeout=90)
            staging.replace(movie)
            await asyncio.to_thread(extract_frame_at, output, min(48, result.received_frames - 1), poster)
            update(status="ready", generation=asdict(result), sha256=file_digest(movie),
                   poster_sha256=file_digest(poster), artifact_type="generated world video and reference frame")
            (published / f"{name}.json").write_text(json.dumps({
                "model": MODEL_NAME, "prompt": prompt, "seed": result.seed,
                "source": f"/robot-worlds/{name}.png", "video": f"/robot-worlds/generated/{name}.mp4",
                "poster": f"/robot-worlds/generated/{name}.jpg", "frames": result.received_frames,
                "sha256": receipt["sha256"], "generated_at": receipt["updated_at"],
                "format": "Interactive world-model video; no mesh or robot dynamics are returned by Reactor."
            }, indent=2))
            progress(f"READY: {result.received_frames} generated frames")
        except Exception as error:
            update(status="failed", error=safe_error(error))
            progress(f"FAILED: {safe_error(error)}")
        results.append(receipt)
    print(json.dumps({"ready": sum(r["status"] == "ready" for r in results), "total": len(results)}), flush=True)
    return 0 if all(r["status"] == "ready" for r in results) else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--theme")
    raise SystemExit(asyncio.run(generate(parser.parse_args().theme)))
