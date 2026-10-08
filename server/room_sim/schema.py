from __future__ import annotations

import math
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, FiniteFloat, model_validator

RoomId = Literal["kitchen", "living-room", "bedroom", "bathroom"]
AssetKind = Literal["table", "counter", "sink", "shelf", "cabinet", "drawer", "sofa", "bed",
                    "box", "book", "cylinder", "bottle", "cup", "bowl", "tray"]
Vector3 = Annotated[list[FiniteFloat], Field(min_length=3, max_length=3)]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class Evidence(StrictModel):
    frame: int = Field(ge=0, le=11)
    observation: str = Field(max_length=500)


class JointSpec(StrictModel):
    travel: FiniteFloat = Field(default=0.35, ge=0.05, le=1.5, description="Drawer travel in meters")
    opening: FiniteFloat = Field(default=1.5, ge=0.2, le=1.75, description="Door opening in radians")


class RoomObject(StrictModel):
    id: str = Field(pattern=r"^[a-z][a-z0-9_-]{0,39}$")
    label: str = Field(min_length=1, max_length=80)
    kind: AssetKind
    position: Vector3 = Field(description="Base-center position in meters; Z is up")
    size: Vector3 = Field(description="Full width, depth, height in meters")
    yaw: FiniteFloat = Field(default=0, ge=-6.3, le=6.3)
    color: str = Field(default="#ba9474", pattern=r"^#[0-9a-fA-F]{6}$", description="Exactly six hexadecimal RGB digits prefixed with #, e.g. #ba9474")
    movable: bool = False
    mass: FiniteFloat = Field(default=0.3, ge=0.01, le=100)
    friction: FiniteFloat = Field(default=0.7, ge=0.1, le=2)
    joint: JointSpec = Field(default_factory=JointSpec)
    evidence: list[Evidence] = Field(default_factory=list, max_length=12)

    @model_validator(mode="after")
    def physical_bounds(self):
        if any(abs(v) > 30 for v in self.position) or any(not 0.025 <= v <= 10 for v in self.size):
            raise ValueError("Objects need bounded positions and sizes of 0.025–10 meters")
        if self.movable and self.kind in {"table", "counter", "sink", "shelf", "cabinet", "drawer", "sofa", "bed"}:
            raise ValueError("Furniture is fixed; doors and drawers move through their joints")
        if self.kind in {"table", "cabinet", "drawer", "shelf"} and any(x < .2 for x in self.size):
            raise ValueError("Furniture dimensions must be at least 20 cm")
        if self.kind == "drawer" and self.joint.travel > self.size[1] * 0.85:
            self.joint.travel = self.size[1] * 0.85
        return self


class RoomSpec(StrictModel):
    version: Literal[1] = 1
    room_id: RoomId
    name: str = Field(min_length=1, max_length=100)
    dimensions: Vector3 = Field(default_factory=lambda: [4.5, 4, 2.8])
    scale_status: Literal["estimated", "calibrated"] = "estimated"
    appearance: str = Field(default="Warm natural materials and soft daylight", max_length=2000)
    objects: list[RoomObject] = Field(min_length=1, max_length=50)
    notes: list[str] = Field(default_factory=list, max_length=30)

    @model_validator(mode="after")
    def consistent_scene(self):
        if not all(1 <= x <= 15 for x in self.dimensions[:2]) or not 1.8 <= self.dimensions[2] <= 5:
            raise ValueError("Room dimensions must be 1–15m across and 1.8–5m high")
        ids = [o.id for o in self.objects]
        if len(ids) != len(set(ids)):
            raise ValueError("Object IDs must be unique")
        for o in self.objects:
            cosine, sine = abs(math.cos(o.yaw)), abs(math.sin(o.yaw))
            extent_x = cosine * o.size[0] + sine * o.size[1]
            extent_y = sine * o.size[0] + cosine * o.size[1]
            if abs(o.position[0]) + extent_x / 2 > self.dimensions[0] / 2 + .1:
                raise ValueError(f"{o.label} lies outside the room width")
            if abs(o.position[1]) + extent_y / 2 > self.dimensions[1] / 2 + .1:
                raise ValueError(f"{o.label} lies outside the room depth")
            if o.position[2] < 0 or o.position[2] + o.size[2] > self.dimensions[2]:
                raise ValueError(f"{o.label} lies outside the room height")
        return self


class Interaction(StrictModel):
    type: Literal["grab", "move", "release", "pause", "reset", "replay"]
    body_id: int | None = None
    point: Vector3 | None = None
    target: Vector3 | None = None
    paused: bool | None = None

    @model_validator(mode="after")
    def bounded_command(self):
        for v in (self.point, self.target):
            if v and any(abs(x) > 30 for x in v):
                raise ValueError("Interaction target is outside the workspace")
        if self.type == "grab" and (self.body_id is None or self.point is None):
            raise ValueError("Grab needs a body and a world-space point")
        if self.type == "move" and self.target is None:
            raise ValueError("Move needs a world-space target")
        if self.type == "pause" and self.paused is None:
            raise ValueError("Pause needs a paused boolean")
        return self
