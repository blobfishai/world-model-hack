import type { RenderGeom, RoomSpec } from "../rooms/types";
import type { WorldTheme } from "../lib/robot-worlds";

export interface RobotState {
  bodies: number[][];
  robot: {
    controller: string; steps: number; max_steps: number; done: boolean; is_success: boolean;
    failure: string | null; distance: number; grasped: boolean; tool_position: number[];
    gripper_open: boolean; reward: number; return: number;
    task: { id: string; kind: "reach" | "push" | "lift"; label: string; goal: number[]; tolerance: number };
  };
  tasks: { progress: number }[];
}
export interface WorldSession {
  id: string; revision: string; path: string; theme: WorldTheme; goal: number[];
  spec: RoomSpec; geoms: (Omit<RenderGeom, "type"> & { type: RenderGeom["type"] | "mesh"; mesh_id?: number })[]; state: RobotState; sequence: number;
}
export type RobotControl = { type: "action"; action: number[] } | { type: "advance" | "reset" | "take_control" } | { type: "run"; controller: "scripted" };
