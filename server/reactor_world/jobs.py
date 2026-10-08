"""Background work inside the rooms-server process: planning, Reactor scans, physics and Playground export."""
from __future__ import annotations

import asyncio
import itertools
import os
import random
import re
import shutil
import threading
from dataclasses import asdict
from pathlib import Path

from task_rooms.config import safe_error
from task_rooms.media import file_digest, storyboard

from task_rooms.reactor_video import generate_video

from . import lingbot, planner, playground_export, reconstruct, robot_sim
from .schema import DemoSummary, JobName, SourceRef, World
from .sources import ATTRIBUTION, beginning_image, footage_candidates, resolve_source, signature
from .store import WorldStore, now


async def on_daemon_thread(function, *args, **kwargs):
    """Blocking work (including a whole Reactor session) on a daemon thread, so shutdown never waits on it."""
    loop = asyncio.get_running_loop()
    future = loop.create_future()

    def settle(result=None, error=None):
        if not future.done():
            future.set_exception(error) if error else future.set_result(result)

    def target():
        try:
            result = function(*args, **kwargs)
        except BaseException as error:
            try:
                loop.call_soon_threadsafe(settle, None, error)
            except RuntimeError:
                pass
        else:
            try:
                loop.call_soon_threadsafe(settle, result)
            except RuntimeError:
                pass

    threading.Thread(target=target, daemon=True, name=f"reactor-world-{getattr(function, '__name__', 'job')}").start()
    return await future


def scan_blocking(*args, **kwargs):
    return asyncio.run(lingbot.run_scan(*args, **kwargs))


RETRIES = 6


def busy_reason(error: BaseException) -> str:
    return "session quota" if "quota" in str(error) else "no free GPU capacity"


def retry_delay(error: BaseException, attempt: int) -> float | None:
    """Reactor answers 429 for its per-minute session quota and when the model has no free capacity."""
    text = str(error)
    if "RATE_LIMITED" not in text and "429" not in text and "no available capacity" not in text:
        return None
    hint = re.search(r'"retry_after_seconds"\s*:\s*([0-9.]+)', text)
    base = float(hint.group(1)) + 2 if hint else min(90., 10. * 2 ** attempt)
    return base + random.uniform(0, 3)


def autoscan() -> bool:
    return os.environ.get("REACTOR_WORLD_AUTOSCAN", "1") != "0" and bool(os.environ.get("REACTOR_API_KEY"))


