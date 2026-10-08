// Small pure helpers over the world contract (no DOM or React).
import type { Job, Relation, World, WorldRoom } from "./types";

export const RELATION_META: Record<Relation, { label: string; color: string }> = {
  source: { label: "Beginning image", color: "#bbd7ac" },
  similar: { label: "Similar task", color: "#b7d4b0" },
  subskill: { label: "Go deeper", color: "#a4cbe2" },
  harder: { label: "More advanced", color: "#ebc592" },
  variation: { label: "Variation", color: "#c9b5e1" },
};

const ROOM_PATH = /^(root|\d{1,2}(\.\d{1,2}){0,11})$/;
const WORLD_ID = /^[A-Za-z0-9_-]{4,64}$/;

export function validRoomPath(value: unknown): value is string {
  return typeof value === "string" && ROOM_PATH.test(value);
}

export function validWorldId(value: unknown): value is string {
  return typeof value === "string" && WORLD_ID.test(value);
}

export function jobActive(job: Job | undefined | null): boolean {
  return job?.status === "queued" || job?.status === "generating";
}

export function anyJobActive(world: World): boolean {
  return Object.values(world.rooms).some(room => Object.values(room.jobs).some(jobActive));
}

/** Rooms from the hub to `path`, inclusive; unknown ancestors are skipped. */
export function roomTrail(world: World, path: string): WorldRoom[] {
  const trail: WorldRoom[] = [];
  let current: WorldRoom | undefined = world.rooms[path];
  const seen = new Set<string>();
  while (current && !seen.has(current.path)) {
    seen.add(current.path);
    trail.unshift(current);
    current = current.parent ? world.rooms[current.parent] : undefined;
  }
  return trail;
}

/** The image LingBot is seeded with for a room: its Reactor arrival frame, or the beginning image for the hub. */
export function seedImage(world: World, room: WorldRoom): string | null {
  return room.media.arrival ?? (room.path === "root" ? world.start_url : null);
}

export function worldUrl(worldId: string | null, path = "root"): string {
  if (!worldId) return "/world";
  return `/world?w=${encodeURIComponent(worldId)}&room=${encodeURIComponent(path)}`;
}

export function roomApi(worldId: string, path: string, action: string): string {
  return `/${encodeURIComponent(worldId)}/rooms/${encodeURIComponent(path)}/${action}`;
}

export function formatSeconds(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

export function jobLabel(job: Job | undefined | null): string {
  if (!job || job.status === "idle") return "Not started";
  if (job.status === "queued") return "Queued";
  if (job.status === "generating") return `${job.message || "Working"} · ${Math.round(job.progress)}%`;
  if (job.status === "ready") return "Ready";
  return job.error ? `Failed · ${job.error}` : "Failed";
}

export interface GymBadge { id: "demo" | "physics" | "playground" | "reactor"; label: string; detail?: string }

/** Evidence that a room works as a training task: physics, a solved scripted demo, Playground checks, a Reactor render. */
export function roomBadges(room: WorldRoom): GymBadge[] {
  const badges: GymBadge[] = [];
  const demo = room.robot_demo ?? null;
  if (demo?.success) {
    badges.push({ id: "demo", label: `Scripted demo verified ${demo.steps_completed}/${demo.total_steps}`, detail: `${demo.seconds.toFixed(1)} s` });
  }
  if (room.physics?.valid) badges.push({ id: "physics", label: "Physics validated" });
  const checks = room.export?.checks ?? null;
  if (room.export?.feasible && checks?.passed === true) {
    const scripted = checks.scripted_demo_success;
    badges.push({ id: "playground", label: "Playground checks passed",
      detail: scripted === true ? "scripted demo ✓" : scripted === false ? "scripted demo ✗" : undefined });
  }
  if (demo?.reactor) badges.push({ id: "reactor", label: "Reactor render" });
  return badges;
}

/** Hub first, then rooms in path order (0, 0.1, 1, …). */
export function gymCatalog(world: World): WorldRoom[] {
  const key = (path: string) => path === "root" ? [-1] : path.split(".").map(Number);
  return Object.values(world.rooms).sort((a, b) => {
    const [left, right] = [key(a.path), key(b.path)];
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
      const delta = (left[i] ?? -2) - (right[i] ?? -2);
      if (delta) return delta;
    }
    return 0;
  });
}
