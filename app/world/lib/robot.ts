// Robot-task helpers over the world contract. Pure: no DOM or React.
import type { RobotMetrics, TaskObject, TaskStepKind, TaskStepView, WorldRoom, WorldTask } from "./types";

/** Cartesian gripper command in the robot frame: +x away from the base, +y to the robot's left, +z up. */
export interface RobotAxes { x: number; y: number; z: number }

export const ROBOT_IDLE: RobotAxes = { x: 0, y: 0, z: 0 };
export const ROBOT_KEYS = new Set(["arrowup", "arrowdown", "arrowleft", "arrowright", "r", "f"]);

/** Held keys → gripper axes. Opposing keys cancel. */
export function robotAxesFromKeys(keys: Iterable<string>): RobotAxes {
  const held = new Set(Array.from(keys, key => key.toLowerCase()));
  const axis = (positive: string, negative: string) => (held.has(positive) ? 1 : 0) - (held.has(negative) ? 1 : 0);
  return { x: axis("arrowup", "arrowdown"), y: axis("arrowleft", "arrowright"), z: axis("r", "f") };
}

export function sameAxes(a: RobotAxes, b: RobotAxes): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

export function humanize(id: string): string {
  return id.replaceAll("_", " ").replaceAll("-", " ").trim();
}

function label(objects: TaskObject[], id: string | null | undefined, fallback: string): string {
  if (!id) return fallback;
  return objects.find(object => object.id === id)?.label ?? humanize(id);
}

/** "Place the green sponge beside the sink": task object labels, never raw ids. */
export function robotTaskTitle(task: WorldTask): string | null {
  const robot = task.robot_task;
  if (!robot) return null;
  const item = label(task.objects, robot.object, "object");
  if (robot.kind === "lift") return `Lift the ${item}`;
  return `Place the ${item} ${robot.relation ?? "beside"} the ${label(task.objects, robot.anchor, "target")}`;
}

/** Mirrors server/reactor_world/tasks.py `program()`, so the checklist exists before a simulation starts. */
export function taskProgram(task: WorldTask): TaskStepView[] {
  const robot = task.robot_task;
  if (!robot) return [];
  const item = label(task.objects, robot.object, humanize(robot.object));
  const steps: [string, TaskStepKind, string][] = [["reach", "reach", `Reach the ${item}`], ["grasp", "grasp", "Close both fingers on it"]];
  if (robot.kind === "lift") {
    steps.push(["lift", "lift", "Lift it 15 cm off the surface"], ["hold", "hold", "Hold it steady for a second"]);
  } else {
    const anchor = label(task.objects, robot.anchor, "target");
    const relation = robot.relation ?? "beside";
    steps.push(["lift", "lift", "Lift it clear of the surface"],
      ["carry", "carry", `Carry it ${relation !== "beside" ? "over" : "next to"} the ${anchor}`],
      ["place", "place", `Set it down ${relation} the ${anchor}`],
      ["release", "release", "Open the gripper and back away"]);
  }
  return steps.map(([id, kind, title], index) => ({ id, kind, title, done: false, current: index === 0 }));
}

export interface StepSummary { done: number; total: number; current: number; complete: boolean }

export function stepSummary(steps: TaskStepView[]): StepSummary {
  const done = steps.filter(step => step.done).length;
  const index = steps.findIndex(step => step.current);
  return { done, total: steps.length, current: index < 0 ? Math.min(done, Math.max(steps.length - 1, 0)) : index, complete: steps.length > 0 && done === steps.length };
}

export function contactLabel(metrics: Pick<RobotMetrics, "contact" | "gripper">): string {
  if (metrics.contact === "both fingers") return "Grasped";
  if (metrics.contact === "one finger") return "One finger";
  return metrics.gripper === "open" ? "Ready to grasp" : "No contact";
}

/** Draw rectangle that covers a fixed `target` size with a `source` frame, centered (cropping the overflow). */
export function coverRect(sourceWidth: number, sourceHeight: number, targetWidth: number, targetHeight: number) {
  const scale = Math.max(targetWidth / sourceWidth, targetHeight / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  return { x: (targetWidth - width) / 2, y: (targetHeight - height) / 2, width, height };
}

/** Reactor video-to-video prompt for the live render of a room's robot simulation. */
export function simulationPrompt(room: Pick<WorldRoom, "prompt" | "task">, support: string | null): string {
  const surface = support ? label(room.task.objects, support, humanize(support)) : "counter";
  const task = robotTaskTitle(room.task) ?? room.task.title;
  return `Photorealistic footage of this room: ${room.prompt} A white Franka Emika Panda robot arm on a dark pedestal works at the ${surface}: ${task}. `
    + "Keep the robot's exact motion, the camera and every object's position; restyle only materials, textures and lighting.";
}
