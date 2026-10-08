"""Shared fixtures for the Reactor world tests (no Reactor or Gemini calls)."""
from reactor_world.schema import ChildrenPlan, HubPlan, PlanRoom, RobotTask, TaskObject, WorldRoomSpec, WorldTask

RELATIONS = ["similar", "similar", "subskill", "harder", "harder", "variation"]


def sponge_task(title="Put the sponge beside the bowl") -> WorldTask:
    return WorldTask(
        title=title, goal="The sponge rests on the counter next to the bowl.",
        objects=[TaskObject(id="sponge", label="green sponge", kind="box", size=[.09, .06, .04]),
                 TaskObject(id="bowl", label="white bowl", kind="bowl", size=[.2, .2, .08])],
        robot_task=RobotTask(kind="place", object="sponge", anchor="bowl", relation="beside"))


def hub_plan() -> HubPlan:
    rooms = [PlanRoom(title=f"Task {i}", relation=relation, door_label=f"Room {i}",
                      prompt=f"A bright kitchen corner {i} with a counter, a bowl and a sponge.", task=sponge_task(f"Task {i}"))
             for i, relation in enumerate(RELATIONS)]
    return HubPlan(hub_title="Kitchen sink", summary="Washing dishes at a kitchen sink.",
                   hub_prompt="A kitchen sink seen from above, plates stacked in the basin.", camera_pitch_hint="down",
                   hub_task=sponge_task("Wash a plate"), rooms=rooms)


def children_plan() -> ChildrenPlan:
    return ChildrenPlan(rooms=[PlanRoom(title=f"Deeper {i}", relation="harder", door_label=f"Deeper {i}",
                                        prompt="A pantry shelf with jars.", task=sponge_task()) for i in range(4)])


def counter_room(room_id="w0123abcd-0", *, sponge_size=(.09, .06, .04), against_walls=False) -> WorldRoomSpec:
    """A 3 × 3 m room with a counter on the back wall, a bowl and a sponge on it."""
    depth = 2.98 if against_walls else .6
    y = 0 if against_walls else 1.15
    objects = [
        {"id": "counter", "label": "counter", "kind": "counter", "position": [0, y, 0], "size": [2.9 if against_walls else 1.6, depth, .9],
         "color": "#c8b9a0", "evidence": [{"frame": 0, "observation": "counter"}]},
        {"id": "bowl", "label": "bowl", "kind": "bowl", "position": [-.25, y - .05 if not against_walls else 0, .901],
         "size": [.2, .2, .08], "movable": True, "mass": .3, "color": "#f0ece2", "evidence": [{"frame": 1, "observation": "bowl"}]},
        {"id": "sponge", "label": "sponge", "kind": "box", "position": [.25, y - .1 if not against_walls else .1, .901],
         "size": list(sponge_size), "movable": True, "mass": .03, "color": "#5f9e4a", "evidence": [{"frame": 2, "observation": "sponge"}]},
    ]
    return WorldRoomSpec.model_validate({"room_id": room_id, "name": "kitchen corner", "dimensions": [3, 3, 2.6],
                                         "objects": objects})


def footage_plan() -> HubPlan:
    """A plan whose rooms are real footage frames 0–5."""
    plan = hub_plan()
    for index, room in enumerate(plan.rooms):
        room.frame = index
        room.camera_pitch_hint = "down" if index % 2 else "level"
    return plan
