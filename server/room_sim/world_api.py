from __future__ import annotations

import asyncio
import time
from uuid import uuid4

import anyio
from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import ValidationError

from task_rooms.config import safe_error
from .world import TaskWorldSession, compile_world
from .world_media import ATTRIBUTION, media_status
from .world_schema import WorldCommand


def world_router(sessions: dict, origins: list[str]):
    router = APIRouter(prefix="/task-world")

    @router.get("")
    def catalog():
        _, spec = compile_world()
        return {"spec": spec.model_dump(), "media": media_status(), "attribution": ATTRIBUTION}

    @router.post("/sessions", status_code=201)
    async def create():
        for id, entry in list(sessions.items()):
            if not entry["attached"] and time.monotonic() - entry["created"] > 60: sessions.pop(id, None)
        if len(sessions) >= 8: raise HTTPException(409, "Close another playable world before opening one")
        # Keep creation and attachment on the event loop so capacity and cleanup are atomic.
        session = TaskWorldSession()
        id = uuid4().hex
        sessions[id] = {"world": session, "created": time.monotonic(), "attached": False}
        return {"id": id, "geoms": session.physics.geoms, "state": session.state(), "spec": session.spec.model_dump()}

    @router.delete("/sessions/{id}")
    async def close(id: str):
        entry = sessions.pop(id, None)
        if entry: entry["world"].physics.valid = False
        return {"closed": True}

    @router.websocket("/sessions/{id}")
    async def socket(ws: WebSocket, id: str):
        entry = sessions.get(id)
        if not entry or entry["attached"] or ws.headers.get("origin") not in [None, *origins]:
            await ws.close(code=1008)
            return
        entry["attached"] = True
        world = entry["world"]
        await ws.accept()
        lock = asyncio.Lock()

        async def send(data):
            async with lock: await ws.send_json(data)

        async def receive():
            while True:
                try:
                    world.command(WorldCommand.model_validate(await ws.receive_json()))
                    await send(world.state())
                except (ValueError, ValidationError) as exc:
                    await send({"type": "error", "error": safe_error(exc)[:600]})

        async def publish():
            frame = 0
            started = time.monotonic()
            while world.physics.valid and time.monotonic() - started < 1800:
                world.advance(16 if frame % 3 == 0 else 17)
                await send(world.state())
                frame += 1
                await asyncio.sleep(max(.001, started + frame / 30 - time.monotonic()))
            await send({"type": "closed", "error": "This session has ended. Reconnect to start a new world."})

        reader, writer = asyncio.create_task(receive()), asyncio.create_task(publish())
        try:
            done, _ = await asyncio.wait([reader, writer], return_when=asyncio.FIRST_COMPLETED)
            for task in done: task.result()
        except (WebSocketDisconnect, RuntimeError, asyncio.CancelledError):
            pass
        except Exception as exc:
            try: await send({"type": "error", "error": safe_error(exc)})
            except RuntimeError: pass
        finally:
            reader.cancel(); writer.cancel()
            with anyio.CancelScope(shield=True):
                await asyncio.gather(reader, writer, return_exceptions=True)
                world.physics.valid = False
                sessions.pop(id, None)
                try: await ws.close()
                except (RuntimeError, WebSocketDisconnect): pass

    return router
