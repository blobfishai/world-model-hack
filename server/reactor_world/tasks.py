"""Step-by-step robot task programs, checked against simulator state in the robot frame."""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Literal

import numpy as np

from .schema import WorldTask

StepKind = Literal["reach", "grasp", "lift", "hold", "carry", "place", "release"]
LIFT_HEIGHT = {"lift": .15, "place": .05}
HOLD_STEPS = 25  # one second at the simulator's 25 Hz control rate


@dataclass(frozen=True)
class Step:
    id: str
    kind: StepKind
    title: str


def program(task: WorldTask) -> list[Step]:
    """A deterministic program for the room's single-arm subtask, so progress is measurable in simulation."""
    robot = task.robot_task
    if robot is None:
        return []
    labels = {o.id: o.label for o in task.objects}
    item = labels.get(robot.object, robot.object.replace("_", " "))
    steps = [Step("reach", "reach", f"Reach the {item}"), Step("grasp", "grasp", "Close both fingers on it")]
    if robot.kind == "lift":
        return steps + [Step("lift", "lift", "Lift it 15 cm off the surface"), Step("hold", "hold", "Hold it steady for a second")]
    anchor = labels.get(robot.anchor or "", (robot.anchor or "the target").replace("_", " "))
    relation = robot.relation or "beside"
    return steps + [Step("lift", "lift", "Lift it clear of the surface"),
                    Step("carry", "carry", f"Carry it {'over' if relation != 'beside' else 'next to'} the {anchor}"),
                    Step("place", "place", f"Set it down {relation} the {anchor}"),
                    Step("release", "release", "Open the gripper and back away")]


@dataclass
class Observation:
    """What the checks need from one simulator state (robot frame, meters)."""
    gripper: np.ndarray
    item: np.ndarray
    start: np.ndarray
    speed: float
    contacts: int  # finger pads touching the object (0–2)
    opening: float  # finger joint position: 0 closed, 0.04 open


@dataclass
class Progress:
    steps: list[Step]
    kind: str
    goal_low: np.ndarray
    goal_high: np.ndarray
    index: int = 0
    held: int = 0
    done: list[bool] = field(default_factory=list)

    def __post_init__(self):
        self.done = [False] * len(self.steps)

    @property
    def success(self) -> bool:
        return bool(self.steps) and all(self.done)

    @property
    def goal(self) -> np.ndarray:
        return (self.goal_low + self.goal_high) / 2

    def in_goal(self, item: np.ndarray, margin: float = .02) -> bool:
        return bool(np.all(item >= self.goal_low - margin) and np.all(item <= self.goal_high + margin))

    def satisfied(self, step: Step, o: Observation) -> bool:
        raised = o.item[2] - o.start[2]
        if step.kind == "reach":
            return bool(np.linalg.norm(o.gripper[:2] - o.item[:2]) < .03 and abs(o.gripper[2] - o.item[2]) < .045)
        if step.kind == "grasp":
            return o.contacts == 2
        if step.kind == "lift":
            return o.contacts == 2 and raised >= LIFT_HEIGHT[self.kind]
        if step.kind == "hold":
            self.held = self.held + 1 if o.contacts == 2 and raised >= LIFT_HEIGHT["lift"] - .02 and o.speed < .1 else 0
            return self.held >= HOLD_STEPS
        if step.kind == "carry":
            low, high = self.goal_low[:2] - .03, self.goal_high[:2] + .03
            return o.contacts > 0 and bool(np.all(o.item[:2] >= low) and np.all(o.item[:2] <= high)) and o.item[2] >= self.goal_low[2] + .02
        if step.kind == "place":
            return self.in_goal(o.item) and o.speed < .05
        if step.kind == "release":
            return self.in_goal(o.item, .03) and o.contacts == 0 and o.opening > .03 and o.gripper[2] - o.item[2] > .06
        return False

    def update(self, o: Observation) -> None:
        while self.index < len(self.steps) and self.satisfied(self.steps[self.index], o):
            self.done[self.index] = True
            self.index += 1

    def metrics(self, o: Observation) -> dict:
        target = self.goal if self.kind == "place" else np.r_[o.start[:2], o.start[2] + LIFT_HEIGHT["lift"]]
        return {"goal_distance_m": round(float(np.linalg.norm(o.item - target)), 3),
                "object_raised_m": round(float(o.item[2] - o.start[2]), 3),
                "gripper_to_object_m": round(float(np.linalg.norm(o.gripper - o.item)), 3),
                "contact": ("both fingers", "one finger", "none")[2 - o.contacts] if o.contacts <= 2 else "both fingers",
                "gripper": "open" if o.opening > .02 else "closed"}

    def view(self) -> list[dict]:
        return [{**asdict(step), "done": done, "current": i == self.index} for i, (step, done) in enumerate(zip(self.steps, self.done))]
