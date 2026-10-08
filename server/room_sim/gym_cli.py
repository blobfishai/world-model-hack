from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path

import numpy as np
from gymnasium.utils.env_checker import check_env

from task_rooms.config import configure, runtime_root

from .builds import RoomStore
from .gym_bundle import export_bundle, room_references, verify_bundle
from .gym_env import RoomRobotEnv
from .templates import ROOMS
from .training import positive


def main():
    configure()
    parser = argparse.ArgumentParser(description="Export and run robot gyms from reconstructed rooms")
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("list", "export"):
        command = commands.add_parser(name)
        command.add_argument("--room", choices=ROOMS, default="kitchen")
        command.add_argument("--root", type=Path, help="Room store directory (defaults to ROOM_SIM_HOME)")
        if name == "export":
            command.add_argument("--output", type=Path, required=True, help="New bundle directory")
            command.add_argument("--video", action="append", type=Path, default=[], help="Additional scene reference; repeatable")
    for name in ("check", "rollout"):
        command = commands.add_parser(name)
        command.add_argument("--bundle", type=Path, required=True)
        command.add_argument("--task")
        command.add_argument("--seed", type=int, default=42)
        if name == "rollout":
            command.add_argument("--policy", default="reach", help="reach (scripted), random, or a PPO policy.zip")
            command.add_argument("--output", type=Path, required=True, help="New .npz trajectory")
            command.add_argument("--video", type=Path, help="Optional .mp4 render; requires OpenGL and FFmpeg")
    args = parser.parse_args()
    if args.command in {"list", "export"}:
        store = RoomStore(args.root)
        with store.lock:
            scene = store.get(args.room)
        if args.command == "export":
            references = room_references(store.root, scene, runtime_root() / "probes")
            references.extend((path, "unverified_video_reference") for path in args.video)
            manifest = export_bundle(scene, args.output, references)
            print(json.dumps({"bundle": str(args.output.resolve()), "source": manifest["source"],
                              "tasks": [t["id"] for t in manifest["tasks"]]}, indent=2))
        else:
            with RoomRobotEnv(spec=scene["spec"]) as env:
                print(json.dumps({"room": args.room, "revision": scene["revision"],
                                  "source": "video" if scene.get("source_job") else "example_or_manual", "tasks": env.tasks}, indent=2))
        return
    manifest = verify_bundle(args.bundle)
    task = args.task or manifest["default_task"]
    with RoomRobotEnv(scene_path=args.bundle / "scene.json", task=task,
                      render_mode="rgb_array" if args.command == "rollout" and args.video else None) as env:
        if args.command == "check":
            check_env(env, skip_render_check=True)
            print(json.dumps({"valid": True, "task": env.task["id"], "verified_files": len(manifest["files"])}))
            return
        if args.output.suffix != ".npz" or args.output.exists():
            parser.error("--output must be a new .npz file")
        if args.video and (args.video.suffix != ".mp4" or args.video.exists()):
            parser.error("--video must be a new .mp4 file")
        if args.policy == "reach" and env.task["kind"] != "reach":
            parser.error("The scripted reach controller only supports reach tasks; choose random or a trained policy")
        policy = None
        if args.policy not in {"reach", "random"}:
            from stable_baselines3 import PPO
            policy = PPO.load(args.policy, env=env, device="cpu")
        observation, info = env.reset(seed=args.seed)
        env.action_space.seed(args.seed)
        states, actions, rewards, ends = [env.data.qpos.copy()], [], [], []
        process = None
        try:
            if args.video:
                args.video.parent.mkdir(parents=True, exist_ok=True)
                process = subprocess.Popen(["ffmpeg", "-v", "error", "-n", "-f", "rawvideo", "-pix_fmt", "rgb24",
                                            "-s", "640x480", "-r", "20", "-i", "-", "-an", "-c:v", "libx264",
                                            "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(args.video)], stdin=subprocess.PIPE)
            terminated = truncated = False
            while not (terminated or truncated):
                if policy:
                    action, _ = policy.predict(observation, deterministic=True)
                elif args.policy == "reach":
                    action = np.r_[np.clip((env.goal - env.data.ctrl[:3]) / .025, -1, 1), 1].astype(np.float32)
                else:
                    action = env.action_space.sample()
                observation, reward, terminated, truncated, info = env.step(action)
                states.append(env.data.qpos.copy()); actions.append(action); rewards.append(reward)
                ends.append([terminated, truncated])
                if process:
                    process.stdin.write(env.render().tobytes())
        finally:
            if process:
                process.stdin.close()
                try:
                    code = process.wait(timeout=30)
                except subprocess.TimeoutExpired:
                    process.kill(); process.wait()
                    raise RuntimeError("Video encoding timed out") from None
                if code:
                    raise RuntimeError(f"Video encoding failed with exit code {code}")
        args.output.parent.mkdir(parents=True, exist_ok=True)
        np.savez_compressed(args.output, qpos=np.array(states), actions=np.array(actions), rewards=np.array(rewards),
                            episode_end=np.array(ends), task=task, seed=args.seed, controller=args.policy)
        print(json.dumps({"trajectory": str(args.output), "controller": args.policy, **info}, indent=2))
