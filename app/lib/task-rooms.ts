export type EnvironmentId = "kitchen" | "laundry" | "bedroom" | "studio";
export type Relation = "source" | "similar" | "subskill" | "harder" | "variation";

export const RELATIONS: Record<Relation, { label: string; color: string }> = {
  source: { label: "Source task", color: "#bbd7ac" },
  similar: { label: "Similar task", color: "#b7d4b0" },
  subskill: { label: "Go deeper", color: "#a4cbe2" },
  harder: { label: "More advanced", color: "#ebc592" },
  variation: { label: "Variation", color: "#c9b5e1" },
};

export const ENVIRONMENTS = {
  kitchen: { name: "Kitchen", code: "K03", recording: "000/3_video.mp4", start: 8,
    title: "Wash a plate", goal: "Lift the plate from the sink, apply soap, rinse, and scrub its surface.",
    context: "the original kitchen, sink, countertop, plate, dishes, sponge, and egocentric viewpoint" },
  laundry: { name: "Laundry", code: "L01", recording: "000/1_video.mp4", start: 0,
    title: "Fold a garment", goal: "Pick up one garment from the source scene and fold it neatly.",
    context: "the original laundry area, garments, work surface, lighting, and egocentric viewpoint" },
  bedroom: { name: "Bedroom", code: "B120", recording: "000/120_video.mp4", start: 0,
    title: "Make the bed", goal: "Straighten the bedding on the bed visible in the source footage.",
    context: "the original bedroom, bed, bedding, furniture, lighting, and egocentric viewpoint" },
  studio: { name: "Drawing desk", code: "D592", recording: "000/592_video.mp4", start: 0,
    title: "Draw on paper", goal: "Use the drawing tool to make a mark on the paper visible in the source footage.",
    context: "the original drawing workspace, paper, drawing tools, lighting, and egocentric viewpoint" },
} satisfies Record<EnvironmentId, { name: string; code: string; recording: string; start: number; title: string; goal: string; context: string }>;

export function isEnvironment(value: unknown): value is EnvironmentId {
  return typeof value === "string" && Object.hasOwn(ENVIRONMENTS, value);
}

export function validRoomPath(value: unknown): value is string {
  return typeof value === "string" && (value === "root" || /^(?:[0-9]\.){0,63}[0-9]$/.test(value));
}

export type TaskRoom = {
  environment: EnvironmentId;
  path: string;
  title: string;
  goal: string;
  relation: Relation;
  depth: number;
  difficulty: number;
  seed: number;
  parentPath: string | null;
};

type Proposal = [string, string, Exclude<Relation, "source">];

const PROPOSALS: Record<EnvironmentId, Proposal[]> = {
  kitchen: [
    ["Place the plate on the counter", "Lift the plate out of the sink and place it flat on the clear countertop to the right. Release it there without scrubbing.", "similar"],
    ["Rinse the plate", "Hold the plate under the tap and rinse both faces, then set it beside the sink.", "similar"],
    ["Clean the back of the plate", "Turn the plate over, scrub its back with the sponge, and return it to the sink.", "similar"],
    ["Put the sponge beside the sink", "Pick up the sponge and place it on the countertop beside the sink.", "similar"],
    ["Rotate and place the plate", "Lift the plate, rotate it upright so its face is vertical, then rotate it back and place it flat on the countertop.", "subskill"],
    ["Practice a rim grasp", "Grasp the plate by its rim, lift it clear of the sink, hold it steadily, and lower it back.", "subskill"],
    ["Pass the plate between hands", "Lift the plate with the right hand, transfer it to the left hand, and place it flat on the countertop without moving the other dishes.", "harder"],
    ["Wash and stack the plate", "Wash the plate with the sponge, rinse it, and carefully stack it on another plate already visible in the scene.", "harder"],
    ["Wash with the opposite hand", "Hold the plate with the right hand and scrub it with the sponge in the left hand.", "variation"],
    ["Place the plate upright", "Lift the plate and place it upright among the dishes beside the sink, keeping it stable before releasing.", "variation"],
  ],
  laundry: [
    ["Fold a sleeve inward", "Spread one garment on the existing surface and fold one sleeve toward its center.", "similar"],
    ["Smooth a garment", "Lay one garment flat and smooth its creases with both hands.", "similar"],
    ["Fold a garment in half", "Align the edges of one garment and fold it in half.", "similar"],
    ["Move a folded garment", "Pick up a folded garment and place it beside the other laundry on the existing surface.", "similar"],
    ["Align the garment edges", "Grasp two corners of one garment and align its edges before a fold.", "subskill"],
    ["Practice a fabric pinch", "Pinch one corner of a garment, lift it slightly, and lay it down again.", "subskill"],
    ["Fold and stack a garment", "Smooth one garment, fold both sides inward, fold it in half, and add it to the existing laundry stack.", "harder"],
    ["Correct a crooked fold", "Fold a garment, unfold the misaligned edge, and refold it with aligned corners.", "harder"],
    ["Fold from the other side", "Fold one garment while beginning from the opposite side of the work surface.", "variation"],
    ["Make a narrower fold", "Fold one garment into a narrower shape while keeping its edges aligned.", "variation"],
  ],
  bedroom: [
    ["Smooth the duvet", "Smooth the duvet across the bed with both hands.", "similar"],
    ["Straighten a pillow", "Pick up a pillow visible in the source scene and place it straight at the head of the bed.", "similar"],
    ["Pull the bedding straight", "Grasp the visible edge of the bedding and pull it straight across the bed.", "similar"],
    ["Fold the top edge", "Fold the top edge of the bedding back evenly.", "similar"],
    ["Grasp a bedding corner", "Grasp one visible corner of the bedding, lift it, and lay it flat again.", "subskill"],
    ["Align one edge", "Align one side edge of the bedding with the edge of the mattress.", "subskill"],
    ["Make the bed in sequence", "Align the bedding, smooth it from the center outward, fold its top edge, and straighten the visible pillow.", "harder"],
    ["Correct an uneven corner", "Pull one uneven corner straight and smooth the neighboring bedding without disturbing the rest.", "harder"],
    ["Work from the other side", "Straighten the bedding while approaching it from the other side of the bed.", "variation"],
    ["Use smaller smoothing strokes", "Smooth the bedding using short, controlled hand movements.", "variation"],
  ],
  studio: [
    ["Draw a straight line", "Use the existing drawing tool to draw one straight line on the visible paper.", "similar"],
    ["Draw a circle", "Use the existing drawing tool to draw a closed circle on the visible paper.", "similar"],
    ["Shade a small area", "Shade a small area on the visible paper using the existing drawing tool.", "similar"],
    ["Move the drawing tool", "Lift the drawing tool and place it beside the visible paper.", "similar"],
    ["Practice a tool grasp", "Grasp the visible drawing tool, lift it steadily, and return it to the work surface.", "subskill"],
    ["Position the paper", "Hold the visible paper with one hand and straighten its position on the work surface.", "subskill"],
    ["Draw connected shapes", "Draw a straight line, a connected triangle, and a circle using the existing drawing tool on the same paper.", "harder"],
    ["Trace a precise outline", "Use the existing drawing tool to carefully trace an outline already visible on the paper.", "harder"],
    ["Draw with the opposite hand", "Use the opposite hand to draw a short line on the visible paper.", "variation"],
    ["Draw at a smaller scale", "Draw a small closed circle on a clear part of the visible paper.", "variation"],
  ],
};

