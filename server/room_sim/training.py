"""Optional PPO training, also included in exported standalone gyms."""
from __future__ import annotations

import argparse
import hashlib
import json
import time
from datetime import datetime, timezone
from pathlib import Path

from .gym_bundle import verify_bundle
from .gym_env import RoomRobotEnv


def positive(value):
    value = int(value)
    if value < 1:
        raise argparse.ArgumentTypeError("Must be a positive integer")
    return value


def main():
    parser = argparse.ArgumentParser(description="Train a PPO robot policy in a room gym")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--bundle", type=Path)
    source.add_argument("--scene", type=Path)
    parser.add_argument("--task", help="A task ID from rooms-gym list or manifest.json")
    parser.add_argument("--timesteps", type=positive, default=20_000)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--eval-episodes", type=positive, default=5)
    parser.add_argument("--output", type=Path, default=Path(".task-rooms/training") / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ"))
    args = parser.parse_args()
    if args.output.exists():
        parser.error("Output directory already exists; choose another to preserve earlier policies")
    try:
        import torch
        from stable_baselines3 import PPO
        from stable_baselines3.common.monitor import Monitor
    except ImportError:
        parser.error("Install training dependencies: uv sync --extra train (or pip install -r requirements.txt in an export)")
    if args.bundle:
        manifest = verify_bundle(args.bundle)
        scene = args.bundle / "scene.json"
        task = args.task or manifest["default_task"]
    else:
        scene, task = args.scene, args.task
    # Read once: reconstruction or an external edit can replace the source
    # while a long training run is in progress.
    snapshot = scene.read_text()
    scene_data = json.loads(snapshot)
    spec = scene_data.get("spec", scene_data)
    torch.set_num_threads(1)
    env = RoomRobotEnv(spec=spec, task=task)
    evaluation = RoomRobotEnv(spec=spec, task=task)
    args.output.mkdir(parents=True)
    (args.output / "scene.json").write_text(snapshot)
    monitor = Monitor(env, str(args.output / "episodes.csv"))
    started = time.monotonic()
    try:
        # A bounded rollout size keeps short smoke runs practical. PPO rounds up to full rollouts.
        model = PPO("MultiInputPolicy", monitor, seed=args.seed, device="cpu", n_steps=256,
                    batch_size=64, n_epochs=5, verbose=1)
        model.learn(total_timesteps=args.timesteps, log_interval=10)
        model.save(args.output / "policy")
        episodes = []
        for index in range(args.eval_episodes):
            observation, info = evaluation.reset(seed=args.seed + 10_000 + index)
            reward_sum = 0.
            terminated = truncated = False
            while not (terminated or truncated):
                action, _ = model.predict(observation, deterministic=True)
                observation, reward, terminated, truncated, info = evaluation.step(action)
                reward_sum += reward
            episodes.append({"seed": args.seed + 10_000 + index, "return": reward_sum,
                             "success": info["is_success"], "distance": info["distance"],
                             "steps": info["elapsed_steps"], "failure": info["failure"]})
        report = {"algorithm": "PPO", "task": env.task["id"], "seed": args.seed,
                  "scene_sha256": hashlib.sha256(snapshot.encode()).hexdigest(),
                  "room_revision": scene_data.get("revision"),
                  "requested_timesteps": args.timesteps, "actual_timesteps": model.num_timesteps,
                  "elapsed_seconds": time.monotonic() - started,
                  "success_rate": sum(e["success"] for e in episodes) / len(episodes), "evaluation": episodes,
                  "randomization": env.randomization, "max_episode_steps": env.max_episode_steps}
        (args.output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps({"policy": str(args.output / "policy.zip"), **report}, indent=2))
    finally:
        monitor.close()
        evaluation.close()


if __name__ == "__main__":
    main()
