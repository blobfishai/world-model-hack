import type { WorldRoom } from "../lib/robot-worlds";
import type { Axes } from "../world/lib/controls";
import { composeDoorPrompt, composeGymPrompt, phaseLabel, taskPhases, type TaskPhase } from "./reactor-prompts";

export interface GenerationStep {
  label: string;
  prompt: string;
  frames: number;
  phase?: TaskPhase;
  axes?: Partial<Axes>;
}

export interface GenerationSequence {
  mode: "task" | "door";
  steps: GenerationStep[];
  index: number;
  received: number;
  lastChunk: number;
  destination?: string;
}

export function taskSequence(room: WorldRoom, variation: number, direction: string): GenerationSequence {
  return { mode: "task", index: 0, received: 0, lastChunk: -1,
    steps: taskPhases(room).map(phase => ({ phase, label: phaseLabel(room, phase),
      prompt: composeGymPrompt(room, phase, false, variation, "", direction), frames: phase === "execute" ? 144 : 96 })) };
}

export function doorSequence(room: WorldRoom, destination: WorldRoom, direction: string): GenerationSequence {
  return { mode: "door", destination: destination.path, index: 0, received: 0, lastChunk: -1, steps: [
    { label: "Looking toward the doorway", prompt: composeDoorPrompt(room, destination, false, direction), frames: 96 },
    { label: `Walking toward ${destination.theme.name}`, prompt: composeDoorPrompt(room, destination, true, direction),
      frames: 144, axes: { move_longitudinal: "forward" } },
  ] };
}

/** Progress describes generated frames, never physical task success. */
export function acceptSequenceChunk(sequence: GenerationSequence, chunk: {
  chunk_index: number; active_prompt: string; active_action: string; frames_emitted: number;
}): GenerationSequence {
  const step = sequence.steps[sequence.index];
  if (!step || chunk.chunk_index <= sequence.lastChunk || chunk.active_prompt !== step.prompt
    || !Number.isFinite(chunk.frames_emitted) || chunk.frames_emitted <= 0) return sequence;
  if (step.axes?.move_longitudinal === "forward" && !chunk.active_action.split("+").includes("w")) return sequence;
  const received = sequence.received + chunk.frames_emitted;
  return { ...sequence, lastChunk: chunk.chunk_index,
    index: received >= step.frames ? sequence.index + 1 : sequence.index,
    received: received >= step.frames ? 0 : received };
}
