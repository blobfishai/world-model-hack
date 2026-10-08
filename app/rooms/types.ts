export type RoomId = "kitchen" | "living-room" | "bedroom" | "bathroom";
export interface RoomObject {
  id: string; label: string; kind: string; position: number[]; size: number[];
  yaw: number; color: string; movable: boolean; mass: number; friction: number;
  joint: { travel: number; opening: number };
  evidence: { frame: number; observation: string }[];
}
export interface RoomSpec {
  version: 1; room_id: RoomId; name: string; dimensions: number[];
  scale_status: "estimated" | "calibrated"; appearance: string; objects: RoomObject[]; notes: string[];
}
export interface RoomDetail {
  spec: RoomSpec; revision: string; source_job: string | null;
  validation: { valid: boolean; errors: string[]; bodies: number; geometries: number; joints: number };
  latest_build?: RoomBuildJob | null;
}
export interface PhysicsState {
  type: "state"; tick: number; time: number; paused: boolean; replaying: boolean;
  recorded_commands: number; grabbed_body: number | null; bodies: number[][];
  tasks: { id: string; label: string; progress: number }[];
}
export interface RenderGeom {
  id: number; body_id: number; body_name: string; type: "box" | "cylinder" | "sphere";
  size: number[]; position: number[]; quaternion: number[]; color: number[]; movable: boolean;
}
export interface SimulationSession {
  id: string; revision: string; geoms: RenderGeom[]; state: PhysicsState; spec: RoomSpec;
}
export interface RoomBuildJob {
  id: string; room_id: RoomId; status: string; progress: number; error: string | null;
  filename?: string; frames: { index: number; file: string; timestamp: number }[]; candidate?: RoomSpec;
}
export type Command = { type: string; body_id?: number; point?: number[]; target?: number[]; paused?: boolean };

export async function roomRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, { cache: "no-store", ...init });
  const body = await response.json();
  if (!response.ok) {
    const detail = body.error ?? body.detail ?? "Room request failed";
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return body as T;
}
