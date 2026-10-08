import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { WORLD_THEMES, validWorldPath } from "../lib/robot-worlds";
import WorldApp from "./WorldApp";
import type { GeneratedGym } from "./ReactorGym";

export const dynamic = "force-dynamic";
export const metadata = { title: "Reactor Robot Worlds — Rooms", description: "Walk through live Reactor worlds and direct robot task experiments." };
export default async function WorldsPage({ searchParams }: { searchParams: Promise<{ room?: string; mode?: string }> }) {
  const query = await searchParams;
  const videos = (await Promise.all(WORLD_THEMES.map(async theme => {
    try { await access(path.join(process.cwd(), "public/robot-worlds", `${theme.id}.mp4`)); return theme.id; } catch { return null; }
  }))).filter((id): id is string => id !== null);
  const generated = (await Promise.all(WORLD_THEMES.map(async theme => {
    try {
      const receipt = JSON.parse(await readFile(path.join(process.cwd(), "public/reactor-gyms", `${theme.id}.json`), "utf8"));
      if (receipt.status !== "ready") throw new Error("Generation still awaiting review");
      await Promise.all(["jpg", "mp4"].map(ext => access(path.join(process.cwd(), "public/reactor-gyms", `${theme.id}.${ext}`))));
      return { theme: theme.id, image: `/reactor-gyms/${theme.id}.jpg`, video: `/reactor-gyms/${theme.id}.mp4`,
        model: receipt.walk_generation?.model ?? receipt.seed_generation?.model, seedSource: receipt.seed_source } as GeneratedGym;
    } catch {
      try {
        const receipt = JSON.parse(await readFile(path.join(process.cwd(), "public/robot-worlds/generated", `${theme.id}.json`), "utf8"));
        await Promise.all(["jpg", "mp4"].map(ext => access(path.join(process.cwd(), "public/robot-worlds/generated", `${theme.id}.${ext}`))));
        return { theme: theme.id, image: `/robot-worlds/generated/${theme.id}.jpg`, video: `/robot-worlds/generated/${theme.id}.mp4`,
          model: receipt.model, seedSource: "reference" } as GeneratedGym;
      } catch { return null; }
    }
  }))).filter((asset): asset is GeneratedGym => asset !== null);
  return <WorldApp initialPath={validWorldPath(query.room) ? query.room : "root"} initialMode={query.mode === "physics" ? "physics" : "reactor"}
    videos={videos} generated={generated} reactorConfigured={Boolean(process.env.REACTOR_API_KEY)} />;
}
