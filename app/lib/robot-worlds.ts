import definitions from "../../public/robot-worlds/worlds.json";

export type WorldTheme = typeof definitions[number];
export type TaskKind = "reach" | "push" | "lift";
export const WORLD_THEMES = definitions;
export const validWorldPath = (value: unknown): value is string => typeof value === "string" && /^(root|[0-9](\.[0-9]){0,11})$/.test(value);
export function worldRoom(path: string = "root") {
  if (!validWorldPath(path)) throw new Error("Unknown robot room");
  const parts = path === "root" ? [] : path.split(".").map(Number);
  // Eleven settings make each room's ten destinations distinct from its parent.
  const index = parts.reduce((parent, digit) => (parent + digit + 1) % WORLD_THEMES.length, 0);
  const theme = WORLD_THEMES[index];
  const depth = parts.length;
  const kind = (depth > 1 ? (["reach", "push", "lift"] as const)[(index + depth) % 3] : theme.task) as TaskKind;
  const goal = kind === "reach" ? `Position the gripper over the ${theme.object}` : kind === "push" ? `Push the ${theme.object} onto the goal` : `Grasp and lift the ${theme.object}`;
  return { path, depth, index, theme, kind, goal, parent: depth ? parts.slice(0, -1).join(".") || "root" : null,
    image: `/robot-worlds/${theme.id}.png`, video: `/robot-worlds/${theme.id}.mp4` };
}
export type WorldRoom = ReturnType<typeof worldRoom>;
export function worldGymUrl(room: WorldRoom) {
  return `/world?${new URLSearchParams({ source: `gym:${room.theme.id}`, task: room.kind, from: room.path })}`;
}
export function worldChildren(path: string) {
  if (!validWorldPath(path)) throw new Error("Unknown robot room");
  if (path !== "root" && path.split(".").length >= 12) return [];
  return Array.from({ length: 10 }, (_, i) => worldRoom(path === "root" ? String(i) : `${path}.${i}`));
}
