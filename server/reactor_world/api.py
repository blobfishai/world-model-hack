"""HTTP API for Reactor worlds, mounted on the rooms-server at /worlds (proxied by Next.js at /api/worlds)."""
from __future__ import annotations

import os
import time
from importlib.util import find_spec
from pathlib import Path
from uuid import uuid4

import asyncio
from concurrent.futures import ThreadPoolExecutor

import anyio
from fastapi import APIRouter, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from pydantic import Field

from room_sim.physics import PhysicsSession
from room_sim.schema import StrictModel

from task_rooms.config import safe_error

from dataclasses import asdict

from . import lab, robot_sim
from .jobs import WorldJobs
from .tasks import program
from .playground_export import ExportError
from .schema import World, WorldRoom, WorldRoomSpec
from .sources import ATTRIBUTION, extract_frame, list_sources, resolve_source
from .store import WorldStore
from .room_import import import_robot_room

MEDIA = {"arrival": ("arrival.jpg", "image/jpeg"), "scan": ("scan.mp4", "video/mp4"),
         "storyboard": ("storyboard.jpg", "image/jpeg"), "preview": ("preview.png", "image/png"),
         "demo": ("robot-demo.mp4", "video/mp4"), "demo_reactor": ("robot-demo-reactor.mp4", "video/mp4")}
ROBOT_COMMANDS = {"move", "gripper", "reset", "demo", "stop"}


class CreateWorld(StrictModel):
    source: str = Field(pattern=r"^[0-9]{1,6}$")
    t: float = Field(default=0, ge=0, le=3600)


class ImportRobotRoom(StrictModel):
    path: str = Field(pattern=r"^(root|[0-9](\.[0-9]){0,11})$")


def require_key(name: str, purpose: str) -> None:
    if not os.environ.get(name):
        raise HTTPException(503, f"Set {name} in .env to {purpose}")


