"""Generate robot-room visual worlds with Reactor, retaining source and model receipts.

SANA edits a real local recording into a robot cell. LingBot turns its resulting
frame into a navigable world. These are visual assets, not calibrated geometry.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import shutil
import subprocess
from dataclasses import asdict
from datetime import datetime, timezone

from reactor_world.lingbot import Segment, run_scan

from .config import PROJECT_ROOT, configure, runtime_root, safe_error
from .media import file_digest, prepare_clip, storyboard
from .reactor_video import generate_video


async def with_capacity_retry(operation, progress):
    """Keep sessions serial and respect transient GPU capacity and per-minute quotas."""
    for attempt in range(3):
        try:
            return await operation()
        except Exception as error:
            if attempt == 2 or not any(code in str(error) for code in ("RATE_LIMITED", "no available capacity")):
                raise
            delay = 15 * (attempt + 1)
            progress(f"Reactor capacity is busy; retry {attempt + 2}/3 in {delay} seconds")
            await asyncio.sleep(delay)


def scene_prompt(theme: dict) -> str:
    return (f"Photorealistic {theme['name']} robot workcell. {theme['description']} "
            "Exactly one white Franka Panda seven-joint industrial robot arm with black circular joint covers, "
            "two parallel metal fingers, visible cabling and a bolted base on the right side of a workbench. "
            f"Exactly one {theme['object']} on the workbench in front of the fingers and one shallow receiving tray. "
            "Detailed physical materials, natural shadows, worn edges and reflections, documentary realism.")


async def generate(selected: str | None, seed_source: str, scans: bool) -> int:
    configure()
    themes = json.loads((PROJECT_ROOT / "public/robot-worlds/worlds.json").read_text())
    if selected and selected not in {t['id'] for t in themes}:
        raise ValueError("Unknown room theme")
    assets = PROJECT_ROOT / "public/reactor-gyms"
    assets.mkdir(parents=True, exist_ok=True)
    work = runtime_root() / "reactor-gyms"
    work.mkdir(parents=True, exist_ok=True)
    source = PROJECT_ROOT / "data/000/3_video.mp4"
    clip = work / "source.mp4"
    if seed_source == "footage" and not clip.is_file():
        await asyncio.to_thread(prepare_clip, source, clip, 0, 8)
    failed = []
    for index, theme in enumerate(themes):
        if selected and selected != theme['id']:
            continue
        name = theme['id']
        folder = work / name
        folder.mkdir(exist_ok=True)
        receipt_path = assets / f"{name}.json"
        receipt = json.loads(receipt_path.read_text()) if receipt_path.is_file() else {}
        prompt = scene_prompt(theme)
        image = assets / f"{name}.jpg"
        scan = assets / f"{name}.mp4"
        seed_image = PROJECT_ROOT / f"public/robot-worlds/{name}.png"
        if (receipt.get('status') in {'ready', 'needs_review'} and receipt.get('seed_source') == seed_source
                and (receipt.get('prompt') == prompt or receipt.get('imported_from')) and image.is_file() and scan.is_file()
                and (not scans or receipt.get('walk_generation'))
                and receipt.get('image_sha256') == file_digest(image)
                and (seed_source != 'reference' or receipt.get('seed_reference', {}).get('sha256') == file_digest(seed_image))
                and receipt.get('video_sha256') == file_digest(scan)):
            print(f"{name}: reusing recorded Reactor world", flush=True)
            continue
        if receipt:
            (folder / f"previous-{receipt.get('seed_source', 'unknown')}.json").write_text(json.dumps(receipt, indent=2) + '\n')
        receipt = {"theme": name, "status": "generating", "prompt": prompt,
                   "seed_source": seed_source,
                   "source_recording": "data/000/3_video.mp4" if seed_source == 'footage' else None,
                   "task_reference_recording": "data/000/3_video.mp4",
                   "geometry": "No geometry is returned by the hosted Reactor video API.",
                   "task_validation": "Visual experiment; robot action and contacts are not physics measurements.",
                   "attribution": "Eidon AI / Solidic Labs Inc · Egocentric POV · CC-BY-4.0"}

        def save(**changes):
            receipt.update(changes, updated_at=datetime.now(timezone.utc).isoformat())
            temporary = receipt_path.with_suffix('.tmp')
            temporary.write_text(json.dumps(receipt, indent=2) + '\n')
            temporary.replace(receipt_path)

        def progress(value):
            save(message=value)
            print(f"{name}: {value}", flush=True)

        save()
        try:
            if seed_source == 'footage':
                result = await with_capacity_retry(lambda: generate_video(clip, folder / 'edit.mp4',
                    prompt + " Replace the original room with this environment and replace the person's hands "
                    "with the industrial robot. Wide view of the robot and task bench with the room behind it.",
                    seed=900 + index, progress=progress), progress)
                receipt['seed_generation'] = asdict(result)
                await asyncio.to_thread(subprocess.run, ["ffmpeg", "-v", "error", "-y", "-ss", "2.5", "-i",
                    str(folder / 'edit.mp4'), "-frames:v", "1", "-q:v", "2", str(image)],
                    check=True, capture_output=True, timeout=60)
                shutil.copy2(folder / 'edit.mp4', assets / f'{name}-edit.mp4')
            else:
                # Existing references are explicitly attributed; all walkthrough frames come from LingBot.
                receipt['seed_reference'] = {'path': str(seed_image.relative_to(PROJECT_ROOT)),
                                             'tool': 'built-in imagegen', 'sha256': file_digest(seed_image)}
                await asyncio.to_thread(subprocess.run, ["ffmpeg", "-v", "error", "-y", "-i", str(seed_image),
                    "-frames:v", "1", "-q:v", "2", str(image)], check=True, capture_output=True, timeout=60)
            save(image_sha256=file_digest(image))
            if scans:
                camera = (" First-person observer at standing eye level. The robot stays at its fixed bolted base; "
                          "its gripper rests above the task object. The observer walks only while movement input "
                          "is held and looks around only while look input is held. At idle the camera holds still. "
                          "Continuous view with consistent room layout and robot identity.")
                result = await with_capacity_retry(lambda: run_scan(image, prompt + camera, folder / 'scan.mp4',
                    [Segment('settle', 2), Segment('approach', 1, move_longitudinal='forward'),
                     Segment('look_right', 1.2, look_horizontal='right', rotation=1),
                     Segment('look_left', 1.2, look_horizontal='left', rotation=1), Segment('settle', 2)],
                    seed=1900 + index, progress=progress), progress)
                shutil.copy2(folder / 'scan.mp4', scan.with_suffix('.pending.mp4'))
                scan.with_suffix('.pending.mp4').replace(scan)
                await asyncio.to_thread(storyboard, scan, folder / 'storyboard.jpg', 4)
                save(status='needs_review', walk_generation=asdict(result), video_sha256=file_digest(scan),
                     message='Reactor navigable world recorded')
            else:
                shutil.copy2(folder / 'edit.mp4', scan)
                await asyncio.to_thread(storyboard, scan, folder / 'storyboard.jpg', 4)
                save(status='needs_review', video_sha256=file_digest(scan), message='Reactor scene edit recorded; visual review required')
        except asyncio.CancelledError:
            save(status='interrupted', message='Generation interrupted; the Reactor session was released')
            raise
        except Exception as error:
            failed.append(name)
            save(status='failed', error=safe_error(error))
            print(f"{name}: FAILED {safe_error(error)}", flush=True)
    print(json.dumps({'failed': failed}), flush=True)
    return int(bool(failed))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--theme')
    parser.add_argument('--seed-source', choices=['footage', 'reference'], default='footage')
    parser.add_argument('--edit-only', action='store_true')
    args = parser.parse_args()
    raise SystemExit(asyncio.run(generate(args.theme, args.seed_source, not args.edit_only)))
