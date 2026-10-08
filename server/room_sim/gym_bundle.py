"""Portable, hashed robot gyms with their original scene and video evidence."""
from __future__ import annotations

import hashlib
import json
import shutil
import tempfile
from datetime import datetime, timezone
from importlib.metadata import version
from pathlib import Path

from .gym_env import RoomRobotEnv


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def room_references(store_root: Path, scene: dict, probe_root: Path | None = None) -> list[tuple[Path, str]]:
    references = []
    job = scene.get("source_job")
    if not job:
        return references
    # Job IDs are persisted internally, never accepted as filesystem paths from an API request.
    if not isinstance(job, str) or len(job) != 32 or any(c not in "0123456789abcdef" for c in job):
        raise ValueError("Invalid source build ID")
    build = store_root / "builds" / job
    source = build / "source.mp4"
    if not source.is_file():
        raise ValueError("The reconstructed room's source video is missing")
    references.append((source, "scene_reference"))
    if (build / "source.json").is_file():
        references.append((build / "source.json", "reconstruction_provenance"))
    if (build / "manual-review.json").is_file():
        references.append((build / "manual-review.json", "layout_corrections"))
    references.extend((frame, "evidence_frame") for frame in sorted((build / "frames").glob("frame-*.jpg")))
    if probe_root:
        source_hash = digest(source)
        for report_path in sorted(probe_root.glob("*/report.json")):
            report = json.loads(report_path.read_text())
            hashes = {c.get("generation", {}).get("sha256") for c in report.get("cases", [])}
            hashes.add(report.get("source", {}).get("clip_sha256"))
            if source_hash not in hashes:
                continue
            references.append((report_path, "generation_review"))
            for video in sorted(report_path.parent.glob("*.mp4")):
                role = "original_video_reference" if video.name == "source.mp4" else "unverified_generated_reference"
                references.append((video, role))
            break
    return references


def export_bundle(scene: dict, output: Path, references: list[tuple[Path, str]] | None = None, *, task: str | None = None) -> dict:
    output = output.resolve()
    if output.exists():
        raise ValueError(f"Output already exists: {output}. Choose a new directory.")
    # Validate before writing a usable export; the original room revision is frozen here.
    env = RoomRobotEnv(spec=scene["spec"], task=task)
    try:
        env.reset(seed=42)
        for _ in range(10):
            env.step([0, 0, 0, 1])
        manifest = {
            "format_version": 1, "environment_id": "RoomRobot-v0",
            "room_id": env.room_spec.room_id, "room_revision": scene["revision"],
            "source": "video_reconstruction" if scene.get("source_job") else "example_or_manual_scene",
            "created_at": datetime.now(timezone.utc).isoformat(),
            "scale_status": env.room_spec.scale_status, "robot": "cartesian_parallel_jaw",
            "control_hz": 20, "physics_hz": 500, "default_task": env.task["id"],
            "actions": {"shape": [4], "range": [-1, 1], "xyz_step_meters": .025,
                        "channels": ["delta_x", "delta_y", "delta_z", "gripper_open"],
                        "gripper": "-1 closes, +1 opens; contacts move objects"},
            "observations": {"observation": list(env.observation_space["observation"].shape),
                             "achieved_goal": [3], "desired_goal": [3], "type": "privileged_simulator_state"},
            "tasks": env.tasks, "max_episode_steps": env.max_episode_steps,
            "video_usage": "Scene/appearance references only. No action labels, imitation rewards, or successful demonstrations inferred from footage.",
            "limitations": ["Parametric approximation; dimensions, mass and friction require calibration.",
                            "Cartesian gripper, not a calibrated hardware arm or a sim-to-real policy.",
                            "Candidate manipulation tasks require reachability and policy evaluation."],
            "versions": {p: version(p) for p in ("mujoco", "gymnasium", "numpy", "pydantic")},
            "files": [],
        }
        output.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix=".gym-export-", dir=output.parent) as temporary:
            staging = Path(temporary) / "bundle"
            staging.mkdir()
            (staging / "scene.json").write_text(json.dumps(scene, indent=2) + "\n")
            (staging / "robot.xml").write_text(env.xml)
            runtime = staging / "room_sim"
            runtime.mkdir()
            (runtime / "__init__.py").write_text('"""Portable room robot environment."""\n')
            for name in ("schema.py", "compiler.py", "robot.py", "gym_env.py", "training.py", "gym_bundle.py"):
                shutil.copy2(Path(__file__).with_name(name), runtime / name)
            (staging / "train.py").write_text("from room_sim.training import main\n\nif __name__ == '__main__':\n    main()\n")
            (staging / "requirements.txt").write_text("\n".join(f"{p}=={v}" for p, v in manifest["versions"].items()) + "\nstable-baselines3>=2.7,<3\n")
            (staging / "README.md").write_text(
                "# Room robot gym\n\nInstall with Python 3.12: `pip install -r requirements.txt`.\n\n"
                "Train: `python train.py --bundle . --timesteps 20000 --output training`.\n\n"
                "Use a task ID from manifest.json with `--task reach:OBJECT_ID` (or a listed push/lift task).\n\n"
                "```python\nimport gymnasium as gym\nimport room_sim.gym_env\n"
                "env = gym.make('RoomRobot-v0', scene_path='scene.json')\nobs, info = env.reset(seed=42)\n"
                "obs, reward, terminated, truncated, info = env.step(env.action_space.sample())\nenv.close()\n```\n\n"
                "The green marker is the task goal. RGB rendering is optional (`render_mode='rgb_array'`); training is headless.\n\n"
                "Video files are scene references, not successful robot demonstrations. Review the included provenance and generation reviews. "
                "The simulator approximates the room with rigid primitives and a Cartesian gripper. Scale and dynamics need calibration before hardware use.\n")
            roles = {}
            for index, (source, role) in enumerate(references or []):
                destination = staging / "references" / f"{index:02d}-{source.name}"
                destination.parent.mkdir(exist_ok=True)
                shutil.copy2(source, destination)
                roles[destination.relative_to(staging).as_posix()] = role
            for path in sorted(staging.rglob("*")):
                if path.is_file():
                    name = path.relative_to(staging).as_posix()
                    manifest["files"].append({"path": name, "sha256": digest(path), "bytes": path.stat().st_size,
                                              "role": roles.get(name, "environment")})
            (staging / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
            staging.rename(output)
        return manifest
    finally:
        env.close()


def verify_bundle(folder: Path) -> dict:
    folder = folder.resolve()
    manifest = json.loads((folder / "manifest.json").read_text())
    if manifest.get("format_version") != 1:
        raise ValueError("Unsupported gym bundle version")
    paths = set()
    for entry in manifest["files"]:
        path = (folder / entry["path"]).resolve()
        if not path.is_relative_to(folder) or not path.is_file() or digest(path) != entry["sha256"]:
            raise ValueError(f"Bundle file is missing, outside the bundle, or modified: {entry['path']}")
        paths.add(entry["path"])
    if not {"scene.json", "robot.xml"} <= paths:
        raise ValueError("Bundle manifest must include the scene and robot model")
    return manifest
