// API contract for the Reactor walkable world (`server/reactor_world/api.py`, proxied at /api/worlds).
import type { PhysicsState, RenderGeom, RoomObject } from "@/app/rooms/types";

export type JobStatus = "idle" | "queued" | "generating" | "ready" | "failed";
export interface Job {
  status: JobStatus;
  progress: number; // 0–100
  message: string;
  error: string | null;
  updated_at: string | null;
}

export type Relation = "source" | "similar" | "subskill" | "harder" | "variation";

export interface TaskObject {
  id: string;
  label: string;
  kind: string;
  size: [number, number, number]; // meters: width, depth, height
}

export interface RobotTask {
  kind: "lift" | "place" | "reach" | "push";
  object: string; // TaskObject id
  anchor: string | null; // place relative to this object id
  relation: "beside" | "on" | "in" | null;
  feasible: boolean;
  reason: string | null;
}

export interface WorldTask {
  title: string;
  goal: string;
  objects: TaskObject[];
  robot_task: RobotTask | null;
}

export interface PhysicsSummary {
  revision: string;
  objects: number;
  valid: boolean;
  goal: [number, number, number] | null; // room coordinates (Z up)
}

export interface ExportSummary {
  feasible: boolean;
  reason: string | null;
  env_name: string | null;
  download_url: string | null;
  checks: Record<string, boolean | string | number> | null;
}

export interface WorldRoom {
  path: string; // "root" | "0" | "0.3"
  parent: string | null;
  children: string[];
  depth: number;
  title: string;
  relation: Relation;
  door_label: string;
  bearing: number; // degrees in the parent room: 0 ahead, positive to the right
  prompt: string; // LingBot World 2 scene prompt
  camera_pitch_hint: "down" | "level";
  seed: number;
  task: WorldTask;
  jobs: { scan: Job; physics: Job; export: Job; children: Job; demo: Job };
  media: {
    arrival: string | null; scan: string | null; storyboard: string | null; preview: string | null;
    demo: string | null; // scripted Panda demo rendered by MuJoCo (1280×704 @ 25 fps)
    demo_reactor: string | null; // the same demo restyled by Reactor video-to-video
  };
  physics: PhysicsSummary | null;
  export: ExportSummary | null;
  robot_demo: DemoSummary | null;
  steps?: TaskStepView[]; // the task program checked in simulation, from server/reactor_world/tasks.py
  // The real data/ footage frame this room's Reactor world is built from (null for rooms Reactor imagined).
  footage?: { source_id: string; file: string; t: number; task_type: string | null } | null;
}

export interface DemoSummary {
  success: boolean;
  steps_completed: number;
  total_steps: number;
  seconds: number;
  reactor: boolean;
  reactor_error: string | null;
  reactor_session_id: string | null;
}

// Interactive robot simulation: POST /rooms/{path}/robot, then a WebSocket at
// `${NEXT_PUBLIC_ROOM_SIM_WS_URL ?? ws://<host>:8000}/worlds/robot-sessions/{id}`. Each tick (25 Hz) the server sends
// one binary JPEG frame followed by one JSON RobotState text message. Close with DELETE /robot-sessions/{id}.
// Robot frame: +x away from the Panda base over the task surface, +y to the robot's left, +z up.
export type TaskStepKind = "reach" | "contact" | "push" | "settle" | "grasp" | "lift" | "hold" | "carry" | "place" | "release";
export interface TaskStepView { id: string; kind: TaskStepKind; title: string; done: boolean; current: boolean }
export interface RobotMetrics {
  goal_distance_m: number;
  object_raised_m: number;
  gripper_to_object_m: number;
  contact: "both fingers" | "one finger" | "none";
  gripper: "open" | "closed";
}
export interface RobotState {
  type: "state";
  mode: "manual" | "demo";
  time: number;
  ticks: number;
  steps: TaskStepView[];
  success: boolean;
  metrics: RobotMetrics;
  gripper_target: [number, number, number];
}
export interface RobotSessionInfo {
  id: string;
  width: number;
  height: number;
  fps: number;
  kind: "lift" | "place" | "reach" | "push";
  state: RobotState;
  layout: { spawn: [number[], number[]]; goal: [number[], number[]]; support: string; object: string; base_side: string };
}
export type RobotCommand =
  | { type: "move"; axes: { x: number; y: number; z: number } } // each -1, 0 or 1 while a key is held
  | { type: "gripper"; closed: boolean }
  | { type: "reset" }
  | { type: "demo" } // run the scripted pick (and place) from a reset
  | { type: "stop" };

export interface WorldSourceRef {
  id: string;
  file: string;
  t: number;
  task_type: string | null;
}

export interface World {
  id: string;
  version: 1;
  status: "planning" | "ready" | "failed";
  error: string | null;
  source: WorldSourceRef;
  hub_title: string;
  summary: string;
  start_url: string;
  rooms: Record<string, WorldRoom>;
  arrival_strategy: "walk" | "helios";
  created_at: string;
  updated_at: string;
  attribution: string;
}

export interface WorldSource {
  id: string;
  file: string;
  label: string;
  task_type: string | null;
  duration: number;
  width: number;
  height: number;
  fps: number;
  poster_url: string;
}

export interface SourcesResponse {
  sources: WorldSource[];
  reactor_configured: boolean;
  planner_configured: boolean;
  playground_available: boolean;
  attribution: string;
}

/** Same shape as `SimulationSession` in app/rooms/types.ts, with a world room id and the task goal. */
export interface WorldPhysicsSession {
  id: string;
  revision: string;
  geoms: RenderGeom[];
  state: PhysicsState;
  spec: { room_id: string; name: string; dimensions: number[]; scale_status: string; appearance: string; objects: RoomObject[]; notes: string[]; version: 1 };
  goal: [number, number, number] | null;
}

export async function worldRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/worlds${path}`, { cache: "no-store", ...init });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = body.error ?? body.detail ?? `World request failed (${response.status})`;
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return body as T;
}