def install_reactor_world(app, sessions: dict, root: Path | None = None, origins: list[str] | None = None) -> WorldJobs:
    store = WorldStore(root)
    robots: dict[str, dict] = {}
    store.recover_interrupted()
    jobs = WorldJobs(store)
    app.state.reactor_worlds = jobs
    router = APIRouter(prefix="/worlds")

    def room_view(world: World, room: WorldRoom) -> dict:
        data = room.model_dump(mode="json")
        # The step program checked in simulation (and in the exported gym); the client renders it as the checklist.
        data["steps"] = [{**asdict(step), "done": False, "current": index == 0} for index, step in enumerate(program(room.task))]
        folder = store.room_path(world.id, room.path)
        base = f"/api/worlds/{world.id}/rooms/{room.path}"
        media = {}
        for name, (file, _) in MEDIA.items():
            target = folder / file
            media[name] = f"{base}/media/{name}?v={target.stat().st_mtime_ns}" if target.is_file() else None
        data["media"] = media
        if data["export"] is not None:
            ready = room.export.feasible and (folder / "export.zip").is_file()
            data["export"]["download_url"] = f"{base}/playground/download" if ready else None
        return data

    def world_view(world: World) -> dict:
        data = world.model_dump(mode="json")
        start = store.folder(world.id) / "start.jpg"
        data["start_url"] = f"/api/worlds/{world.id}/rooms/root/media/start?v={start.stat().st_mtime_ns}" if start.is_file() else None
        data["rooms"] = {path: room_view(world, room) for path, room in world.rooms.items()}
        return data

    def load(world_id: str) -> World:
        try:
            return store.require(world_id)
        except KeyError as error:
            raise HTTPException(404, "Unknown world") from error

    def room_of(world_id: str, path: str) -> tuple[World, WorldRoom]:
        world = load(world_id)
        if path not in world.rooms:
            raise HTTPException(404, "Unknown room")
        return world, world.rooms[path]

    def started(world_id: str, path: str, start) -> dict:
        try:
            start(world_id, path)
        except KeyError as error:
            raise HTTPException(404, str(error).strip("'")) from error
        except ValueError as error:
            raise HTTPException(409, str(error)) from error
        world, room = room_of(world_id, path)
        return room_view(world, room)

    @router.get("/sources")
    def sources():
        return {"sources": list_sources(), "attribution": ATTRIBUTION,
                "reactor_configured": bool(os.environ.get("REACTOR_API_KEY")),
                "planner_configured": bool(os.environ.get("GOOGLE_API_KEY")),
                "playground_available": find_spec("mujoco_playground") is not None}

    @router.get("/sources/{source_id}/frame")
    def frame(source_id: str, t: float = Query(default=0, ge=0, le=3600), w: int | None = Query(default=None, ge=64, le=1664)):
        try:
            path, source = resolve_source(source_id)
        except KeyError as error:
            raise HTTPException(404, "Unknown start video") from error
        moment = round(min(t, max(0., source["duration"] - .1)), 2)
        cache = store.root / "frames" / f"{source_id}-{moment:.2f}-{w or 'seed'}.jpg"
        if not cache.is_file():
            try:
                extract_frame(path, moment, cache, w)
            except (ValueError, OSError) as error:
                raise HTTPException(422, str(error)) from error
        return FileResponse(cache, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=3600"})

    @router.get("/sources/{source_id}/video")
    def source_video(source_id: str):
        try:
            path, _ = resolve_source(source_id)
        except KeyError as error:
            raise HTTPException(404, "Unknown source recording") from error
        return FileResponse(path, media_type="video/mp4")

    @router.get("/catalog")
    def task_catalog():
        return {**lab.catalog(store, room_view), "sources": list_sources(), "attribution": ATTRIBUTION}

    @router.get("")
    def worlds():
        return [{"id": w.id, "hub_title": w.hub_title, "status": w.status, "source": w.source.model_dump(),
                 "rooms": len(w.rooms), "created_at": w.created_at} for w in store.worlds()]

    @router.post("/from-room")
    def from_room(body: ImportRobotRoom):
        try:
            return world_view(import_robot_room(store, body.path))
        except (ValueError, FileNotFoundError) as error:
            raise HTTPException(422, str(error)) from error

    @router.post("", status_code=202)
    async def create(body: CreateWorld):
        require_key("GOOGLE_API_KEY", "plan rooms and tasks from the beginning image")
        try:
            world = jobs.create_world(body.source, body.t)
        except KeyError as error:
            raise HTTPException(404, "Unknown start video") from error
        except ValueError as error:
            raise HTTPException(422, str(error)) from error
        return world_view(world)

    @router.get("/{world_id}")
    def world(world_id: str):
        return world_view(load(world_id))

    @router.post("/{world_id}/rooms/{path}/scan", status_code=202)
    async def scan(world_id: str, path: str, priority: int = Query(default=0, ge=0, le=1)):
        require_key("REACTOR_API_KEY", "generate rooms with Reactor LingBot World 2")
        return started(world_id, path, lambda w, p: jobs.enqueue_scan(w, p, priority=0 if priority else 1))

    @router.post("/{world_id}/rooms/{path}/children", status_code=202)
    async def children(world_id: str, path: str):
        require_key("GOOGLE_API_KEY", "plan deeper rooms")
        return started(world_id, path, jobs.start_children)

    @router.post("/{world_id}/rooms/{path}/physics", status_code=202)
    async def physics(world_id: str, path: str):
        require_key("GOOGLE_API_KEY", "reconstruct room physics from the Reactor scan")
        return started(world_id, path, jobs.start_physics)

    @router.post("/{world_id}/rooms/{path}/build", status_code=202)
    async def build_task(world_id: str, path: str):
        started(world_id, path, lambda w, p: lab.start_build(jobs, w, p))
        return lab.build_status(store, world_id, path)

    @router.post("/{world_id}/rooms/{path}/playground", status_code=202)
    async def playground(world_id: str, path: str):
        return started(world_id, path, jobs.start_export)

    @router.get("/{world_id}/rooms/{path}/playground/download")
    def download(world_id: str, path: str):
        world, room = room_of(world_id, path)
        archive = store.room_path(world_id, path) / "export.zip"
        if room.export is None or not room.export.feasible or not archive.is_file():
            raise HTTPException(404, "Export this room to MuJoCo Playground first")
        return FileResponse(archive, media_type="application/zip", filename=f"{room.export.env_name}.zip")

    @router.get("/{world_id}/rooms/{path}/media/{asset}")
    def media(world_id: str, path: str, asset: str):
        room_of(world_id, path)
        if asset == "start":
            target, kind = store.folder(world_id) / "start.jpg", "image/jpeg"
        elif asset in MEDIA:
            file, kind = MEDIA[asset]
            target = store.room_path(world_id, path) / file
        else:
            raise HTTPException(404, "Unknown asset")
        if not target.is_file():
            raise HTTPException(404, "This asset is not ready")
        return FileResponse(target, media_type=kind)

    @router.post("/{world_id}/rooms/{path}/sessions", status_code=201)
    def physics_session(world_id: str, path: str):
        room_of(world_id, path)
        scene = store.read_json(world_id, path, "scene.json")
        if scene is None:
            raise HTTPException(409, "Build physics for this room first")
        for key, entry in list(sessions.items()):
            if not entry["attached"] and time.monotonic() - entry["created"] > 60:
                sessions.pop(key, None)
        if len(sessions) >= 8:
            raise HTTPException(409, "Close another room session before opening one")
        spec = WorldRoomSpec.model_validate(scene["spec"])
        session = PhysicsSession(spec)
        identifier = uuid4().hex
        # The rooms-server WebSocket at /sessions/{id} serves this session like any other room.
        sessions[identifier] = {"physics": session, "room": spec.room_id, "attached": False, "created": time.monotonic()}
        return {"id": identifier, "revision": scene["revision"], "geoms": session.geoms, "state": session.state(),
                "spec": scene["spec"], "goal": scene.get("goal")}

    @router.post("/{world_id}/rooms/{path}/demo", status_code=202)
    async def demo(world_id: str, path: str):
        return started(world_id, path, jobs.start_demo)

    # Interactive robot simulation: the exported Panda scene, driven from the browser over a WebSocket.
    def close_robot(identifier: str) -> None:
        entry = robots.pop(identifier, None)
        if entry:
            entry["executor"].submit(entry["sim"].close)
            entry["executor"].shutdown(wait=False)

    @router.post("/{world_id}/rooms/{path}/robot", status_code=201)
    async def robot_session(world_id: str, path: str):
        world, room = room_of(world_id, path)
        for identifier, entry in list(robots.items()):
            if not entry["attached"] and time.monotonic() - entry["created"] > 60:
                close_robot(identifier)
        if len(robots) >= 4:
            raise HTTPException(409, "Close another robot simulation before opening one")
        executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="robot-sim")
        try:
            # The renderer's GL context is created and used on this session's single worker thread.
            sim = await asyncio.get_running_loop().run_in_executor(executor, robot_sim.room_sim, store, world_id, path)
        except (ValueError, ExportError) as error:
            executor.shutdown(wait=False)
            raise HTTPException(409, str(error)) from error
        identifier = uuid4().hex
        robots[identifier] = {"sim": sim, "executor": executor, "attached": False, "created": time.monotonic()}
        return {"id": identifier, "width": sim.width, "height": sim.height, "fps": robot_sim.CONTROL_HZ,
                "kind": sim.kind, "state": sim.state(),
                "layout": {"spawn": sim.layout.spawn, "goal": sim.layout.goal, "support": sim.layout.support.id,
                           "object": sim.layout.target.id, "base_side": sim.layout.side}}

    @router.delete("/robot-sessions/{identifier}")
    def close_robot_session(identifier: str):
        close_robot(identifier)
        return {"closed": True}

    @router.websocket("/robot-sessions/{identifier}")
    async def robot_socket(ws: WebSocket, identifier: str):
        entry = robots.get(identifier)
        if entry is None or entry["attached"] or ws.headers.get("origin") not in [None, *(origins or [])]:
            await ws.close(code=1008)
            return
        entry["attached"] = True
        sim, executor = entry["sim"], entry["executor"]
        loop = asyncio.get_running_loop()
        await ws.accept()
        lock = asyncio.Lock()

        def frame():
            sim.tick()
            return sim.render(), sim.state()

        async def receive():
            while True:
                message = await ws.receive_json()
                try:
                    if not isinstance(message, dict) or message.get("type") not in ROBOT_COMMANDS:
                        raise ValueError("Unknown robot command")
                    await loop.run_in_executor(executor, sim.command, message)
                except (ValueError, TypeError) as error:
                    async with lock:
                        await ws.send_json({"type": "error", "error": safe_error(error)[:300]})

        async def publish():
            started_at, count = loop.time(), 0
            while loop.time() - started_at < 900:
                image, state = await loop.run_in_executor(executor, frame)
                async with lock:
                    await ws.send_bytes(image)
                    await ws.send_json(state)
                count += 1
                await asyncio.sleep(max(0, started_at + count / robot_sim.CONTROL_HZ - loop.time()))
            async with lock:
                await ws.send_json({"type": "closed", "error": "The robot simulation ended after 15 minutes; start it again"})

        reader, writer = asyncio.create_task(receive()), asyncio.create_task(publish())
        try:
            done, _ = await asyncio.wait({reader, writer}, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
        except (WebSocketDisconnect, RuntimeError, asyncio.CancelledError):
            pass
        finally:
            reader.cancel()
            writer.cancel()
            with anyio.CancelScope(shield=True):
                await asyncio.gather(reader, writer, return_exceptions=True)
                close_robot(identifier)
                try:
                    await ws.close()
                except (RuntimeError, WebSocketDisconnect):
                    pass

    app.include_router(router)
    return jobs
