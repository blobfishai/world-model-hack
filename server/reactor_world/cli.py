"""Headless Reactor world pipeline: plan → LingBot scan → physics → MuJoCo Playground bundle."""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import shutil
import sys
from pathlib import Path

from task_rooms.config import configure

from . import probe
from .jobs import WorldJobs
from .playground_export import run_bundle_script
from .sources import list_sources
from .store import WorldStore


async def _settle(jobs: WorldJobs) -> None:
    while jobs.tasks:
        await asyncio.gather(*list(jobs.tasks))


def _job(store: WorldStore, world: str, room: str, name: str) -> int:
    job = getattr(store.room(world, room).jobs, name)
    print(json.dumps({"room": room, name: job.model_dump()}, indent=2))
    return 0 if job.status == "ready" else 1


def main(argv: list[str] | None = None) -> int:
    configure()
    os.environ["REACTOR_WORLD_AUTOSCAN"] = "0"
    parser = argparse.ArgumentParser(prog="reactor-world", description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("sources", help="list start videos in data/")
    plan = commands.add_parser("plan", help="extract the beginning image and plan rooms (Gemini)")
    plan.add_argument("--source", required=True, help="recording id, e.g. 3 for data/000/3_video.mp4")
    plan.add_argument("--t", type=float, default=0.)
    show = commands.add_parser("show", help="print a world record")
    show.add_argument("--world", required=True)
    for name, text in (("scan", "record a Reactor LingBot World 2 scan (paid)"),
                       ("reconstruct", "build MuJoCo physics from the scan (Gemini)"),
                       ("export", "write the MuJoCo Playground bundle")):
        command = commands.add_parser(name, help=text)
        command.add_argument("--world", required=True)
        command.add_argument("--room", default="root")
        if name == "export":
            command.add_argument("--output", type=Path, help="also copy the unzipped bundle here")
    check = commands.add_parser("check", help="run a bundle's smoke test")
    check.add_argument("--bundle", type=Path, required=True)
    gate = commands.add_parser("probe", help="paid LingBot capability gate: hub + one room, reviewed by Gemini")
    gate.add_argument("--source", default="3")
    gate.add_argument("--t", type=float, default=0.)
    gate.add_argument("--room", default="0")
    args = parser.parse_args(argv)
    store = WorldStore()

    if args.command == "sources":
        for source in list_sources():
            print(f"{source['id']:>5}  {source['duration']:7.1f}s  {source['width']}×{source['height']}  {source['label']}")
        return 0
    if args.command == "show":
        print(store.require(args.world).model_dump_json(indent=2))
        return 0
    if args.command == "probe":
        report = asyncio.run(probe.run(args.source, args.t, args.room))
        return 0 if report["walk_strategy_qualified"] else 1
    if args.command == "check":
        result = run_bundle_script(args.bundle.resolve(), "smoke_test.py", "--impl", "jax")
        print(result.stdout or result.stderr)
        return result.returncode

    async def run() -> int:
        jobs = WorldJobs(store)
        if args.command == "plan":
            world = jobs.create_world(args.source, args.t)
            await _settle(jobs)
            world = store.require(world.id)
            print(json.dumps({"world": world.id, "status": world.status, "error": world.error, "hub": world.hub_title,
                              "rooms": {p: {"title": r.title, "relation": r.relation, "robot_task": r.task.robot_task and r.task.robot_task.model_dump()}
                                        for p, r in world.rooms.items()}}, indent=2))
            return 0 if world.status == "ready" else 1
        if args.command == "scan":
            store.set_job(args.world, args.room, "scan", status="queued")
            try:
                await jobs._scan(args.world, args.room)
            except Exception:
                pass
            return _job(store, args.world, args.room, "scan")
        if args.command == "reconstruct":
            jobs.start_physics(args.world, args.room)
            await _settle(jobs)
            return _job(store, args.world, args.room, "physics")
        jobs.start_export(args.world, args.room)
        await _settle(jobs)
        status = _job(store, args.world, args.room, "export")
        bundle = next((p for p in (store.room_path(args.world, args.room) / "export").iterdir() if p.is_dir()), None)
        if args.output and bundle:
            shutil.copytree(bundle, args.output, dirs_exist_ok=True)
            print(f"Bundle copied to {args.output}")
        return status

    return asyncio.run(run())


if __name__ == "__main__":
    sys.exit(main())
