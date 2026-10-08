from __future__ import annotations

import asyncio
import json
import os
import shutil
import tempfile
import time
from contextlib import asynccontextmanager
from pathlib import Path
from uuid import uuid4

import uvicorn
import anyio
from fastapi import FastAPI, File, Form, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import ValidationError
from starlette.background import BackgroundTask

from task_rooms.config import configure, runtime_root, safe_error

from .builds import RoomStore, atomic_json, run_build
from .compiler import compile_room, validate_physics
from .physics import PhysicsSession
from .schema import Interaction, RoomSpec
from .templates import ROOMS
from .gym_bundle import export_bundle, room_references
from .gym_env import RoomRobotEnv
from .world_api import world_router
from .playground import install_playground
from .worlds import install_worlds
from reactor_world.api import install_reactor_world


def create_app(root: Path | None = None):
    configure()
    store = RoomStore(root)
    sessions: dict[str, dict] = {}
    world_sessions: dict[str, dict] = {}
    builds: set[asyncio.Task] = set()
    origins = [f"http://{host}:{port}" for host in ("127.0.0.1", "localhost") for port in (3000, 3001, 3002, 3003)]
    origins += [origin for origin in os.environ.get("ROOM_SIM_EXTRA_ORIGINS", "").split(",") if origin]

    @asynccontextmanager
    async def lifespan(app):
        store.recover_interrupted()
        yield
        for task in builds:
            task.cancel()
        await asyncio.gather(*builds, return_exceptions=True)
        sessions.clear()
        for entry in world_sessions.values():
            entry["world"].physics.valid = False
        world_sessions.clear()
        app.state.playground.close()
        app.state.robot_worlds.close()

    app = FastAPI(title="Room simulation", lifespan=lifespan)
    app.add_middleware(CORSMiddleware, allow_origins=origins, allow_methods=["GET", "POST", "PUT", "DELETE"], allow_headers=["Content-Type"])
    app.state.store = store
    app.state.sessions = sessions
    app.state.world_sessions = world_sessions
    app.include_router(world_router(world_sessions, origins))
    install_playground(app, store)
    install_worlds(app)
    # Reactor LingBot World 2 worlds share this process's physics sessions and /sessions WebSocket.
    install_reactor_world(app, sessions, root / "reactor-worlds" if root else None, origins)

    def get_room(room):
        if room not in ROOMS:
            raise HTTPException(404, "Unknown room")
        with store.lock:
            return store.get(room)

    def invalidate(room):
        for entry in list(sessions.values()):
            if entry["room"] == room:
                entry["physics"].valid = False

    @app.get("/health")
    def health():
        return {"ok": True, "reconstruction_configured": bool(os.environ.get("GOOGLE_API_KEY"))}

    @app.get("/rooms")
    def rooms():
        return [{"id": room, "name": title, "description": description, "color": color,
                 "source": "video" if get_room(room)["source_job"] else "example",
                 "objects": len(get_room(room)["spec"]["objects"])}
                for room, (title, description, color) in ROOMS.items()]

    @app.get("/rooms/{room}")
    def room_detail(room: str):
        data = get_room(room)
        jobs = [j for j in store.jobs.values() if j["room_id"] == room]
        return {**data, "latest_build": max(jobs, key=lambda j: j["created_at"]) if jobs else None}

    @app.get("/rooms/{room}/gym")
    def robot_tasks(room: str):
        scene = get_room(room)
        try:
            with RoomRobotEnv(spec=scene["spec"]) as env:
                env.reset(seed=42)
                return {"revision": scene["revision"], "tasks": env.tasks,
                        "robot": "Cartesian gripper", "control_hz": 20,
                        "source": "video" if scene.get("source_job") else "example_or_manual"}
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc

    @app.post("/rooms/{room}/gym")
    def robot_export(room: str, revision: str, task: str | None = None):
        scene = get_room(room)
        if scene["revision"] != revision:
            raise HTTPException(409, "The room changed; reload it before exporting the robot gym")
        folder = Path(tempfile.mkdtemp(prefix="room-gym-"))
        try:
            references = room_references(store.root, scene, runtime_root() / "probes")
            export_bundle(scene, folder / f"{room}-gym", references, task=task)
            archive = shutil.make_archive(str(folder / f"{room}-gym"), "zip", folder, f"{room}-gym")
            return FileResponse(archive, media_type="application/zip", filename=f"{room}-robot-gym.zip",
                                background=BackgroundTask(shutil.rmtree, folder))
        except ValueError as exc:
            shutil.rmtree(folder, ignore_errors=True)
            raise HTTPException(422, str(exc)) from exc
        except BaseException:
            shutil.rmtree(folder, ignore_errors=True)
            raise

    @app.put("/rooms/{room}/scene")
    def edit_scene(room: str, spec: RoomSpec, source_job: str | None = None):
        existing = get_room(room)
        if spec.room_id != room:
            raise HTTPException(422, "Scene room_id must match the selected room")
        validation = validate_physics(compile_room(spec))
        if not validation["valid"]:
            raise HTTPException(422, "; ".join(validation["errors"]))
        with store.lock:
            if any(j["room_id"] == room and j["status"] not in {"ready", "needs_review", "failed"} for j in store.jobs.values()):
                raise HTTPException(409, "Wait for reconstruction to finish before editing")
            if source_job and (source_job not in store.jobs or store.jobs[source_job]["room_id"] != room):
                raise HTTPException(422, "Source build must belong to this room")
            data = store.save(room, spec, validation, source_job or existing["source_job"])
            invalidate(room)
            if source_job:
                store.update_job(store.jobs[source_job], status="ready", progress=100, error=None, validation=validation)
        return data

    @app.post("/rooms/{room}/build", status_code=202)
    async def build(room: str, video: UploadFile = File(...), reference: str = Form(default="", max_length=500)):
        get_room(room)
        if not os.environ.get("GOOGLE_API_KEY"):
            raise HTTPException(503, "Set GOOGLE_API_KEY in .env to reconstruct room videos")
        try:
            job = store.new_job(room)
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc
        folder = store.root / "builds" / job["id"]
        source = folder / "source.mp4"
        try:
            total = 0
            with source.open("wb") as output:
                while chunk := await video.read(1024 * 1024):
                    total += len(chunk)
                    if total > 100 * 1024 * 1024:
                        raise HTTPException(413, "Video exceeds the 100 MB limit")
                    output.write(chunk)
            if not total:
                raise HTTPException(422, "Choose a nonempty video")
            store.update_job(job, status="queued", filename=Path(video.filename or "room-video.mp4").name)
            task = asyncio.create_task(asyncio.to_thread(run_build, store, job, source, reference, invalidate))
            builds.add(task)
            task.add_done_callback(builds.discard)
            return dict(job)
        except BaseException as exc:
            store.update_job(job, status="failed", error=safe_error(exc), progress=100)
            raise
        finally:
            await video.close()

    @app.get("/room-builds/{job_id}")
    def build_status(job_id: str):
        with store.lock:
            if job_id not in store.jobs:
                raise HTTPException(404, "Unknown build")
            return dict(store.jobs[job_id])

    @app.get("/room-builds/{job_id}/frames/{frame}")
    def evidence_frame(job_id: str, frame: str):
        job = build_status(job_id)
        if frame not in {f["file"] for f in job["frames"]}:
            raise HTTPException(404, "Unknown evidence frame")
        return FileResponse(store.root / "builds" / job_id / "frames" / frame, media_type="image/jpeg")

    @app.get("/room-builds/{job_id}/source")
    def source_video(job_id: str):
        build_status(job_id)
        return FileResponse(store.root / "builds" / job_id / "source.mp4")

    @app.post("/rooms/{room}/sessions", status_code=201)
    def session(room: str):
        # Serialize with scene commits so a new session cannot capture a stale revision.
        with store.lock:
            for key, entry in list(sessions.items()):
                if not entry["attached"] and time.monotonic() - entry["created"] > 60:
                    sessions.pop(key, None)
            if len(sessions) >= 8:
                raise HTTPException(409, "Close another room session before opening one")
            data = get_room(room)
            physics = PhysicsSession(RoomSpec.model_validate(data["spec"]))
            session_id = uuid4().hex
            sessions[session_id] = {"physics": physics, "room": room, "attached": False, "created": time.monotonic()}
            return {"id": session_id, "revision": data["revision"], "geoms": physics.geoms,
                    "state": physics.state(), "spec": data["spec"]}

    def discard(session_id):
        entry = sessions.pop(session_id, None)
        if entry:
            physics = entry["physics"]
            physics.valid = False
            if physics.log:
                atomic_json(store.root / "replays" / f"{session_id}.json",
                            {"spec": physics.spec.model_dump(), "mujoco_version": "3.15.0", "timestep": .002,
                             "initial_qpos": physics.initial.tolist(), "end_tick": physics.tick, "commands": physics.log})

    @app.delete("/sessions/{session_id}")
    def close_session(session_id: str):
        discard(session_id)
        return {"closed": True}

    @app.websocket("/sessions/{session_id}")
    async def socket(ws: WebSocket, session_id: str):
        entry = sessions.get(session_id)
        if ws.headers.get("origin") not in [None, *origins] or not entry or entry["attached"]:
            await ws.close(code=1008)
            return
        entry["attached"] = True
        physics = entry["physics"]
        await ws.accept()
        send_lock = asyncio.Lock()

        async def send(data):
            async with send_lock:
                await ws.send_json(data)

        async def receive():
            while True:
                try:
                    data = await ws.receive_json()
                    physics.command(Interaction.model_validate(data))
                    await send(physics.state())
                except (ValueError, ValidationError) as exc:
                    await send({"type": "error", "error": safe_error(exc)[:1000]})

        async def publish():
            frame = 0
            started = asyncio.get_running_loop().time()
            while physics.valid:
                physics.advance(16 if frame % 3 == 0 else 17)
                await send(physics.state())
                frame += 1
                if asyncio.get_running_loop().time() - started > 600:
                    break
                await asyncio.sleep(max(0, started + frame / 30 - asyncio.get_running_loop().time()))
            await send({"type": "closed", "error": "Room changed or the session ended; reopen the simulation"})

        reader, writer = asyncio.create_task(receive()), asyncio.create_task(publish())
        try:
            done, _ = await asyncio.wait({reader, writer}, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
        except (WebSocketDisconnect, RuntimeError):
            pass
        except asyncio.CancelledError:
            pass
        except Exception as exc:
            try:
                await send({"type": "error", "error": safe_error(exc)})
            except RuntimeError:
                pass
        finally:
            reader.cancel(); writer.cancel()
            with anyio.CancelScope(shield=True):
                await asyncio.gather(reader, writer, return_exceptions=True)
                discard(session_id)
                try:
                    await ws.close()
                except (RuntimeError, WebSocketDisconnect):
                    pass

    return app


app = create_app()


def main():
    uvicorn.run("room_sim.api:app", host="127.0.0.1", port=int(os.environ.get("ROOM_SIM_PORT", "8000")))
