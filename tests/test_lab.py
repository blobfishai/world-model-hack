import asyncio
from types import SimpleNamespace

import pytest

from reactor_world import lab, planner
from reactor_world.schema import DemoSummary, ExportSummary, PhysicsSummary, SourceRef
from reactor_world.store import WorldStore
from reactor_world_fixtures import hub_plan


def world_store(tmp_path):
    store = WorldStore(tmp_path)
    world = planner.build_world("0123456789abcdef", SourceRef(id="3", file="data/000/3_video.mp4", t=1), hub_plan())
    store.save(world)
    store.set_job(world.id, "0", "scan", status="ready")
    return store, world.id


def test_catalog_separates_rendered_appearance_from_verified_training(tmp_path):
    store, identifier = world_store(tmp_path)
    room = store.room(identifier, "0")
    room.export = ExportSummary(feasible=True, checks={"passed": True, "replay_passed": True, "task_contract": 1})
    (store.room_folder(identifier, "0") / "export.zip").write_bytes(b"bundle")
    assert not lab.training_ready(store, identifier, room)
    room.export.checks["task_contract"] = 2
    assert lab.training_ready(store, identifier, room)
    room.export.checks["replay_passed"] = False
    assert not lab.training_ready(store, identifier, room)


@pytest.mark.parametrize("solved", [True, False])
def test_build_orders_stages_and_never_verifies_an_unsolved_demo(tmp_path, monkeypatch, solved):
    store, identifier = world_store(tmp_path)
    monkeypatch.setenv("GOOGLE_API_KEY", "test")
    calls, tasks = [], []

    async def stage(name, w, p):
        calls.append(name)
        def update(world):
            room = world.rooms[p]
            if name == "physics":
                room.physics = PhysicsSummary(valid=True, revision="test", objects=3)
            elif name == "demo":
                room.robot_demo = DemoSummary(success=solved, steps_completed=6 if solved else 2, total_steps=6, seconds=10)
            else:
                room.export = ExportSummary(feasible=True, checks={"passed": True, "replay_passed": True, "task_contract": 2})
                (store.room_folder(w, p) / "export.zip").write_bytes(b"bundle")
        store.mutate(w, update)
        store.set_job(w, p, name, status="ready")

    async def run():
        jobs = SimpleNamespace(store=store, spawn=lambda coroutine: tasks.append(asyncio.create_task(coroutine)),
                               _physics=lambda w, p: stage("physics", w, p), _demo=lambda w, p: stage("demo", w, p),
                               _export=lambda w, p: stage("export", w, p))
        lab.start_build(jobs, identifier, "0")
        lab.start_build(jobs, identifier, "0")  # double click cannot enqueue a duplicate pipeline
        assert len(tasks) == 1
        await asyncio.gather(*tasks)
    asyncio.run(run())
    assert calls == (["physics", "demo", "export"] if solved else ["physics", "demo"])
    state = lab.build_status(store, identifier, "0")
    assert state["status"] == ("ready" if solved else "failed")
    if not solved:
        assert "could not complete" in state["error"]


def test_stale_build_is_resumable_without_losing_completed_artifacts(tmp_path):
    store, identifier = world_store(tmp_path)
    store.write_json(identifier, "0", "build.json", {"status": "generating", "owner": None, "progress": 40})
    assert lab.build_status(store, identifier, "0")["status"] == "failed"
    assert store.room(identifier, "0").jobs.scan.status == "ready"
