import type { WorldRoom } from "../lib/robot-worlds";

export type TaskPhase = "ready" | "approach" | "grasp" | "execute" | "release";
export const TASK_PHASES: TaskPhase[] = ["ready", "approach", "grasp", "execute", "release"];

export function taskPhases(room: WorldRoom): TaskPhase[] {
  return room.kind === "reach" ? ["approach", "execute", "release"] : TASK_PHASES.slice(1);
}

export function phaseLabel(room: WorldRoom, phase: TaskPhase): string {
  return ({ ready: "Robot at rest", approach: "Reach the object", grasp: room.kind === "push" ? "Contact the object" : "Close the fingers",
    execute: room.kind === "push" ? "Push to the tray" : room.kind === "reach" ? "Align over the object" : "Lift the object",
    release: room.kind === "lift" ? "Place and release" : "Retract the arm" })[phase];
}

/** Each input changes exactly one prompt layer, as recommended by LingBot's guide. */
export function composeGymPrompt(room: WorldRoom, phase: TaskPhase, walking = false, variation = 0, instruction = "", direction = ""): string {
  const object = room.theme.object;
  const base = `Photorealistic ${room.theme.name} robot workcell. ${room.theme.description} Exactly one white seven-joint Franka Panda arm with black joint covers, metal parallel fingers, cabling and a bolted base. Exactly one ${object} and one receiving tray on its workbench. Detailed materials, realistic shadows, reflections and worn surfaces. The robot base, workbench and room landmarks keep their positions.`;
  const camera = walking
    ? "External eye-level view of the complete workbench and its single bench-mounted arm from the aisle. Movement input moves the observer through the room; look input turns the view. The robot base stays bolted to the same workbench as the observer walks."
    : "External eye-level view of the complete workbench and its single bench-mounted arm from across the aisle. Camera position holds still while movement input is idle. Only look input turns the view. No camera zoom or close-up of the fingers. The whole arm, its bolted base and the bench stay in the same wide framing.";
  const event = instruction.trim()
    ? `The robot performs this task slowly: ${instruction.trim().replace(/\s+/g, " ").slice(0, 220)}. Keep the same arm, object, workbench and environment. The robot holds its final pose.`
    : ({
    ready: `The robot rests with its open fingers above the ${object}. Its joints and fingers hold their pose.`,
    approach: `The robot's articulated joints slowly lower the open fingers to either side of the ${object}. It finishes with the fingers beside the object and holds this pose.`,
    grasp: room.kind === "push"
      ? `The same arm closes its empty fingers and brings their flat outer face against the side of the ${object}. The object remains supported by the workbench. The arm holds this contact pose.`
      : `The same arm's single two-finger gripper closes gently around the sides of the ${object}. The object remains on the workbench. The same bolted robot base remains visible at the same workbench. The gripper finishes closed and holds still.`,
    execute: room.kind === "push"
      ? `The closed fingers move horizontally, pushing the ${object} across the workbench toward the receiving tray. The object slides along the surface and comes to rest beside the tray.`
      : room.kind === "reach"
        ? `The robot gently adjusts its wrist until the open fingers are centered just above the ${object}. The arm finishes aligned with the object and holds still.`
        : `The same arm's single gripper slowly lifts the ${object} a hand's width above the workbench. The same bolted base stays on the same workbench. The object remains between the two fingers. The gripper finishes raised and holds still.`,
    release: room.kind === "lift"
      ? `The robot lowers the ${object} into the receiving tray, opens both fingers, then retracts slightly. The object rests in the tray and the robot holds its final pose.`
      : `The robot retracts its arm slightly and holds still. The ${object} stays resting on the workbench at its current position.`,
  })[phase];
  const challenge = room.depth > 1 ? `This task requires careful placement with a smaller clearance around the ${object}.` : "";
  const variant = variation ? `Variation ${variation}: the ${object} is a little closer to the rear of the workbench; its surface has a different natural material finish.` : "";
  const directed = direction.trim() ? `Scene direction: ${direction.trim().replace(/\s+/g, " ").slice(0, 220)}` : "";
  return [base, camera, event, challenge, variant, directed].filter(Boolean).join(" ");
}

export function composeDoorPrompt(room: WorldRoom, destination: WorldRoom, walking: boolean, direction = ""): string {
  return `Photorealistic ${room.theme.name} robot workcell. ${room.theme.description} `
    + `The same single white Franka Panda arm and ${room.theme.object} stay on their original bench. `
    + `Ahead, an open doorway leads into ${destination.theme.name}: ${destination.theme.description} `
    + (walking ? "Movement input carries the observer forward along the clear aisle toward that doorway. "
      : "The observer pauses at eye level to face the open doorway. Camera position holds still while movement input is idle. ")
    + "Detailed physical materials, natural lighting, coherent perspective and realistic shadows. The robot stays behind at its bench. "
    + (direction.trim() ? `Scene direction: ${direction.trim().replace(/\s+/g, " ").slice(0, 220)}` : "");
}
