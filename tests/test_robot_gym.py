from __future__ import annotations

import io
import json
import subprocess
import sys
import zipfile

import gymnasium as gym
import mujoco
import numpy as np
import pytest
from fastapi.testclient import TestClient
from gymnasium.utils.env_checker import check_env

from room_sim.api import create_app
from room_sim.gym_bundle import export_bundle, room_references, verify_bundle
from room_sim.gym_env import RoomRobotEnv
from room_sim.templates import ROOMS, example_room


@pytest.mark.parametrize("room", ROOMS)
def test_gym_contract_and_robot_reaches_in_each_room(room):
    with RoomRobotEnv(spec=example_room(room)) as env:
        env.reset(seed=17)
        np.testing.assert_allclose(env.data.site_xpos[env.goal_site], env.goal)
        check_env(env, skip_render_check=True)
        observation, _ = env.reset(seed=17)
        assert env.observation_space.contains(observation)
        np.testing.assert_allclose(env.data.site_xpos[env.goal_site], env.goal)
        initial = env.tool_position.copy()
        for _ in range(100):
            action = np.r_[np.clip((env.goal - env.data.ctrl[:3]) / .025, -1, 1), 1].astype(np.float32)
            observation, reward, terminated, truncated, info = env.step(action)
            assert np.isfinite(reward)
            assert env.observation_space.contains(observation)
            if terminated or truncated:
                break
        assert info["is_success"] and terminated and not truncated
        assert np.linalg.norm(env.tool_position - initial) > .1
        with pytest.raises(gym.error.ResetNeeded):
            env.step(action)


def test_seed_reproduces_randomized_dynamics_and_full_trajectory():
    with RoomRobotEnv(spec=example_room("kitchen")) as env:
        def trajectory(seed):
            observation, _ = env.reset(seed=seed)
            states = [observation["observation"]]
            mass = env.model.body_mass.copy()
            for _ in range(8):
                states.append(env.step(np.array([.2, 0, -.3, -1], dtype=np.float32))[0]["observation"])
            return np.array(states), mass
        first, mass = trajectory(4)
        second, same_mass = trajectory(4)
        np.testing.assert_array_equal(first, second)
        np.testing.assert_array_equal(mass, same_mass)
        other, other_mass = trajectory(5)
        assert not np.array_equal(first, other)
        assert not np.array_equal(mass, other_mass)


def test_invalid_actions_do_not_advance_and_time_limit_truncates():
    with RoomRobotEnv(spec=example_room("bedroom"), max_episode_steps=2) as env:
        with pytest.raises(gym.error.ResetNeeded):
            env.step([0, 0, 0, 1])
        env.reset(seed=42)
        for bad in ([0, 0, 0], [np.nan, 0, 0, 0], [2, 0, 0, 0], [np.inf, 0, 0, 0]):
            with pytest.raises(ValueError):
                env.step(bad)
        assert env.data.time == 0
        env.step([0, 0, 0, 1])
        _, _, terminated, truncated, info = env.step([0, 0, 0, 1])
        assert truncated and not terminated and not info["is_success"]
        assert env.data.time == pytest.approx(.1)


def test_contact_gripper_can_physically_lift_a_cup():
    with RoomRobotEnv(spec=example_room("kitchen"), task="lift:cup", randomization=0) as env:
        env.reset(seed=42)
        center = env.initial_center.copy()
        for offset, grip, steps in [(.24, 1, 22), (.065, 1, 24), (.065, -1, 30), (.215, -1, 45)]:
            target = center + [0, 0, offset]
            for _ in range(steps):
                action = np.r_[np.clip((target - env.data.ctrl[:3]) / .025, -1, 1), grip]
                _, _, terminated, truncated, info = env.step(action)
                if terminated or truncated:
                    break
            if terminated or truncated:
                break
        assert info["is_success"] and info["grasped"]
        assert env.data.xipos[env.target_body, 2] - center[2] > .12


def test_ungrasped_object_at_lift_goal_is_not_success():
    with RoomRobotEnv(spec=example_room("kitchen"), task="lift:cup") as env:
        env.reset(seed=42)
        joint = env.model.joint("cup_free").qposadr[0]
        # A transient flying object near the lift target must not count as a held object.
        env.data.qpos[joint:joint + 3] += [0, 0, .15]
        mujoco.mj_forward(env.model, env.data)
        _, _, terminated, _, info = env.step([0, 0, 0, 1])
        assert not terminated and not info["grasped"] and not info["is_success"]


def test_dropped_object_terminates_manipulation():
    with RoomRobotEnv(spec=example_room("kitchen"), task="push:cup") as env:
        env.reset(seed=42)
        joint = env.model.joint("cup_free").qposadr[0]
        env.data.qpos[joint:joint + 3] = [1, -1, .04]
        mujoco.mj_forward(env.model, env.data)
        _, reward, terminated, truncated, info = env.step([0, 0, 0, 1])
        assert terminated and not truncated and reward < 0
        assert info["failure"] == "object_dropped"


