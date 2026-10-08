"""A world plan: a hub and task rooms derived from a start video's beginning image."""
from __future__ import annotations

from typing import Annotated, Literal

from pydantic import Field, FiniteFloat, model_validator

from room_sim.schema import AssetKind, RoomSpec, StrictModel

Relation = Literal["source", "similar", "subskill", "harder", "variation"]
ChildRelation = Literal["similar", "subskill", "harder", "variation"]
JobStatus = Literal["idle", "queued", "generating", "ready", "failed"]
JobName = Literal["scan", "physics", "export", "children", "demo"]
Size3 = Annotated[list[FiniteFloat], Field(min_length=3, max_length=3)]
Point3 = Annotated[list[FiniteFloat], Field(min_length=3, max_length=3)]

PATH_PATTERN = r"^(root|[0-9](\.[0-9]){0,5})$"
OBJECT_ID = r"^[a-z][a-z0-9_-]{0,39}$"
WORLD_ID = r"^[0-9a-f]{16}$"
# The Panda's fingers open to 8 cm; keep a margin around the narrowest horizontal side.
GRASP_WIDTH = .075


class TaskObject(StrictModel):
    id: str = Field(pattern=OBJECT_ID, description="lowercase slug, e.g. green_sponge")
    label: str = Field(max_length=80)
    kind: AssetKind
    size: Size3 = Field(description="meters: width, depth, height")

    @model_validator(mode="after")
    def bounded(self):
        if any(not .01 <= value <= 3 for value in self.size):
            raise ValueError(f"{self.id}: object sizes must be between 1 cm and 3 m")
        return self


class RobotTask(StrictModel):
    kind: Literal["lift", "place"]
    object: str = Field(pattern=OBJECT_ID, description="id of the small rigid object the robot moves")
    anchor: str | None = Field(default=None, pattern=OBJECT_ID, description="for place: id of the reference object")
    relation: Literal["beside", "on", "in"] | None = Field(default=None, description="for place: where relative to the anchor")
    feasible: bool = True
    reason: str | None = Field(default=None, max_length=300)


class WorldTask(StrictModel):
    title: str = Field(max_length=80)
    goal: str = Field(max_length=400, description="one or two sentences with a concrete success condition")
    objects: list[TaskObject] = Field(default_factory=list, max_length=8)
    robot_task: RobotTask | None = None

    @model_validator(mode="after")
    def robot_feasibility(self):
        task = self.robot_task
        if task is None:
            return self
        objects = {o.id: o for o in self.objects}
        reason = None
        if task.object not in objects:
            reason = f"robot object {task.object} is not one of the task objects"
        else:
            width, depth, height = objects[task.object].size
            if min(width, depth) > GRASP_WIDTH:
                reason = f"{task.object} is {min(width, depth) * 100:.0f} cm across; the Panda gripper opens to 8 cm"
            elif not .015 <= height <= .35:
                reason = f"{task.object} is {height * 100:.0f} cm tall; graspable objects are 1.5–35 cm"
        if reason is None and task.kind == "place":
            if task.anchor is None or task.anchor not in objects or task.relation is None:
                reason = "a place task needs an anchor object and a relation"
            elif task.anchor == task.object:
                reason = "the anchor must differ from the moved object"
        task.feasible, task.reason = reason is None, reason
        return self


class Job(StrictModel):
    status: JobStatus = "idle"
    progress: int = Field(default=0, ge=0, le=100)
    message: str = ""
    error: str | None = None
    updated_at: str | None = None
    owner: int | None = Field(default=None, description="pid of the rooms-server process running this job")


class RoomJobs(StrictModel):
    scan: Job = Field(default_factory=Job)
    physics: Job = Field(default_factory=Job)
    export: Job = Field(default_factory=Job)
    children: Job = Field(default_factory=Job)
    demo: Job = Field(default_factory=Job)


class PhysicsSummary(StrictModel):
    revision: str
    objects: int
    valid: bool
    goal: Point3 | None = None


class DemoSummary(StrictModel):
    """Outcome of the scripted Panda demo in simulation, and of its Reactor video-to-video render."""
    success: bool
    steps_completed: int
    total_steps: int
    seconds: float
    reactor: bool = False
    reactor_error: str | None = None
    reactor_session_id: str | None = None


class ExportSummary(StrictModel):
    feasible: bool
    reason: str | None = None
    env_name: str | None = None
    checks: dict[str, bool | str | float | int] | None = None


class WorldRoom(StrictModel):
    path: str = Field(pattern=PATH_PATTERN)
    parent: str | None = None
    children: list[str] = Field(default_factory=list)
    depth: int = Field(ge=0, le=6)
    title: str = Field(max_length=80)
    relation: Relation
    door_label: str = Field(max_length=40)
    bearing: float = Field(ge=-180, le=180)
    prompt: str = Field(max_length=1200)
    camera_pitch_hint: Literal["down", "level"] = "level"
    seed: int = Field(ge=0, le=2**31 - 1)
    task: WorldTask
    jobs: RoomJobs = Field(default_factory=RoomJobs)
    physics: PhysicsSummary | None = None
    export: ExportSummary | None = None
    robot_demo: DemoSummary | None = None


class SourceRef(StrictModel):
    id: str = Field(pattern=r"^[0-9]{1,6}$")
    file: str
    t: float = Field(ge=0)
    task_type: str | None = None
    sha256: str | None = None


class World(StrictModel):
    id: str = Field(pattern=WORLD_ID)
    version: Literal[1] = 1
    status: Literal["planning", "ready", "failed"] = "planning"
    error: str | None = None
    source: SourceRef
    hub_title: str = ""
    summary: str = ""
    rooms: dict[str, WorldRoom] = Field(default_factory=dict)
    arrival_strategy: Literal["walk", "helios"] = "walk"
    planner: dict[str, str | int] = Field(default_factory=dict)
    planner_pid: int | None = None
    created_at: str
    updated_at: str
    attribution: str


class WorldRoomSpec(RoomSpec):
    """A reconstructed room whose id names its world and room path instead of a legacy room."""
    room_id: str = Field(pattern=r"^w[0-9a-f]{8}-(root|[0-9](\.[0-9]){0,5})$")


# Gemini planning responses (validated, then expanded into WorldRoom records).
class PlanRoom(StrictModel):
    title: str = Field(max_length=80, description="imperative task name, at most 6 words")
    relation: ChildRelation
    door_label: str = Field(max_length=40, description="short room name shown on the door, at most 3 words")
    prompt: str = Field(max_length=1200, description="eye-level arrival view of this room for a world model, at most 600 characters")
    task: WorldTask


class HubPlan(StrictModel):
    hub_title: str = Field(max_length=80)
    summary: str = Field(max_length=400)
    hub_prompt: str = Field(max_length=1200)
    camera_pitch_hint: Literal["down", "level"]
    hub_task: WorldTask
    rooms: list[PlanRoom] = Field(min_length=6, max_length=6)


class ChildrenPlan(StrictModel):
    rooms: list[PlanRoom] = Field(min_length=4, max_length=6)
