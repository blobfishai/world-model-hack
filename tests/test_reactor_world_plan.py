import json

from reactor_world import gemini, planner
from reactor_world.schema import HubPlan, RobotTask, SourceRef, TaskObject, WorldRoomSpec, WorldTask

from reactor_world_fixtures import children_plan, footage_plan, hub_plan


def test_robot_task_feasibility_follows_the_panda_gripper():
    sponge = TaskObject(id="sponge", label="sponge", kind="box", size=[.1, .07, .04])
    plate = TaskObject(id="plate", label="plate", kind="tray", size=[.25, .25, .02])
    sink = TaskObject(id="sink", label="sink", kind="sink", size=[.5, .45, .3])
    place = WorldTask(title="t", goal="g", objects=[sponge, sink],
                      robot_task=RobotTask(kind="place", object="sponge", anchor="sink", relation="beside"))
    assert place.robot_task.feasible and place.robot_task.reason is None
    wide = WorldTask(title="t", goal="g", objects=[plate], robot_task=RobotTask(kind="lift", object="plate"))
    assert not wide.robot_task.feasible and "8 cm" in wide.robot_task.reason
    no_anchor = WorldTask(title="t", goal="g", objects=[sponge],
                          robot_task=RobotTask(kind="place", object="sponge", anchor="sink", relation="on"))
    assert not no_anchor.robot_task.feasible
    unknown = WorldTask(title="t", goal="g", objects=[sink], robot_task=RobotTask(kind="lift", object="sponge"))
    assert "not one of the task objects" in unknown.robot_task.reason


def test_world_rooms_are_deterministic_and_doors_face_the_open_room():
    identifier = "0123456789abcdef"
    world = planner.build_world(identifier, SourceRef(id="3", file="data/000/3_video.mp4", t=0), hub_plan())
    assert list(world.rooms) == ["root", "0", "1", "2", "3", "4", "5"]
    assert world.rooms["root"].children == ["0", "1", "2", "3", "4", "5"]
    assert world.rooms["root"].camera_pitch_hint == "down" and world.rooms["0"].camera_pitch_hint == "level"
    # Egocentric footage faces a work surface: the open room and its doors lie behind the player.
    assert [world.rooms[str(i)].bearing for i in range(6)] == [105, 135, 165, -165, -135, -105]
    level = hub_plan()
    level.camera_pitch_hint = "level"
    ahead = planner.build_world(identifier, SourceRef(id="3", file="x", t=0), level)
    assert [ahead.rooms[str(i)].bearing for i in range(6)] == [-75, -45, -15, 15, 45, 75]
    assert world.rooms["3"].seed == planner.room_seed(identifier, "3") != world.rooms["4"].seed
    assert planner.world_id("3_video.mp4:1:2", 0) == planner.world_id("3_video.mp4:1:2", 0)
    assert planner.world_id("3_video.mp4:1:2", 0) != planner.world_id("3_video.mp4:1:2", 1)


def test_deeper_rooms_nest_under_their_parent():
    world = planner.build_world("0123456789abcdef", SourceRef(id="3", file="x", t=0), hub_plan())
    paths = planner.add_children(world, "2", children_plan())
    assert paths == ["2.0", "2.1", "2.2", "2.3"]
    assert world.rooms["2"].children == paths
    assert world.rooms["2.1"].parent == "2" and world.rooms["2.1"].depth == 2


def test_structured_output_schemas_are_portable():
    for model in (HubPlan, WorldRoomSpec):
        schema = gemini.portable_schema(model)
        text = json.dumps(schema)
        assert "$ref" not in text and "anyOf" not in text
    robot = gemini.portable_schema(HubPlan)["properties"]["rooms"]["items"]["properties"]["task"]["properties"]["robot_task"]
    assert robot["type"] == "object" and robot["properties"]["kind"]["enum"] == ["lift", "place", "reach", "push"]


def test_footage_rooms_keep_their_real_frame_and_pitch():
    candidates = [{"index": i, "source_id": str(i + 1), "file": f"data/000/{i + 1}_video.mp4", "t": 2. + i,
                   "task_type": "folding_laundry" if i else None} for i in range(8)]
    world = planner.build_world("0123456789abcdef", SourceRef(id="3", file="x", t=0), footage_plan(), candidates)
    room = world.rooms["1"]
    assert room.footage.source_id == "2" and room.footage.t == 3. and room.footage.task_type == "folding_laundry"
    assert room.camera_pitch_hint == "down" and world.rooms["0"].camera_pitch_hint == "level"
    imagined = planner.build_world("0123456789abcdef", SourceRef(id="3", file="x", t=0), hub_plan())
    assert imagined.rooms["1"].footage is None and imagined.rooms["1"].camera_pitch_hint == "level"