def test_clear_errors_for_missing_objects_and_tasks():
    spec = example_room("kitchen")
    spec.objects = [obj for obj in spec.objects if not obj.movable]
    with pytest.raises(ValueError, match="movable object"):
        RoomRobotEnv(spec=spec)
    with pytest.raises(ValueError, match="Unknown task"):
        RoomRobotEnv(spec=example_room("kitchen"), task="reach:missing")


def test_bundle_contains_footage_runs_without_repo_and_detects_changes(tmp_path):
    reference = tmp_path / "footage.mp4"
    reference.write_bytes(b"video-reference-fixture")
    scene = {"spec": example_room("kitchen").model_dump(), "revision": "revision-a", "source_job": None}
    output = tmp_path / "gym"
    manifest = export_bundle(scene, output, [(reference, "unverified_generated_reference")])
    assert verify_bundle(output) == manifest
    assert (output / "references/00-footage.mp4").read_bytes() == reference.read_bytes()
    assert manifest["source"] == "example_or_manual_scene"
    assert "No action labels" in manifest["video_usage"]
    code = ("import gymnasium as gym; import room_sim.gym_env; "
            "env=gym.make('RoomRobot-v0',scene_path='scene.json'); env.reset(seed=1); "
            "env.step([0,0,0,1]); env.close(); import room_sim.training; "
            "print(room_sim.gym_env.__file__)")
    result = subprocess.run([sys.executable, "-c", code], cwd=output, capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stderr
    assert str(output / "room_sim/gym_env.py") in result.stdout
    with pytest.raises(ValueError, match="already exists"):
        export_bundle(scene, output)
    (output / "scene.json").write_text("{}")
    with pytest.raises(ValueError, match="modified"):
        verify_bundle(output)


def test_manifest_rejects_path_escape(tmp_path):
    outside = tmp_path / "outside.json"
    outside.write_text("{}")
    folder = tmp_path / "bundle"
    folder.mkdir()
    (folder / "manifest.json").write_text(json.dumps({"format_version": 1, "files": [{"path": "../outside.json", "sha256": "invalid"}]}))
    with pytest.raises(ValueError, match="outside"):
        verify_bundle(folder)


def test_video_provenance_and_failed_probe_reviews_are_preserved(tmp_path):
    from room_sim.gym_bundle import digest
    job = "a" * 32
    build = tmp_path / "builds" / job
    build.mkdir(parents=True)
    (build / "source.mp4").write_bytes(b"generated-clip")
    (build / "source.json").write_text('{"model": "reference-model"}')
    probe = tmp_path / "probes" / "run"
    probe.mkdir(parents=True)
    (probe / "rejected.mp4").write_bytes(b"generated-clip")
    (probe / "source.mp4").write_bytes(b"original-clip")
    (probe / "report.json").write_text(json.dumps({"status": "failed", "cases": [{
        "status": "rejected", "generation": {"sha256": digest(build / "source.mp4")}}]}))
    references = room_references(tmp_path, {"source_job": job}, tmp_path / "probes")
    roles = [role for _, role in references]
    assert "generation_review" in roles and "unverified_generated_reference" in roles
    assert "original_video_reference" in roles


def test_api_exports_selected_task_and_rejects_stale_revision(tmp_path):
    with TestClient(create_app(tmp_path)) as client:
        detail = client.get("/rooms/kitchen/gym")
        assert detail.status_code == 200
        assert detail.json()["tasks"]
        assert client.post("/rooms/kitchen/gym?revision=stale").status_code == 409
        assert client.post("/rooms/kitchen/gym?revision=example&task=unknown").status_code == 422
        response = client.post("/rooms/kitchen/gym?revision=example&task=push:cup")
        assert response.status_code == 200
        assert "kitchen-robot-gym.zip" in response.headers["content-disposition"]
        with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
            manifest = json.loads(archive.read("kitchen-gym/manifest.json"))
            assert manifest["default_task"] == "push:cup"
            assert "kitchen-gym/robot.xml" in archive.namelist()


def test_training_keeps_its_scene_when_source_changes(tmp_path, monkeypatch):
    sb3 = pytest.importorskip("stable_baselines3")
    from room_sim.training import main
    from room_sim.gym_bundle import digest
    source = tmp_path / "scene.json"
    original = json.dumps({"spec": example_room("kitchen").model_dump(), "revision": "before"})
    source.write_text(original)

    class UpdatingPolicy:
        num_timesteps = 1

        def __init__(self, *args, **kwargs):
            pass

        def learn(self, **kwargs):
            source.write_text('{"revision": "replaced-during-training"}')

        def save(self, path):
            path.with_suffix(".zip").write_bytes(b"test-policy")

        def predict(self, observation, **kwargs):
            return np.array([0, 0, 0, 1], dtype=np.float32), None

    monkeypatch.setattr(sb3, "PPO", UpdatingPolicy)
    output = tmp_path / "training"
    monkeypatch.setattr(sys, "argv", ["rooms-train", "--scene", str(source), "--timesteps", "1",
                                     "--eval-episodes", "1", "--output", str(output)])
    main()
    assert (output / "scene.json").read_text() == original
    report = json.loads((output / "report.json").read_text())
    assert report["room_revision"] == "before"
    assert report["scene_sha256"] == digest(output / "scene.json")
