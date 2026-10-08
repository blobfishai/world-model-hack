"""A catalog and resumable build pipeline for footage-derived robot tasks."""
from __future__ import annotations

import os

from task_rooms.config import safe_error

from .store import ACTIVE, now, pid_alive
from .task_kernel import CONTRACT_VERSION


def build_status(store, world_id: str, path: str) -> dict:
    state = store.read_json(world_id, path, "build.json") or {"status": "idle", "progress": 0, "message": "", "error": None}
    if state["status"] in ACTIVE and not pid_alive(state.get("owner")):
        return {**state, "status": "failed", "error": "Build interrupted. Resume to keep the completed stages."}
    return {k: v for k, v in state.items() if k != "owner"}


def training_ready(store, world_id: str, room) -> bool:
    checks = room.export.checks if room.export and room.export.checks else {}
    return bool(room.export and room.export.feasible and checks.get("passed") is True
                and checks.get("replay_passed") is True and checks.get("task_contract") == CONTRACT_VERSION
                and (store.room_path(world_id, room.path) / "export.zip").is_file())


def task_title(task) -> str:
    robot = task.robot_task
    if robot is None:
        return task.title
    names = {item.id: item.label for item in task.objects}
    item = names.get(robot.object, robot.object.replace("_", " "))
    if robot.kind == "lift":
        return f"Lift {item}"
    anchor = names.get(robot.anchor, (robot.anchor or "target").replace("_", " "))
    return f"Place {item} {robot.relation or 'beside'} {anchor}"


def catalog(store, room_view) -> dict:
    tasks, worlds = [], []
    for world in store.worlds():
        if world.planner.get("version", 1) < 2:
            continue  # Old capability probes aren't task-library releases.
        worlds.append({"id": world.id, "title": world.hub_title, "status": world.status, "error": world.error,
                       "created_at": world.created_at, "source": world.source.model_dump(mode="json")})
        for room in world.rooms.values():
            source = ({"id": room.footage.source_id, "file": room.footage.file, "t": room.footage.t,
                       "task_type": room.footage.task_type} if room.footage else world.source.model_dump(mode="json"))
            robot = room.task.robot_task
            tasks.append({"id": f"{world.id}:{room.path}", "world_id": world.id, "world_title": world.hub_title,
                          "title": task_title(room.task), "room": room_view(world, room), "source": source,
                          "grounding": "source_frame" if room.footage or room.path == "root" else "generated_variation",
                          "build": build_status(store, world.id, room.path),
                          "simulation_ready": bool(robot and robot.feasible and room.physics and room.physics.valid
                                                   and room.jobs.physics.status == "ready"
                                                   and (store.room_path(world.id, room.path) / "scene.json").is_file()),
                          "training_ready": training_ready(store, world.id, room)})
    tasks.sort(key=lambda task: (not task["training_ready"], not task["simulation_ready"],
                                 task["grounding"] != "source_frame", task["world_id"], task["room"]["path"]))
    return {"tasks": tasks, "worlds": worlds, "task_contract": CONTRACT_VERSION}


def start_build(jobs, world_id: str, path: str) -> None:
    store = jobs.store
    room = store.room(world_id, path)
    if build_status(store, world_id, path)["status"] in ACTIVE:
        return
    if not room.task.robot_task or not room.task.robot_task.feasible:
        raise ValueError("This footage task has no feasible rigid-object Panda subtask")
    if room.jobs.scan.status != "ready":
        raise ValueError("Generate the Reactor walkthrough first, then build this gym")
    if any(store.running(getattr(room.jobs, name)) for name in ("physics", "demo", "export")):
        raise ValueError("A task stage is already running. Build the gym when it finishes.")
    if room.jobs.physics.status != "ready" and not os.environ.get("GOOGLE_API_KEY"):
        raise ValueError("Configure GOOGLE_API_KEY to reconstruct the Reactor walkthrough")
    if training_ready(store, world_id, room):
        return
    store.write_json(world_id, path, "build.json", {"status": "queued", "progress": 0, "message": "Preparing task",
                                                  "error": None, "owner": os.getpid(), "updated_at": now()})
    jobs.spawn(_build(jobs, world_id, path))


async def _build(jobs, world_id: str, path: str) -> None:
    store = jobs.store

    def update(status, progress, message, error=None):
        store.write_json(world_id, path, "build.json", {"status": status, "progress": progress,
                         "message": message, "error": error, "owner": os.getpid() if status in ACTIVE else None,
                         "updated_at": now()})

    def require(stage):
        job = getattr(store.room(world_id, path).jobs, stage)
        if job.status != "ready":
            raise ValueError(job.error or f"The {stage} stage could not finish")

    try:
        update("generating", 10, "Reconstructing the Reactor world for MuJoCo")
        room = store.room(world_id, path)
        if room.jobs.physics.status != "ready" or not room.physics or not room.physics.valid:
            await jobs._physics(world_id, path)
        require("physics")
        update("generating", 40, "Solving the Panda task and rendering it with Reactor")
        room = store.room(world_id, path)
        folder = store.room_path(world_id, path)
        if not room.robot_demo or not room.robot_demo.success or not (folder / "robot-demo.npz").is_file():
            await jobs._demo(world_id, path)
        require("demo")
        room = store.room(world_id, path)
        if not room.robot_demo or not room.robot_demo.success:
            raise ValueError("The scripted robot could not complete this layout. Review the simulation before training.")
        update("generating", 75, "Validating rewards, resets and the demonstration in MJX")
        if not training_ready(store, world_id, room):
            await jobs._export(world_id, path)
        require("export")
        if not training_ready(store, world_id, store.room(world_id, path)):
            raise ValueError("MJX could not replay the complete task. The simulation is available for review.")
        update("ready", 100, "Native demo and MJX replay passed. Training bundle ready.")
    except Exception as error:
        update("failed", 100, "", safe_error(error)[:700])
