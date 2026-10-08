// Logical navigation over a generated world. LingBot World 2 has no ground-truth geometry, so the
// player's pose is dead-reckoned from the actions the model reports it applied (chunk_complete).
//
// Conventions (shared with door bearings from the planner):
//   x: meters to the right of the room's entry direction; z: meters ahead of it.
//   yaw: degrees, 0 = entry direction, positive = turned RIGHT (clockwise seen from above).
//   A door at bearing b sits at (R·sin b, R·cos b). pitch: degrees, positive = looking up.

export interface Pose { x: number; z: number; yaw: number; pitch: number }
export interface ChunkReport { active_action: string; frames_emitted: number }
export interface ActionVector { forward: number; strafe: number; turn: number; tilt: number }
export interface DoorSpec { path: string; label: string; bearing: number }
export interface Door extends DoorSpec { kind: "child" | "back"; x: number; z: number; ring: number }

export const ORIGIN: Pose = { x: 0, z: 0, yaw: 0, pitch: 0 };
export const STEP_METERS = 0.035; // per emitted pixel frame
// LingBot applies rotation_speed_deg once per latent frame. Measured on reactor/lingbot-world-2: 0.5 s chunks of
// ~24 pixel frames carry 3 latent frames, so one latent frame is ~8 pixel frames (~6 per second at 48 fps).
export const FRAMES_PER_STEP = 8;
export const MAX_PITCH = 60;
export const ROOM_RADIUS = 4.6;
export const DOOR_RING = 3.2;
export const BACK_RING = 2.5;
export const DOOR_ARC = 75; // children spread across the front 150°
export const ENTER_RADIUS = 1.0;
// Aim assist: while walking forward, the door nearest the heading within ±ASSIST_ANGLE turns the dead-reckoned heading
// toward it by up to ASSIST_DEG_PER_SECOND (about 8° per 0.5 s LingBot chunk) before the chunk's step is applied, so a
// walk aimed within 25° of a door reaches its 1 m enter radius. A door's bearing widens as the player nears it, so the
// pull has to act early and before moving. It only steers the logical pose used for doors and the map; the generated
// video is not affected.
export const ASSIST_ANGLE = 25;
export const ASSIST_DEG_PER_SECOND = 16;
export const OUTPUT_FPS = 48;
export const NEAR_DISTANCE = 1.8;
export const FOV = 70;
export const SIM_CHUNK_MS = 250;
export const SIM_CHUNK_FRAMES = 12;

const RAD = Math.PI / 180;

export function normalizeDegrees(degrees: number): number {
  let value = ((degrees + 180) % 360 + 360) % 360 - 180;
  if (value === -180) value = 180;
  return value;
}

export function parseAction(action: string): ActionVector {
  const tokens = new Set(action.toLowerCase().split("+").map(token => token.trim()).filter(Boolean));
  const axis = (positive: string, negative: string) => (tokens.has(positive) ? 1 : 0) - (tokens.has(negative) ? 1 : 0);
  return { forward: axis("w", "s"), strafe: axis("d", "a"), turn: axis("right", "left"), tilt: axis("up", "down") };
}

/** Advance a pose by one reported chunk. Rotation happens before translation within the chunk. */
export function integrate(pose: Pose, chunk: ChunkReport, rotationSpeedDeg: number): Pose {
  const frames = Math.max(0, Number(chunk.frames_emitted) || 0);
  const vector = parseAction(chunk.active_action ?? "still");
  const degrees = rotationSpeedDeg * frames / FRAMES_PER_STEP;
  const yaw = normalizeDegrees(pose.yaw + vector.turn * degrees);
  const pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, pose.pitch + vector.tilt * degrees));
  const distance = STEP_METERS * frames;
  const length = Math.hypot(vector.forward, vector.strafe) || 1;
  const forward = vector.forward / length * distance, strafe = vector.strafe / length * distance;
  const sin = Math.sin(yaw * RAD), cos = Math.cos(yaw * RAD);
  let x = pose.x + forward * sin + strafe * cos;
  let z = pose.z + forward * cos - strafe * sin;
  const radius = Math.hypot(x, z);
  if (radius > ROOM_RADIUS) { x *= ROOM_RADIUS / radius; z *= ROOM_RADIUS / radius; }
  return { x, z, yaw, pitch };
}

