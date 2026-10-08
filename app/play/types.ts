import type { RenderGeom } from "../rooms/types";

export type Family = "dishes" | "laundry" | "drawing";
export type Tool = "hand" | "sponge" | "pencil";
export type Vec3 = [number, number, number];
export interface TaskDefinition { id: string; title: string; instruction: string; tool: Tool }
export interface TaskRoom { id: Family; title: string; color: string; origin: Vec3; station: Vec3; appearance: string; tasks: TaskDefinition[] }
export interface Collider { x: number; y: number; width: number; depth: number }
export interface TaskWorldSpec { version: 1; rooms: TaskRoom[]; spawn: Vec3; colliders: Collider[] }
export interface PlayerState { position: Vec3; yaw: number; pitch: number; room: Family | null; near: boolean }
export interface TaskProgress {
  type: "state"; tick: number; time: number; bodies: number[][]; station: Family | null;
  active: Record<Family, string>; tools: Record<Family, Tool>; completed: string[];
  progress: Record<Family, number>; grabbed_body: number | null;
  details: { scrub: number; rinse: number; folds: number; fold_goal: number; ink: number[]; clean_cells: number[] };
}
export interface WorldSession { id: string; spec: TaskWorldSpec; geoms: RenderGeom[]; state: TaskProgress }
export interface Demo { recording: number; recordings: number[]; available: boolean; prepared: boolean; start: number; seconds: number; sourceUrl: string; posterUrl: string }
export interface WorldCatalog { spec: TaskWorldSpec; media: Record<Family, Demo>; attribution: string }
export interface WorldCommand {
  type: string; family?: Family; task?: string; tool?: Tool; active?: boolean;
  player?: { position: Vec3; yaw: number; pitch: number };
  body_id?: number; point?: number[]; target?: number[]; start?: number[]; end?: number[];
}

export async function worldRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/task-world${path}`, { cache: "no-store", ...init });
  const body = await response.json();
  if (!response.ok) throw new Error(typeof (body.error ?? body.detail) === "string" ? body.error ?? body.detail : "Could not open the task world.");
  return body as T;
}