function seedFor(environment: EnvironmentId, path: string) {
  let seed = 2166136261;
  for (const character of `${environment}:${path}`) seed = Math.imul(seed ^ character.charCodeAt(0), 16777619);
  return (seed >>> 0) % 2_147_483_647;
}

function proposals(room: TaskRoom): Proposal[] {
  if (room.depth === 0) return PROPOSALS[room.environment];
  const goal = room.goal;
  return [
    ["Repeat with a closer grasp", `${goal} Begin by grasping the object closer to its center of mass.`, "similar"],
    ["Use a slower approach", `${goal} Approach the object slowly and maintain control throughout the action.`, "similar"],
    ["Reset and repeat", `${goal} Then return the objects to their original positions and repeat the task once.`, "similar"],
    ["Use a shorter motion", `${goal} Reduce unnecessary hand travel while completing the same goal.`, "similar"],
    ["Practice the first grasp", `Practice only the initial grasp needed for this parent task: ${goal} Lift the object slightly and return it to its starting position.`, "subskill"],
    ["Practice the final release", `Practice only the final placement and release needed for this parent task: ${goal} Keep the object stable before opening the hand.`, "subskill"],
    ["Add a controlled handoff", `${goal} Before the final placement, pass the manipulated object from one hand to the other while keeping it stable.`, "harder"],
    ["Complete two careful cycles", `Complete two consecutive cycles of this task, resetting the objects between cycles: ${goal} Keep neighboring objects undisturbed.`, "harder"],
    ["Vary the starting orientation", `${goal} Start by rotating the manipulated object a quarter turn, then complete the task from that orientation.`, "variation"],
    ["Use the other hand", `${goal} Swap the roles of the left and right hands relative to the source demonstration.`, "variation"],
  ];
}

export function childRooms(room: TaskRoom): TaskRoom[] {
  return proposals(room).map(([title, goal, relation], index) => {
    const path = room.path === "root" ? String(index) : `${room.path}.${index}`;
    return { environment: room.environment, path, title, goal, relation, depth: room.depth + 1,
      difficulty: room.difficulty + (relation === "harder" ? 1 : 0), seed: seedFor(room.environment, path), parentPath: room.path };
  });
}

export function taskRoom(environment: EnvironmentId, path: string = "root"): TaskRoom {
  if (!isEnvironment(environment) || !validRoomPath(path)) throw new Error("Unknown task room");
  const source = ENVIRONMENTS[environment];
  let room: TaskRoom = { environment, path: "root", title: source.title, goal: source.goal,
    relation: "source", depth: 0, difficulty: 1, seed: seedFor(environment, "root"), parentPath: null };
  if (path !== "root") for (const index of path.split(".")) room = childRooms(room)[Number(index)];
  return room;
}

export function roomTrail(room: TaskRoom): TaskRoom[] {
  if (room.path === "root") return [room];
  const segments = room.path.split(".");
  return [taskRoom(room.environment), ...segments.map((_, index) => taskRoom(room.environment, segments.slice(0, index + 1).join(".")))];
}

export function roomNumber(room: TaskRoom) {
  return `${ENVIRONMENTS[room.environment].code}.${room.path === "root" ? "00" : room.path.split(".").map(index => String(Number(index) + 1).padStart(2, "0")).join(".")}`;
}

export function generationPrompt(room: TaskRoom) {
  return `Generate a video experiment that visibly performs this task: ${room.goal} ` +
    `Use the input video as the reference for ${ENVIRONMENTS[room.environment].context}. ` +
    "Change the hand and object action to execute the requested task and show its final outcome. " +
    "Preserve the same physical environment, original object identities, furniture, lighting, and camera viewpoint. " +
    "Do not add rooms, people, tools, or objects absent from the source. Maintain coherent contact and motion.";
}