/** Rooms with a Back door keep children in the front arc; the hub may place doors all around the player. */
export function clampBearing(bearing: number, hasBack = true): number {
  const value = normalizeDegrees(bearing);
  return hasBack ? Math.max(-DOOR_ARC, Math.min(DOOR_ARC, value)) : value;
}

/** Even spread across the front arc, for rooms that arrive without bearings. */
export function spreadBearings(count: number): number[] {
  if (count <= 0) return [];
  if (count === 1) return [0];
  return Array.from({ length: count }, (_, index) => -DOOR_ARC + index * 2 * DOOR_ARC / (count - 1));
}

export function doorLayout(children: DoorSpec[], parent: DoorSpec | null): Door[] {
  const doors: Door[] = children.map(child => {
    const bearing = clampBearing(child.bearing, parent !== null);
    return { ...child, bearing, kind: "child", ring: DOOR_RING, x: DOOR_RING * Math.sin(bearing * RAD), z: DOOR_RING * Math.cos(bearing * RAD) };
  });
  if (parent) doors.push({ ...parent, bearing: 180, kind: "back", ring: BACK_RING, x: 0, z: -BACK_RING });
  return doors;
}

export function doorDistance(pose: Pose, door: Door): number {
  return Math.hypot(door.x - pose.x, door.z - pose.z);
}

/** Bearing of the door relative to where the player faces, in (-180, 180]. */
export function relativeBearing(pose: Pose, door: Door): number {
  return normalizeDegrees(Math.atan2(door.x - pose.x, door.z - pose.z) / RAD - pose.yaw);
}

export function nearestDoor(pose: Pose, doors: Door[], radius = ENTER_RADIUS): Door | null {
  let best: Door | null = null, bestDistance = radius;
  for (const door of doors) {
    const distance = doorDistance(pose, door);
    if (distance <= bestDistance) { best = door; bestDistance = distance; }
  }
  return best;
}

/** The closest door in front of the player within reach, for the "press E" prompt. */
export function doorAhead(pose: Pose, doors: Door[], maxDistance = NEAR_DISTANCE, maxAngle = 35): Door | null {
  let best: Door | null = null, bestDistance = maxDistance;
  for (const door of doors) {
    const distance = doorDistance(pose, door);
    if (distance <= bestDistance && Math.abs(relativeBearing(pose, door)) <= maxAngle) { best = door; bestDistance = distance; }
  }
  return best;
}

/** Horizontal screen position (0 = left edge, 1 = right edge) of a relative bearing, or null outside the view. */
export function projectBearing(relative: number, fov = FOV): number | null {
  const half = fov / 2;
  if (Math.abs(relative) > half) return null;
  return 0.5 + Math.tan(relative * RAD) / (2 * Math.tan(half * RAD));
}

export function aimAssist(pose: Pose, chunk: ChunkReport, doors: Door[]): Pose {
  if (parseAction(chunk.active_action ?? "still").forward <= 0) return pose;
  let target: Door | null = null, bestAngle = ASSIST_ANGLE;
  for (const door of doors) {
    const angle = Math.abs(relativeBearing(pose, door));
    if (angle <= bestAngle) { target = door; bestAngle = angle; }
  }
  if (!target) return pose;
  const relative = relativeBearing(pose, target);
  const frames = Math.max(0, Number(chunk.frames_emitted) || 0);
  const step = Math.min(Math.abs(relative), ASSIST_DEG_PER_SECOND * frames / OUTPUT_FPS);
  return { ...pose, yaw: normalizeDegrees(pose.yaw + Math.sign(relative) * step) };
}

export function simulatedChunk(action: string): ChunkReport {
  return { active_action: action, frames_emitted: SIM_CHUNK_FRAMES };
}
