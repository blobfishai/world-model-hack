"""Animate generated room images using real Reactor sessions; cache every result."""
from __future__ import annotations

import argparse
import asyncio
import json
import subprocess
from dataclasses import asdict
from datetime import datetime, timezone

from .config import PROJECT_ROOT, configure, runtime_root, safe_error
from .media import file_digest, inspect_video
from .reactor_video import generate_video


async def main_async(selected: str | None = None):
    configure()
    assets = PROJECT_ROOT / "public" / "robot-worlds"
    themes = json.loads((assets / "worlds.json").read_text())
    if selected and selected not in {t["id"] for t in themes}:
        raise ValueError("Unknown room theme")
    root = runtime_root() / "world-visuals"
    root.mkdir(parents=True, exist_ok=True)
    results = []
    for theme in themes:
        name = theme["id"]
        if selected and selected != name:
            continue
        image, output = assets / f"{name}.png", assets / f"{name}.mp4"
        folder = root / name
        folder.mkdir(exist_ok=True)
        receipt_path = folder / "receipt.json"
        if output.is_file() and receipt_path.is_file():
            receipt = json.loads(receipt_path.read_text())
            if (receipt.get("status") == "ready" and receipt.get("output_sha256") == file_digest(output)
                    and receipt.get("image_sha256") == file_digest(image)):
                print(f"{name}: reusing saved Reactor video", flush=True)
                results.append(receipt)
                continue
        prompt = (f"Animate this {theme['name']} robotics environment. {theme['description']} "
                  "A locked-off camera with subtle continuous ambient motion: gently shifting light, "
                  "soft reflections, tiny instrument lights and natural environmental movement. "
                  "Preserve the reference image's architecture, composition, colors and objects. "
                  "No camera cuts, people, captions or added objects. Seamless calm environmental footage.")
        receipt = {"theme": name, "status": "preparing", "image_sha256": file_digest(image),
                   "prompt": prompt, "image_tool": "built-in imagegen", "video_model": "reactor/sana-streaming",
                   "conditioning": "Generated image encoded as an 8-second reference video track; no Reactor image API.",
                   "usage": "Ambient appearance, not robot action supervision."}

        def update(**changes):
            receipt.update(changes, updated_at=datetime.now(timezone.utc).isoformat())
            temporary = receipt_path.with_suffix(".tmp")
            temporary.write_text(json.dumps(receipt, indent=2) + "\n")
            temporary.replace(receipt_path)

        update()
        try:
            source = folder / "image-reference.mp4"
            await asyncio.to_thread(subprocess.run, [
                "ffmpeg", "-v", "error", "-y", "-loop", "1", "-i", str(image),
                "-t", "8", "-vf", "scale=1280:704:force_original_aspect_ratio=increase,crop=1280:704,setsar=1,fps=24",
                "-an", "-c:v", "libx264", "-preset", "fast", "-crf", "20", "-pix_fmt", "yuv420p", str(source)
            ], check=True, capture_output=True, timeout=90)
            candidate = folder / "reactor.mp4"

            def progress(message):
                update(status="generating", message=message)
                print(f"{name}: {message}", flush=True)

            for attempt in range(3):
                try:
                    generation = await generate_video(source, candidate, prompt, seed=42 + len(results), progress=progress)
                    break
                except Exception as error:
                    if attempt == 2 or not any(code in str(error) for code in ("RATE_LIMITED", "no available capacity")):
                        raise
                    progress(f"Reactor is at capacity; retrying in {(attempt + 1) * 5} seconds.")
                    await asyncio.sleep((attempt + 1) * 5)
            # Publish a completed file atomically; a failed attempt never replaces a playable result.
            import shutil
            staging = output.with_suffix(".pending.mp4")
            await asyncio.to_thread(shutil.copy2, candidate, staging)
            staging.replace(output)
            update(status="ready", generation=asdict(generation), output_sha256=file_digest(output),
                   video=asdict(inspect_video(output)), message="Reactor room video saved")
            print(f"{name}: READY {generation.received_frames} frames", flush=True)
        except Exception as error:
            update(status="failed", error=safe_error(error))
            print(f"{name}: FAILED {safe_error(error)}", flush=True)
        results.append(receipt)
    print(json.dumps({"ready": sum(r["status"] == "ready" for r in results), "total": len(results)}), flush=True)
    return 0 if all(r["status"] == "ready" for r in results) else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--theme")
    raise SystemExit(asyncio.run(main_async(parser.parse_args().theme)))
