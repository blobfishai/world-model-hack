"""The playable world has its own IDs; legacy room and robot APIs stay compatible."""
from typing import Annotated, Literal

from pydantic import Field, FiniteFloat, model_validator

from .schema import StrictModel, Vector3

Family = Literal["dishes", "laundry", "drawing"]
Point2 = Annotated[list[FiniteFloat], Field(min_length=2, max_length=2)]


class TaskDefinition(StrictModel):
    id: str
    title: str
    instruction: str
    tool: Literal["sponge", "hand", "pencil"]


class TaskRoomDefinition(StrictModel):
    id: Family
    title: str
    color: str
    origin: Vector3
    station: Vector3
    appearance: str
    tasks: list[TaskDefinition]


class TaskWorldSpec(StrictModel):
    version: Literal[1] = 1
    rooms: list[TaskRoomDefinition]
    spawn: Vector3
    colliders: list[dict]


class PlayerState(StrictModel):
    position: Vector3
    yaw: FiniteFloat = 0
    pitch: FiniteFloat = 0


class WorldCommand(StrictModel):
    type: Literal["player", "station", "select_task", "reset_task", "tool", "stroke", "fold",
                  "grab", "move", "release"]
    family: Family | None = None
    task: str | None = Field(default=None, max_length=40)
    tool: Literal["sponge", "hand", "pencil"] | None = None
    active: bool | None = None
    player: PlayerState | None = None
    body_id: int | None = None
    point: Vector3 | None = None
    target: Vector3 | None = None
    start: Point2 | None = None
    end: Point2 | None = None

    @model_validator(mode="after")
    def bounded(self):
        for point in (self.point, self.target, self.player.position if self.player else None):
            if point and any(abs(v) > 30 for v in point):
                raise ValueError("Position lies outside the task world")
        for uv in (self.start, self.end):
            if uv and any(v < 0 or v > 1 for v in uv):
                raise ValueError("Draw or fold inside the task surface")
        return self
