import math

import mujoco
import numpy as np
import pytest
from pydantic import ValidationError

from room_sim.compiler import compile_room, validate_physics
from room_sim.physics import PhysicsSession
from room_sim.schema import Interaction, RoomSpec
from room_sim.templates import ROOMS, example_room, obj


@pytest.mark.parametrize("room", ROOMS)
def test_every_room_compiles_settles_and_has_real_interactions(room):
    spec = RoomSpec.model_validate_json(example_room(room).model_dump_json())
    result = validate_physics(compile_room(spec))
    assert result["valid"], result["errors"]
    simulation = PhysicsSession(spec)
    assert any(o.movable for o in spec.objects)
    assert simulation.model.joint("storage_joint").type == mujoco.mjtJoint.mjJNT_HINGE
    assert simulation.model.joint("drawer_joint").type == mujoco.mjtJoint.mjJNT_SLIDE
    assert all(t["progress"] < .01 for t in simulation.tasks())
    for o in spec.objects:
        if o.movable:
            assert simulation.model.body(o.id).mass == pytest.approx(o.mass)


@pytest.mark.parametrize("room", ROOMS)
def test_force_moves_objects_and_replay_reproduces_the_result(room):
    simulation = PhysicsSession(example_room(room))
    item = next(o for o in simulation.spec.objects if o.movable)
    body = simulation.model.body(item.id).id
    point = simulation.data.xpos[body].copy() + [0, 0, item.size[2] / 2]
    original = simulation.initial.copy()
    simulation.command(Interaction(type="grab", body_id=body, point=point.tolist()))
    simulation.command(Interaction(type="move", target=(point + [.3, -.15, .25]).tolist()))
    simulation.advance(400)
    simulation.command(Interaction(type="release"))
    simulation.advance(600)
    expected = simulation.data.qpos.copy()
    assert np.linalg.norm(simulation.data.xpos[body] - simulation.initial_bodies[body]) > .2
    simulation.command(Interaction(type="replay"))
    simulation.advance(1001)
    np.testing.assert_allclose(simulation.data.qpos, expected, atol=1e-9)
    assert simulation.paused
    simulation.command(Interaction(type="reset"))
    np.testing.assert_array_equal(simulation.data.qpos, original)
    assert simulation.log == []


@pytest.mark.parametrize("name,offset", [("storage_door", [0, -.8, 0]), ("drawer_drawer", [0, -.8, 0])])
def test_storage_opens_with_force_and_obeys_joint_limits(name, offset):
    simulation = PhysicsSession(example_room("kitchen"))
    body = simulation.model.body(name).id
    is_door = name.endswith("door")
    point = simulation.data.xpos[body] + ([.75, -.04, .6] if is_door else [0, -.34, .35])
    simulation.command(Interaction(type="grab", body_id=body, point=point.tolist()))
    simulation.command(Interaction(type="move", target=(point + offset).tolist()))
    simulation.advance(1000)
    joint = simulation.model.joint("storage_joint" if is_door else "drawer_joint")
    q = float(simulation.data.qpos[joint.qposadr[0]])
    assert abs(q) > .2
    lower, upper = joint.range
    assert lower - .025 <= q <= upper + .025


def test_hollow_bowl_accepts_a_falling_cup():
    spec = RoomSpec(room_id="kitchen", name="Containment test", objects=[
        obj("bowl", "Bowl", "bowl", [0, 0, 0], [.3, .3, .12]),
        obj("cup", "Cup", "cup", [0, 0, .25], [.08, .08, .08], movable=True),
    ])
    simulation = PhysicsSession(spec)
    simulation.advance(1000)
    bottom = simulation.data.xpos[simulation.model.body("cup").id, 2]
    assert 0 < bottom < .03  # A solid bowl proxy would hold the cup above 12 cm.
    assert np.max(np.abs(simulation.data.qvel)) < .01
    assert next(t for t in simulation.tasks() if t["id"] == "place-cup-bowl")["progress"] == 1


def test_rejects_nonfinite_commands_and_static_grabs():
    with pytest.raises(ValidationError):
        Interaction(type="move", target=[math.nan, 0, 0])
    simulation = PhysicsSession(example_room("kitchen"))
    with pytest.raises(ValueError, match="movable"):
        simulation.command(Interaction(type="grab", body_id=simulation.model.body("table").id, point=[0, 0, 0]))


def test_overlap_is_reported_without_claiming_valid_physics():
    spec = example_room("kitchen")
    next(o for o in spec.objects if o.id == "cup").position = [0, 1.35, .5]
    result = validate_physics(compile_room(spec))
    assert not result["valid"]
    assert any("cup" in error and "counter" in error for error in result["errors"])
    assert len(result["errors"]) == len(set(result["errors"]))


def test_recessed_sink_has_a_real_cavity_and_supports_objects():
    spec = RoomSpec(room_id="kitchen", name="Sink test", objects=[
        obj("sink", "Sink basin", "sink", [0, 0, .6], [.6, .5, .22]),
        obj("bottle", "Soap bottle", "bottle", [0, 0, .72], [.08, .08, .12], movable=True),
    ])
    validation = validate_physics(compile_room(spec))
    assert validation["valid"], validation["errors"]
    simulation = PhysicsSession(spec)
    bottom = simulation.data.xpos[simulation.model.body("bottle").id, 2]
    assert .6 < bottom < .63
    assert not simulation.model.body("sink").dofnum


def test_render_geometry_uses_native_body_transforms():
    simulation = PhysicsSession(example_room("kitchen"))
    for geom in simulation.geoms:
        body = geom["body_id"]
        matrix = simulation.data.xmat[body].reshape(3, 3)
        expected = simulation.data.xpos[body] + matrix @ geom["position"]
        np.testing.assert_allclose(expected, simulation.data.geom_xpos[geom["id"]], atol=1e-7)
