import functools

import numpy as np
import pytest

from reactor_world.task_kernel import advance


@pytest.fixture(params=["numpy", "jax"])
def kernel(request):
    if request.param == "numpy":
        return functools.partial(advance, np)
    jax = pytest.importorskip("jax")
    return jax.jit(functools.partial(advance, jax.numpy), static_argnames=("kind", "hold_steps"))


def observation(item=(.5, 0, .02), gripper=(.5, 0, .04), contacts=0, opening=.04, speed=0):
    return (np.array(gripper), np.array(item), np.array([.5, 0, .02]), speed, contacts, opening,
            np.array([.55, .1, .01]), np.array([.65, .2, .03]))


def test_goal_proximity_cannot_skip_grasp_lift_and_carry(kernel):
    args = observation(item=(.6, .15, .02), gripper=(.6, .15, .2))
    index, _, checks = kernel("place", 0, 0, *args)
    assert int(index) == 0 and bool(checks["released"]) and not bool(checks["task_success"])


def test_place_requires_settling_release_and_retreat(kernel):
    index, held, _ = kernel("place", 0, 0, *observation(contacts=2))
    assert int(index) == 2
    index, held, _ = kernel("place", index, held, *observation(item=(.6, .15, .12), contacts=2))
    assert int(index) == 4
    index, held, _ = kernel("place", index, held, *observation(item=(.6, .15, .02), contacts=2, speed=.1))
    assert int(index) == 4
    index, held, _ = kernel("place", index, held, *observation(item=(.6, .15, .02), contacts=2, speed=.01))
    assert int(index) == 5
    index, held, checks = kernel("place", index, held, *observation(item=(.6, .15, .02), gripper=(.6, .15, .04)))
    assert not bool(checks["task_success"])
    index, held, checks = kernel("place", index, held, *observation(item=(.6, .15, .02), gripper=(.6, .15, .15)))
    assert int(index) == 6 and bool(checks["task_success"])
    # Success stays latched until an environment reset.
    assert bool(kernel("place", index, held, *observation())[2]["task_success"])


def test_lift_requires_a_continuous_hold_and_uses_actual_spawn(kernel):
    index, held, _ = kernel("lift", 0, 0, *observation(contacts=2))
    raised = observation(item=(.5, 0, .20), contacts=2)
    for _ in range(24):
        index, held, checks = kernel("lift", index, held, *raised)
    assert int(index) == 3 and int(held) == 24 and not bool(checks["task_success"])
    index, held, _ = kernel("lift", index, held, *observation(item=(.5, 0, .2), contacts=1))
    assert int(held) == 0
    for _ in range(25):
        index, held, checks = kernel("lift", index, held, *raised)
    assert bool(checks["task_success"])
    # Starting higher must not make the required lift shorter.
    args = list(raised)
    args[2] = np.array([.5, 0, .15])
    assert int(kernel("lift", 2, 0, *args)[0]) == 2


def test_reach_requires_open_fingers_and_a_continuous_hover(kernel):
    index, held = 0, 0
    for _ in range(30):
        index, held, checks = kernel("reach", index, held, *observation(gripper=(.5, 0, .05), contacts=2, opening=.01))
    assert int(index) == 1 and int(held) == 0 and not bool(checks["task_success"])
    for _ in range(24):
        index, held, checks = kernel("reach", index, held, *observation(gripper=(.5, 0, .05)))
    assert not bool(checks["task_success"])
    index, held, _ = kernel("reach", index, held, *observation(gripper=(.6, 0, .05)))
    assert int(held) == 0
    for _ in range(25):
        index, held, checks = kernel("reach", index, held, *observation(gripper=(.5, 0, .05)))
    assert bool(checks["task_success"])


def test_push_requires_contact_transport_and_settling_on_the_support(kernel):
    goal = observation(item=(.6, .15, .02), gripper=(.6, .15, .05))
    assert not bool(kernel("push", 0, 0, *goal)[2]["task_success"])
    index, held, _ = kernel("push", 0, 0, *observation(gripper=(.44, 0, .02)))
    assert int(index) == 1
    index, held, _ = kernel("push", index, held, *observation(contacts=1))
    assert int(index) == 2
    index, held, _ = kernel("push", index, held, *observation(item=(.6, .15, .1)))
    assert int(index) == 2
    index, held, _ = kernel("push", index, held, *observation(item=(.6, .15, .02), speed=.2))
    assert int(index) == 3 and int(held) == 0
    for _ in range(25):
        index, held, checks = kernel("push", index, held, *goal)
    assert int(index) == 4 and bool(checks["task_success"])
