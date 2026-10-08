import "server-only";

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { EXPERIMENT_HOME } from "./room-media";
import { ENVIRONMENTS, generationPrompt, type TaskRoom } from "./task-rooms";
import type { ExperimentView } from "./room-experiment-types";

type Job = Record<string, unknown> & { id: string; status: ExperimentView["status"]; message: string; attempt: number; updated_at: string };
type Queue = { active: string | null; pending: string[] };
const globalJobs = globalThis as typeof globalThis & { __taskRoomQueue?: Queue };
const queue = globalJobs.__taskRoomQueue ??= { active: null, pending: [] };

export class QueueFull extends Error {}

export function experimentId(room: TaskRoom) {
  return createHash("sha256").update(JSON.stringify(["room-experiment-v1", room.environment, room.path,
    generationPrompt(room), room.seed, "reactor/sana-streaming"])).digest("hex").slice(0, 24);
}

async function readJob(id: string): Promise<Job | null> {
  if (!/^[a-f0-9]{24}$/.test(id)) return null;
  try { return JSON.parse(await readFile(path.join(EXPERIMENT_HOME, id, "job.json"), "utf8")); }
  catch { return null; }
}

async function saveJob(job: Job) {
  const folder = path.join(EXPERIMENT_HOME, job.id);
  await mkdir(folder, { recursive: true });
  const temporary = path.join(folder, `${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(job, null, 2));
  await rename(temporary, path.join(folder, "job.json"));
}

export async function experimentView(id: string): Promise<ExperimentView | null> {
  let job = await readJob(id);
  if (!job) return null;
  if (!["ready", "failed"].includes(job.status) && Date.now() - Date.parse(job.updated_at) > 7 * 60_000) {
    job = { ...job, status: "failed", message: "This experiment was interrupted. You can run it again.", updated_at: new Date().toISOString() };
    await saveJob(job);
  }
  const review = job.review as { verdict: "matched" | "mismatch" | "unreviewed"; observed_actions: string; failure_reasons: string[] } | undefined;
  return { id: job.id, status: job.status, message: String(job.message ?? ""), attempt: job.attempt,
    assetUrl: job.generation ? `/api/rooms/media/experiment-${id}?attempt=${job.attempt}` : null,
    error: typeof job.error === "string" ? job.error : null,
    review: review ? { verdict: review.verdict, observedActions: review.observed_actions, reasons: review.failure_reasons } : null };
}

function pump() {
  if (queue.active || !queue.pending.length) return;
  const id = queue.pending.shift()!;
  queue.active = id;
  const child = spawn("uv", ["run", "python", "-m", "task_rooms.room_experiment", id], {
    cwd: process.cwd(), env: process.env, stdio: ["ignore", "ignore", "ignore"],
  });
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => {
    child.kill("SIGTERM");
    killTimer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    killTimer.unref();
  }, 360_000);
  timer.unref();
  let ended = false;
  async function finish(code: number | null) {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
    try {
      const job = await readJob(id);
      if (job && !["ready", "failed"].includes(job.status)) await saveJob({ ...job, status: "failed",
        message: code === null ? "Experiment worker could not start or was interrupted." : "Experiment worker stopped before completion.",
        error: "Run the experiment again. Check that uv, FFmpeg, and REACTOR_API_KEY are configured.", updated_at: new Date().toISOString() });
    } finally {
      queue.active = null;
      pump();
    }
  }
  child.once("error", () => { void finish(null); });
  child.once("exit", code => { void finish(code); });
}

// Serialize queue admission as well as GPU work: double clicks must not create two paid sessions.
let admission: Promise<unknown> = Promise.resolve();
export function requestExperiment(room: TaskRoom, force = false): Promise<ExperimentView> {
  const operation = admission.then(async () => {
    const id = experimentId(room);
    const previous = await readJob(id);
    if (previous && (!force || queue.active === id || queue.pending.includes(id))) return (await experimentView(id))!;
    if (queue.pending.length >= 2) throw new QueueFull("Two experiments are already waiting. Explore the rooms and try again after one finishes.");
    if (previous) await writeFile(path.join(EXPERIMENT_HOME, id, `attempt-${previous.attempt}.json`), JSON.stringify(previous, null, 2));
    const job: Job = { id, environment: room.environment, room_path: room.path, title: room.title,
      task: room.goal, prompt: generationPrompt(room), seed: room.seed,
      source_recording: ENVIRONMENTS[room.environment].recording, status: "queued",
      message: queue.active ? "Waiting for the current Reactor experiment." : "Preparing this room’s video experiment.",
      attempt: (previous?.attempt ?? 0) + 1, updated_at: new Date().toISOString() };
    await saveJob(job);
    queue.pending.push(id);
    pump();
    return (await experimentView(id))!;
  });
  admission = operation.catch(() => undefined);
  return operation;
}
