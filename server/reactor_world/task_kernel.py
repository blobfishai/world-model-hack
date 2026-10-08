"""Ordered manipulation contract shared by native MuJoCo and exported MJX gyms.

The array namespace is NumPy in the browser simulator and jax.numpy in training.
This file is copied into standalone bundles; it has no project dependencies.
"""

CONTRACT_VERSION = 2
HOLD_SECONDS = 1.0


def advance(xp, kind, index, held, gripper, item, start, speed, contacts, opening,
            low, high, hold_steps=25):
    """Advance only consecutive satisfied steps; a lift must be held continuously."""
    raised = item[2] - start[2]
    reach = (xp.linalg.norm(gripper[:2] - item[:2]) < (.08 if kind == "push" else .03)) & (xp.abs(gripper[2] - item[2]) < .045)
    grasp = contacts == 2
    lift = grasp & (raised >= (.15 if kind == "lift" else .05))
    in_goal = xp.all(item >= low - .02) & xp.all(item <= high + .02)
    release = (xp.all(item >= low - .03) & xp.all(item <= high + .03)
               & (contacts == 0) & (opening > .03) & (gripper[2] - item[2] > .06))
    carry = ((contacts > 0) & xp.all(item[:2] >= low[:2] - .03)
             & xp.all(item[:2] <= high[:2] + .03) & (item[2] >= low[2] + .02))
    place = in_goal & (speed < .05)
    supported = xp.abs(raised) < .025
    if kind == "reach":
        predicates = [reach]
    elif kind == "push":
        pushed = in_goal & supported & (xp.linalg.norm(item[:2] - start[:2]) >= .1)
        predicates = [reach, contacts > 0, pushed]
    else:
        predicates = [reach, grasp, lift]
    if kind == "place":
        predicates += [carry, place, release]
    # A fixed loop traces under JAX; later predicates can only advance after earlier ones.
    for step, satisfied in enumerate(predicates):
        index = xp.where((index == step) & satisfied, index + 1, index)
    if kind == "lift":
        steady = grasp & (raised >= .13) & (speed < .1)
        held = xp.where(index == 3, xp.where(steady, held + 1, 0), held)
        index = xp.where((index == 3) & (held >= hold_steps), 4, index)
    elif kind in {"reach", "push"}:
        steady = (reach & (gripper[2] - item[2] >= .015) & (gripper[2] - item[2] <= .045)
                  & (opening > .03) & (contacts == 0) & (xp.abs(raised) < .01)) if kind == "reach" else (in_goal & supported & (speed < .05))
        hold_index = 1 if kind == "reach" else 3
        held = xp.where(index == hold_index, xp.where(steady, held + 1, 0), held)
        index = xp.where((index == hold_index) & (held >= hold_steps), hold_index + 1, index)
    total = {"reach": 2, "push": 4, "lift": 4, "place": 6}[kind]
    checks = {"grasped": grasp, "lifted": lift, "in_goal": in_goal,
              "released": release, "task_success": index == total}
    return index, held, checks


def shaping(xp, kind, index, held, gripper, item, start, speed, contacts, opening, low, high, hold_steps=25):
    """Bounded phase-specific signal; success bonuses require the ordered contract."""
    raised = item[2] - start[2]
    approach = 1 - xp.tanh(8 * xp.linalg.norm(gripper - item))
    if kind == "reach":
        above = 1 - xp.tanh(8 * xp.linalg.norm(gripper - (item + xp.asarray([0., 0., .03]))))
        steady = (opening > .03) * (xp.abs(raised) < .01)
        return xp.asarray([above * steady, xp.clip(held / hold_steps, 0, 1), 1.0])[index]
    if kind == "push":
        transport = (1 - xp.tanh(8 * xp.linalg.norm(item[:2] - (low[:2] + high[:2]) / 2))) * (xp.abs(raised) < .025)
        return xp.asarray([approach, approach * xp.minimum(contacts, 1), transport, xp.clip(held / hold_steps, 0, 1), 1.0])[index]
    grasp = approach * contacts / 2
    lift = (contacts == 2) * xp.clip(raised / (.15 if kind == "lift" else .05), 0, 1)
    if kind == "lift":
        values = [approach, grasp, lift, xp.clip(held / hold_steps, 0, 1), 1.0]
    else:
        carry = (contacts > 0) * (1 - xp.tanh(8 * xp.linalg.norm(item[:2] - (low[:2] + high[:2]) / 2)))
        place = (1 - xp.tanh(8 * xp.linalg.norm(item - (low + high) / 2))) / (1 + speed)
        release = place * xp.clip(opening / .04, 0, 1) * xp.clip((gripper[2] - item[2]) / .1, 0, 1)
        values = [approach, grasp, lift, carry, place, release, 1.0]
    return xp.asarray(values)[index]
