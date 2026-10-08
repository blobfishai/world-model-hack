import { test, expect } from "@playwright/test";
import { worldChildren, worldRoom } from "../app/lib/robot-worlds";
import { acceptSequenceChunk, doorSequence, taskSequence } from "../app/worlds/reactor-director";
import { composeGymPrompt } from "../app/worlds/reactor-prompts";

test("task sequences wait for their actual prompt and reject duplicate or delayed chunks", () => {
  const run = taskSequence(worldRoom("1"), 0, "");
  const chunk = { chunk_index: 8, active_prompt: run.steps[0].prompt, active_action: "idle", frames_emitted: 24 };
  expect(acceptSequenceChunk(run, { ...chunk, active_prompt: "previous room" })).toBe(run);
  const first = acceptSequenceChunk(run, chunk);
  expect(first.index).toBe(0);
  expect(first.received).toBe(24);
  expect(acceptSequenceChunk(first, chunk)).toBe(first);
  expect(acceptSequenceChunk(first, { ...chunk, chunk_index: 7 })).toBe(first);
  expect(acceptSequenceChunk(first, { ...chunk, chunk_index: 9, frames_emitted: 0 })).toBe(first);
});

test("a generated chunk cannot complete future task steps before their prompts arrive", () => {
  let run = taskSequence(worldRoom("1"), 0, "");
  const oldPrompt = run.steps[0].prompt;
  run = acceptSequenceChunk(run, { chunk_index: 1, active_prompt: oldPrompt, active_action: "idle", frames_emitted: 1000 });
  expect(run.index).toBe(1);
  expect(run.received).toBe(0);
  expect(acceptSequenceChunk(run, { chunk_index: 2, active_prompt: oldPrompt, active_action: "idle", frames_emitted: 1000 })).toBe(run);
  while (run.index < run.steps.length) {
    const step = run.steps[run.index];
    run = acceptSequenceChunk(run, { chunk_index: run.lastChunk + 1, active_prompt: step.prompt, active_action: "idle", frames_emitted: step.frames });
  }
  expect(run.index).toBe(run.steps.length);
});

test("doorway navigation requires generated forward movement before entering the next room", () => {
  const room = worldRoom("1.2.1.2.3"), target = worldChildren(room.path)[0];
  let run = doorSequence(room, target, "Warm sunlight.");
  expect(run.destination).toBe(target.path);
  expect(run.steps[0].prompt).toContain(target.theme.name);
  run = acceptSequenceChunk(run, { chunk_index: 4, active_prompt: run.steps[0].prompt, active_action: "idle", frames_emitted: 96 });
  expect(run.index).toBe(1);
  const walk = { chunk_index: 5, active_prompt: run.steps[1].prompt, active_action: "idle", frames_emitted: 144 };
  expect(acceptSequenceChunk(run, walk)).toBe(run);
  expect(acceptSequenceChunk(run, { ...walk, active_action: "w" }).index).toBe(2);
});

test("each task uses compatible manipulation phases and preserves the user's scene direction", () => {
  const reach = taskSequence(worldRoom(), 0, "Warm sunlight.");
  expect(reach.steps.map(step => step.phase)).toEqual(["approach", "execute", "release"]);
  expect(reach.steps.at(-1)?.prompt).toContain("stays resting on the workbench");
  const push = taskSequence(worldRoom("0"), 0, "Warm sunlight.");
  expect(push.steps[1].prompt).toContain("flat outer face");
  expect(push.steps.at(-1)?.prompt).not.toContain("lowers the ceramic block into");
  const lift = taskSequence(worldRoom("1"), 0, "Warm sunlight.");
  expect(lift.steps.map(step => step.phase)).toEqual(["approach", "grasp", "execute", "release"]);
  for (const run of [reach, push, lift]) for (const step of run.steps) expect(step.prompt).toContain("Scene direction: Warm sunlight.");
});

test("scene direction and custom robot instructions fit Reactor's prompt limit in every room", () => {
  for (const room of [worldRoom(), ...worldChildren("root"), ...worldChildren("1.2.1.2.3")]) {
    for (const walking of [true, false]) {
      const prompt = composeGymPrompt(room, "execute", walking, 123, "A".repeat(1000), "B".repeat(1000));
      expect(prompt.length, room.theme.name).toBeLessThanOrEqual(2000);
      expect(prompt).toContain("A".repeat(220));
      expect(prompt).toContain("B".repeat(220));
      expect(prompt).toContain(walking ? "Movement input moves the observer" : "Camera position holds still");
    }
  }
});
