import type { WorldRoom } from "../lib/robot-worlds";

export const LAB_LOOKS = {
  natural: { label: "Natural", edit: "photographic daylight, physically plausible soft shadows, fine surface texture and subtle reflections" },
  studio: { label: "Studio", edit: "neutral inspection lighting, brushed metal, crisp material texture and soft contact shadows" },
  evening: { label: "Evening shift", edit: "warm practical lights, cool ambient fill, subtle reflections and soft contact shadows" },
} as const;
export type LabLook = keyof typeof LAB_LOOKS;
export const RENDER_LOOKS = LAB_LOOKS;
export type RenderLook = LabLook;

export function physicsRenderPrompt(room: WorldRoom, look: LabLook, direction = "") {
  return `Re-render the visible ${room.theme.name} simulation as photographic footage with ${LAB_LOOKS[look].edit}. ` +
    `Refine the existing ${room.theme.description.toLowerCase().replace(/\.$/, "")}, workbench, white Franka Panda arm and ${room.theme.object} without changing their shapes or layout. ` +
    (direction.trim() ? `Appearance direction: ${direction.trim().slice(0, 220)}. ` : "") +
    "Preserve the exact seven robot joints, both gripper fingers, object identities, object positions, contact points, goal marker, camera perspective and all source motion and timing; change appearance only, with consistent materials across frames.";
}

export function physicsRenderSeed(path: string) {
  return Array.from(path).reduce((value, character) => (Math.imul(value, 31) + character.charCodeAt(0)) >>> 0, 42);
}