class WorldJobs:
    def __init__(self, store: WorldStore, reactor_sessions: int | None = None):
        # The account allows 5 concurrent sessions and 10 new ones per minute, shared with the browser and other tools.
        reactor_sessions = reactor_sessions or int(os.environ.get("REACTOR_WORLD_SESSIONS", "1"))
        self.store = store
        self.reactor_sessions = reactor_sessions
        self.queue: asyncio.PriorityQueue | None = None
        self.workers: list[asyncio.Task] = []
        self.tasks: set[asyncio.Task] = set()
        self.order = itertools.count()
        self.gemini = asyncio.Semaphore(3)
        self.exports = asyncio.Semaphore(1)

    def spawn(self, coroutine) -> asyncio.Task:
        task = asyncio.get_running_loop().create_task(coroutine)
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        return task

    def progress(self, world_id: str, path: str, name: JobName, start: int, end: int):
        """A thread-safe progress callback that advances within [start, end) as messages arrive."""
        state = {"value": start}

        def update(message: str) -> None:
            state["value"] = min(end, state["value"] + max(1, (end - state["value"]) // 6))
            try:
                self.store.set_job(world_id, path, name, message=message[:200], progress=state["value"])
            except KeyError:
                pass
        return update

    # Planning ---------------------------------------------------------------------------------
    def create_world(self, source_id: str, t: float) -> World:
        path, source = resolve_source(source_id)
        if t > max(0., source["duration"] - .5):
            raise ValueError(f"Choose a start time within the first {source['duration'] - .5:.1f} s")
        identifier = planner.world_id(signature(path), t)
        existing = self.store.load(identifier)
        if existing and existing.status != "failed":
            return existing
        stamp = now()
        world = World(id=identifier, status="planning", created_at=existing.created_at if existing else stamp,
                      updated_at=stamp, attribution=ATTRIBUTION, planner_pid=os.getpid(),
                      source=SourceRef(id=source["id"], file=source["file"], t=t, task_type=source.get("task_type")))
        self.store.save(world)
        self.spawn(self._plan(identifier, path, source, t))
        return world

    async def _plan(self, identifier: str, path: Path, source: dict, t: float) -> None:
        folder = self.store.folder(identifier)
        try:
            start = folder / "start.jpg"
            actual = await asyncio.to_thread(beginning_image, path, t, start, source["duration"])
            # Real places for the rooms: sharp frames across the start video and the other recordings in data/.
            candidates = await asyncio.to_thread(footage_candidates, source["id"], folder / "footage")
            async with self.gemini:
                if len(candidates) >= 6:
                    plan = await on_daemon_thread(planner.plan_footage_world, start, source.get("task_type"), candidates,
                                                  folder / "plan-response.json")
                else:
                    candidates = []
                    plan = await on_daemon_thread(planner.plan_hub, start, source.get("task_type"), folder / "plan-response.json")
            digest = await asyncio.to_thread(file_digest, path)
            reference = SourceRef(id=source["id"], file=source["file"], t=actual, task_type=source.get("task_type"), sha256=digest)
            world = planner.build_world(identifier, reference, plan, candidates)
            world.created_at = self.store.require(identifier).created_at
            await asyncio.to_thread(shutil.copy2, start, self.store.room_folder(identifier, "root") / "arrival.jpg")
            for room, planned in zip((world.rooms[p] for p in world.rooms["root"].children), plan.rooms):
                if room.footage is not None:
                    # A footage room is enterable at once: its real frame seeds the Reactor world.
                    await asyncio.to_thread(shutil.copy2, candidates[planned.frame]["image"],
                                            self.store.room_folder(identifier, room.path) / "arrival.jpg")
            self.store.save(world)
            if autoscan():
                for room in ["root", *world.rooms["root"].children]:
                    self.enqueue_scan(identifier, room, priority=0 if room == "root" else 1)
        except Exception as error:
            message = safe_error(error)

            def fail(world: World):
                world.status, world.error = "failed", message
            self.store.mutate(identifier, fail)

    # Reactor scans ----------------------------------------------------------------------------
    def enqueue_scan(self, world_id: str, path: str, priority: int = 1) -> None:
        room = self.store.room(world_id, path)
        if self.store.running(room.jobs.scan):
            return
        if room.parent is not None and room.parent != "root" and not self.arrival(world_id, room.parent).is_file() \
                and not self.store.running(self.store.room(world_id, room.parent).jobs.scan):
            raise ValueError("Generate the parent room's Reactor scan first")
        self.store.set_job(world_id, path, "scan", status="queued", progress=0, error=None,
                           message="Waiting for a Reactor session")
        if self.queue is None:
            self.queue = asyncio.PriorityQueue()
            self.workers = [self.spawn(self._worker()) for _ in range(self.reactor_sessions)]
        self.queue.put_nowait((priority, next(self.order), world_id, path))

    def arrival(self, world_id: str, path: str) -> Path:
        return self.store.room_folder(world_id, path) / "arrival.jpg"

    async def _worker(self) -> None:
        assert self.queue is not None
        while True:
            _, _, world_id, path = await self.queue.get()
            try:
                if self.store.room(world_id, path).jobs.scan.status == "queued":
                    await self._scan(world_id, path)
            except Exception:
                pass  # _scan records failures on the job
            finally:
                self.queue.task_done()

    async def _scan(self, world_id: str, path: str) -> None:
        world = self.store.require(world_id)
        room = world.rooms[path]
        folder = self.store.room_folder(world_id, path)
        try:
            if room.parent is None:
                seed_image, script = self.store.folder(world_id) / "start.jpg", lingbot.hub_script(room.camera_pitch_hint)
            elif room.footage is not None:
                # Built from a real footage frame: Reactor starts there and looks around the real place.
                seed_image, script = self.arrival(world_id, path), lingbot.hub_script(room.camera_pitch_hint)
                if not seed_image.is_file():
                    raise ValueError("This room's footage frame is missing; create the world again")
            else:
                parent = world.rooms[room.parent]
                for _ in range(240):  # a parent queued at the same time finishes first
                    if self.arrival(world_id, room.parent).is_file() and self.store.room(world_id, room.parent).jobs.scan.status != "generating":
                        break
                    await asyncio.sleep(1)
                seed_image = self.arrival(world_id, room.parent)
                if not seed_image.is_file():
                    raise ValueError("The parent room has no Reactor arrival frame yet")
                script = lingbot.room_script(parent.camera_pitch_hint, room.bearing)
            self.store.set_job(world_id, path, "scan", status="generating", progress=3, message="Connecting to Reactor")
            candidate = folder / "scan.pending.mp4"
            for attempt in range(RETRIES + 1):
                try:
                    result = await on_daemon_thread(scan_blocking, seed_image, room.prompt, candidate, script, seed=room.seed,
                                                    progress=self.progress(world_id, path, "scan", 5, 92))
                    break
                except Exception as error:
                    delay = retry_delay(error, attempt)
                    if delay is None or attempt == RETRIES:
                        raise
                    self.store.set_job(world_id, path, "scan", progress=3,
                                       message=f"Reactor is busy ({busy_reason(error)}); retrying in {delay:.0f} s")
                    await asyncio.sleep(delay)
            for suffix in (".mp4", ".events.jsonl", ".schema.json"):
                pending = folder / f"scan.pending{suffix}"
                if pending.is_file():
                    pending.replace(folder / f"scan{suffix}")
            (folder / "scan.pending.encoder.log").unlink(missing_ok=True)
            scan = folder / "scan.mp4"
            await asyncio.to_thread(storyboard, scan, folder / "storyboard.jpg")
            if room.parent is not None and room.footage is None:
                index = result.arrival_frame if result.arrival_frame is not None else 0
                await asyncio.to_thread(lingbot.extract_frame_at, scan, index, folder / "arrival.jpg")
            receipt = {**asdict(result), "path": "scan.mp4", "seed_image": seed_image.name,
                       "seed_image_sha256": file_digest(seed_image), "created_at": now()}
            self.store.write_json(world_id, path, "scan.json", receipt)
            self.store.set_job(world_id, path, "scan", status="ready", progress=100, error=None,
                               message=f"Reactor scan ready ({result.video.get('width')}×{result.video.get('height')}, "
                                       f"{result.video.get('fps', 0):.0f} fps)")
        except Exception as error:
            self.store.set_job(world_id, path, "scan", status="failed", progress=100, message="", error=safe_error(error)[:600])
            raise

    # Physics, export and deeper rooms -----------------------------------------------------------
    def start_physics(self, world_id: str, path: str) -> None:
        room = self.store.room(world_id, path)
        if room.jobs.scan.status != "ready":
            raise ValueError("Generate this room's Reactor scan before building physics")
        if self.store.running(room.jobs.physics):
            return
        self.store.set_job(world_id, path, "physics", status="queued", progress=0, error=None, message="Waiting for Gemini")
        self.spawn(self._physics(world_id, path))

    async def _physics(self, world_id: str, path: str) -> None:
        try:
            async with self.gemini:
                self.store.set_job(world_id, path, "physics", status="generating", progress=5, message="Reconstructing")
                summary = await on_daemon_thread(reconstruct.reconstruct_room, self.store, world_id, path,
                                                 self.progress(world_id, path, "physics", 8, 95))

            def apply(world: World):
                room = world.rooms[path]
                room.physics, room.export, room.robot_demo = summary, None, None
                room.jobs.export.status, room.jobs.export.progress, room.jobs.export.message = "idle", 0, ""
                room.jobs.demo.status, room.jobs.demo.progress, room.jobs.demo.message = "idle", 0, ""
            self.store.mutate(world_id, apply)
            self.store.room_folder(world_id, path).joinpath("export.zip").unlink(missing_ok=True)
            for name in ("robot-demo.npz", "robot-demo.mp4", "robot-demo-reactor.mp4", "preview.png"):
                self.store.room_folder(world_id, path).joinpath(name).unlink(missing_ok=True)
            self.store.set_job(world_id, path, "physics", status="ready", progress=100, error=None,
                               message=f"{summary.objects} objects passed MuJoCo validation")
        except Exception as error:
            self.store.set_job(world_id, path, "physics", status="failed", progress=100, message="", error=safe_error(error)[:600])

    def start_export(self, world_id: str, path: str) -> None:
        room = self.store.room(world_id, path)
        if room.jobs.physics.status != "ready" or room.physics is None:
            raise ValueError("Build physics before exporting a MuJoCo Playground gym")
        if self.store.running(room.jobs.export):
            return
        self.store.set_job(world_id, path, "export", status="queued", progress=0, error=None, message="Waiting for the exporter")
        self.spawn(self._export(world_id, path))

    async def _export(self, world_id: str, path: str) -> None:
        try:
            async with self.exports:
                self.store.set_job(world_id, path, "export", status="generating", progress=5, message="Planning the robot layout")
                summary = await on_daemon_thread(playground_export.export_room, self.store, world_id, path,
                                                 self.progress(world_id, path, "export", 10, 96))

            def apply(world: World):
                world.rooms[path].export = summary
            self.store.mutate(world_id, apply)
            message = f"{summary.env_name} ready" if summary.feasible else "Not exportable for a Panda in this layout"
            self.store.set_job(world_id, path, "export", status="ready" if summary.feasible else "failed", progress=100,
                               message=message, error=None if summary.feasible else summary.reason)
        except Exception as error:
            self.store.set_job(world_id, path, "export", status="failed", progress=100, message="", error=safe_error(error)[:900])

    def start_children(self, world_id: str, path: str) -> None:
        room = self.store.room(world_id, path)
        if room.children:
            return
        if not self.arrival(world_id, path).is_file():
            raise ValueError("Generate this room's Reactor scan before planning deeper rooms")
        if self.store.running(room.jobs.children):
            return
        self.store.set_job(world_id, path, "children", status="queued", progress=0, error=None, message="Waiting for Gemini")
        self.spawn(self._children(world_id, path))

    async def _children(self, world_id: str, path: str) -> None:
        try:
            async with self.gemini:
                self.store.set_job(world_id, path, "children", status="generating", progress=20,
                                   message="Planning rooms from the arrival view")
                room = self.store.room(world_id, path)
                plan = await on_daemon_thread(planner.plan_children, self.arrival(world_id, path), room,
                                              self.store.room_folder(world_id, path) / "children-response.json")
            added: list[str] = []
            self.store.mutate(world_id, lambda world: added.extend(planner.add_children(world, path, plan)))
            self.store.set_job(world_id, path, "children", status="ready", progress=100, error=None,
                               message=f"{len(added)} rooms planned")
            if autoscan():
                for child in added:
                    self.enqueue_scan(world_id, child, priority=2)
        except Exception as error:
            self.store.set_job(world_id, path, "children", status="failed", progress=100, message="", error=safe_error(error)[:600])

    # Scripted robot demo, rendered by Reactor -----------------------------------------------------
    def start_demo(self, world_id: str, path: str) -> None:
        room = self.store.room(world_id, path)
        if room.jobs.physics.status != "ready":
            raise ValueError("Build physics before running the robot demo")
        if room.task.robot_task is None or not room.task.robot_task.feasible:
            raise ValueError("This room has no feasible robot task")
        if self.store.running(room.jobs.demo):
            return
        self.store.set_job(world_id, path, "demo", status="queued", progress=0, error=None, message="Waiting for the simulator")
        self.spawn(self._demo(world_id, path))

    async def _demo(self, world_id: str, path: str) -> None:
        folder = self.store.room_folder(world_id, path)
        try:
            async with self.exports:
                self.store.set_job(world_id, path, "demo", status="generating", progress=10,
                                   message="Running the scripted Panda demo in MuJoCo")

                def record():
                    sim = robot_sim.room_sim(self.store, world_id, path, width=1280, height=704)
                    try:
                        return robot_sim.record_demo(sim, folder / "robot-demo.mp4")
                    finally:
                        sim.close()
                outcome = await on_daemon_thread(record)
            summary = DemoSummary(**outcome)
            room = self.store.room(world_id, path)
            if os.environ.get("REACTOR_API_KEY"):
                prompt = robot_sim.demo_prompt(room, room.task)
                for attempt in range(RETRIES + 1):
                    self.store.set_job(world_id, path, "demo", progress=55,
                                       message="Rendering the demo with Reactor video-to-video")
                    try:
                        result = await on_daemon_thread(lambda: asyncio.run(generate_video(
                            folder / "robot-demo.mp4", folder / "robot-demo-reactor.mp4", prompt, seed=room.seed,
                            progress=self.progress(world_id, path, "demo", 60, 95))))
                        summary.reactor, summary.reactor_session_id = True, result.session_id
                        break
                    except Exception as error:
                        delay = retry_delay(error, attempt)
                        if delay is None or attempt == RETRIES:
                            summary.reactor_error = safe_error(error)[:300]
                            break
                        self.store.set_job(world_id, path, "demo", message=f"Reactor is busy; retrying in {delay:.0f} s")
                        await asyncio.sleep(delay)

            def apply(world: World):
                world.rooms[path].robot_demo = summary
            self.store.mutate(world_id, apply)
            message = (f"Demo {'completed' if summary.success else 'reached'} {summary.steps_completed}/{summary.total_steps} steps"
                       + (" · Reactor render ready" if summary.reactor else ""))
            self.store.set_job(world_id, path, "demo", status="ready", progress=100, error=None, message=message)
        except Exception as error:
            self.store.set_job(world_id, path, "demo", status="failed", progress=100, message="", error=safe_error(error)[:600])
