import type { Collider, Family, Vec3 } from "./types";

export const PLAYER_RADIUS = .28;
export const EYE_HEIGHT = 1.68;
export const physicsToView = ([x, y, z]: readonly number[]): Vec3 => [x, z, -y];
export const viewToPhysics = ([x, y, z]: readonly number[]): Vec3 => [x, -z, y];

export function roomAt(x: number, y: number): Family | null {
  if (y < .15) return null;
  return x < -3.5 ? "dishes" : x > 3.5 ? "drawing" : "laundry";
}

export function canStand(x: number, y: number, colliders: Collider[]) {
  return colliders.every(c => {
    const dx = x - Math.max(c.x - c.width / 2, Math.min(x, c.x + c.width / 2));
    const dy = y - Math.max(c.y - c.depth / 2, Math.min(y, c.y + c.depth / 2));
    return dx * dx + dy * dy >= PLAYER_RADIUS * PLAYER_RADIUS;
  });
}

export function movePlayer(position: Vec3, dx: number, dy: number, colliders: Collider[]): Vec3 {
  let [x, y] = position;
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / .08));
  for (let i = 0; i < steps; i++) {
    if (canStand(x + dx / steps, y, colliders)) x += dx / steps;
    if (canStand(x, y + dy / steps, colliders)) y += dy / steps;
  }
  return [x, y, 0];
}

export function walkingRoute(position: Vec3, target: number): [number, number][] {
  const family = roomAt(position[0], position[1]);
  const current = family === "dishes" ? -7 : family === "drawing" ? 7 : 0;
  return [...(family ? [[current, .8], [current, -1.5]] as [number, number][] : []), [target, -1.5], [target, 2.65]];
}
