import "server-only";

import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { ENVIRONMENTS, isEnvironment, type EnvironmentId } from "./task-rooms";

const execute = promisify(execFile);
export const ROOM_HOME = path.resolve(process.env.TASK_ROOMS_HOME ?? path.join(process.cwd(), ".task-rooms"));
export const EXPERIMENT_HOME = path.join(ROOM_HOME, "experiments");

export type EnvironmentMedia = { available: boolean; sourceUrl: string; posterUrl: string;
  attempts: Record<string, { url: string; verdict: "mismatch" }> };
export type RoomMedia = Record<EnvironmentId, EnvironmentMedia>;

async function exists(file: string) {
  return stat(file).then(info => info.isFile()).catch(() => false);
}

async function probeAssets(): Promise<Record<string, string>> {
  const folder = path.join(ROOM_HOME, "probes");
  const runs = await readdir(folder).catch(() => [] as string[]);
  for (const run of runs.sort().reverse()) {
    try {
      const report = JSON.parse(await readFile(path.join(folder, run, "report.json"), "utf8"));
      if (!String(report.source?.source_path).endsWith("/000/3_video.mp4")) continue;
      const files: Record<string, string> = {};
      if (await exists(path.join(folder, run, "source.mp4"))) files["kitchen-source"] = path.join(folder, run, "source.mp4");
      for (const [caseId, index] of [["different-goal", 0], ["additional-step", 4], ["harder-task", 6]] as const) {
        const entry = report.cases?.find((item: { id?: string; status?: string }) => item.id === caseId && item.status === "rejected");
        const file = path.join(folder, run, `${caseId}.mp4`);
        if (entry && await exists(file)) files[`kitchen-attempt-${index}`] = file;
      }
      if (Object.keys(files).length === 4) return files;
    } catch { /* Ignore incomplete probe receipts. */ }
  }
  return {};
}

export async function roomMedia(): Promise<RoomMedia> {
  const probes = await probeAssets();
  const entries = await Promise.all(Object.keys(ENVIRONMENTS).map(async value => {
    const id = value as EnvironmentId;
    const source = path.join(process.cwd(), "data", ENVIRONMENTS[id].recording);
    const attempts: EnvironmentMedia["attempts"] = {};
    for (const index of [0, 4, 6]) if (probes[`${id}-attempt-${index}`]) attempts[String(index)] = {
      url: `/api/rooms/media/${id}-attempt-${index}`, verdict: "mismatch",
    };
    return [id, { available: await exists(probes[`${id}-source`] ?? source),
      sourceUrl: `/api/rooms/media/${id}-source`, posterUrl: `/api/rooms/media/${id}-poster`, attempts }] as const;
  }));
  return Object.fromEntries(entries) as RoomMedia;
}

const pendingPosters = new Map<string, Promise<string>>();

export async function mediaPath(asset: string, attempt?: number): Promise<string | null> {
  const playable = /^play-(dishes|laundry|drawing)-(source|poster)$/.exec(asset);
  if (playable) {
    const file = path.join(ROOM_HOME, "world", "media", `${playable[1]}.${playable[2] === "source" ? "mp4" : "jpg"}`);
    if (await exists(file)) return file;
    const environment = { dishes: "kitchen", laundry: "laundry", drawing: "studio" }[playable[1]]!;
    // Only the original recording can be a fallback for a playable demonstration.
    if (playable[2] === "source") {
      const source = path.join(process.cwd(), "data", ENVIRONMENTS[environment as EnvironmentId].recording);
      return await exists(source) ? source : null;
    }
    return mediaPath(`${environment}-poster`);
  }
  if (/^experiment-[a-f0-9]{24}$/.test(asset)) {
    const id = asset.slice("experiment-".length);
    try {
      let job = JSON.parse(await readFile(path.join(EXPERIMENT_HOME, id, "job.json"), "utf8"));
      if (attempt !== undefined && attempt !== Number(job.attempt)) {
        if (!Number.isSafeInteger(attempt) || attempt <= 0) return null;
        job = JSON.parse(await readFile(path.join(EXPERIMENT_HOME, id, `attempt-${attempt}.json`), "utf8"));
      }
      const filename = `generated-${Number(job.attempt)}.mp4`;
      const file = path.join(EXPERIMENT_HOME, id, filename);
      return job.generation && await exists(file) ? file : null;
    } catch { return null; }
  }
  const match = /^(kitchen|laundry|bedroom|studio)-(source|poster|attempt-[046])$/.exec(asset);
  if (!match || !isEnvironment(match[1])) return null;
  const environment = match[1];
  const probes = await probeAssets();
  if (match[2].startsWith("attempt")) return probes[asset] ?? null;
  const source = probes[`${environment}-source`] ?? path.join(process.cwd(), "data", ENVIRONMENTS[environment].recording);
  if (!await exists(source)) return null;
  if (match[2] === "source") return source;
  const destination = path.join(ROOM_HOME, "previews", `${environment}.jpg`);
  if (await exists(destination)) return destination;
  let pending = pendingPosters.get(environment);
  if (!pending) {
    pending = (async () => {
      await mkdir(path.dirname(destination), { recursive: true });
      const { stdout } = await execute("ffmpeg", ["-v", "error", "-ss", "1.2", "-i", source,
        "-frames:v", "1", "-vf", "scale=960:-2", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1"],
        { encoding: "buffer", timeout: 30_000, maxBuffer: 5 * 1024 * 1024 });
      const temporary = `${destination}.${randomUUID()}.tmp`;
      await writeFile(temporary, stdout);
      await rename(temporary, destination);
      return destination;
    })().finally(() => pendingPosters.delete(environment));
    pendingPosters.set(environment, pending);
  }
  return pending;
}
