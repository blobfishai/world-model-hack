// Keyboard and drag input → LingBot World 2 movement axes. Pure: no DOM or React.

export type Longitudinal = "idle" | "forward" | "back";
export type Lateral = "idle" | "strafe_left" | "strafe_right";
export type LookHorizontal = "idle" | "left" | "right";
export type LookVertical = "idle" | "up" | "down";

export interface Axes {
  move_longitudinal: Longitudinal;
  move_lateral: Lateral;
  look_horizontal: LookHorizontal;
  look_vertical: LookVertical;
}

export const IDLE_AXES: Axes = { move_longitudinal: "idle", move_lateral: "idle", look_horizontal: "idle", look_vertical: "idle" };

export type AxisCommand =
  | { method: "setMoveLongitudinal"; params: { move_longitudinal: Longitudinal } }
  | { method: "setMoveLateral"; params: { move_lateral: Lateral } }
  | { method: "setLookHorizontal"; params: { look_horizontal: LookHorizontal } }
  | { method: "setLookVertical"; params: { look_vertical: LookVertical } };

export interface Drag { dx: number; dy: number }

export const ROTATION_SPEED = 5;
export const FAST_ROTATION_SPEED = 10;
export const DRAG_THRESHOLD = 4;

// Keys this module understands, normalized from KeyboardEvent.key.
export const MOVEMENT_KEYS = new Set(["w", "a", "s", "d", "r", "f", "arrowup", "arrowdown", "arrowleft", "arrowright"]);

export function normalizeKey(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key.toLowerCase();
}

function pick<T extends string>(positive: boolean, negative: boolean, yes: T, no: T, idle: T): T {
  if (positive === negative) return idle;
  return positive ? yes : no;
}

/** Held keys plus an optional pointer drag (pixels since the last sample) → axes. Drag wins over keys on look axes. */
export function axesFromInput(keys: Iterable<string>, drag: Drag | null = null, threshold = DRAG_THRESHOLD): Axes {
  const held = new Set(Array.from(keys, normalizeKey));
  const has = (...names: string[]) => names.some(name => held.has(name));
  let look_horizontal = pick<LookHorizontal>(has("arrowright"), has("arrowleft"), "right", "left", "idle");
  let look_vertical = pick<LookVertical>(has("r"), has("f"), "up", "down", "idle");
  if (drag && Math.abs(drag.dx) > threshold) look_horizontal = drag.dx > 0 ? "right" : "left";
  if (drag && Math.abs(drag.dy) > threshold) look_vertical = drag.dy < 0 ? "up" : "down";
  return {
    move_longitudinal: pick<Longitudinal>(has("w", "arrowup"), has("s", "arrowdown"), "forward", "back", "idle"),
    move_lateral: pick<Lateral>(has("d"), has("a"), "strafe_right", "strafe_left", "idle"),
    look_horizontal,
    look_vertical,
  };
}

/** Only the axes that changed, in a stable order, as typed LingBot commands. */
export function diffAxes(previous: Axes, next: Axes): AxisCommand[] {
  const commands: AxisCommand[] = [];
  if (previous.move_longitudinal !== next.move_longitudinal) commands.push({ method: "setMoveLongitudinal", params: { move_longitudinal: next.move_longitudinal } });
  if (previous.move_lateral !== next.move_lateral) commands.push({ method: "setMoveLateral", params: { move_lateral: next.move_lateral } });
  if (previous.look_horizontal !== next.look_horizontal) commands.push({ method: "setLookHorizontal", params: { look_horizontal: next.look_horizontal } });
  if (previous.look_vertical !== next.look_vertical) commands.push({ method: "setLookVertical", params: { look_vertical: next.look_vertical } });
  return commands;
}

export function rotationSpeedFor(shift: boolean): number {
  return shift ? FAST_ROTATION_SPEED : ROTATION_SPEED;
}

/** LingBot's composite action string ("w+left", "still") for the given axes. */
export function actionString(axes: Axes): string {
  const tokens: string[] = [];
  if (axes.move_longitudinal === "forward") tokens.push("w");
  if (axes.move_longitudinal === "back") tokens.push("s");
  if (axes.move_lateral === "strafe_left") tokens.push("a");
  if (axes.move_lateral === "strafe_right") tokens.push("d");
  if (axes.look_horizontal !== "idle") tokens.push(axes.look_horizontal);
  if (axes.look_vertical !== "idle") tokens.push(axes.look_vertical);
  return tokens.length ? tokens.join("+") : "still";
}

export function isIdle(axes: Axes): boolean {
  return actionString(axes) === "still";
}

interface TargetLike { tagName?: string; isContentEditable?: boolean; closest?: (selector: string) => unknown }

/** True when keyboard input belongs to a form field or dialog rather than the world. */
export function isTypingTarget(target: TargetLike | null | undefined): boolean {
  if (!target) return false;
  const tag = (target.tagName ?? "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select" || target.isContentEditable) return true;
  return Boolean(target.closest?.("dialog, [role=dialog]"));
}
