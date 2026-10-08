import type { Metadata } from "next";
import WorldApp from "./WorldApp";
import { validRoomPath, validWorldId } from "./lib/rooms";
import { validWorldPath } from "../lib/robot-worlds";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Reactor World — walk the beginning image",
  description: "Walk a Reactor LingBot World 2 world generated from a recording's first frame, then export each task room to MuJoCo Playground.",
};

export default async function WorldPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const search = await searchParams;
  const world = validWorldId(search.w) ? search.w : null;
  const room = validRoomPath(search.room) ? search.room : "root";
  const backend = new URL(process.env.ROOM_SIM_WS_URL ?? process.env.NEXT_PUBLIC_ROOM_SIM_WS_URL ?? process.env.ROOM_SIM_URL ?? "http://127.0.0.1:8000");
  backend.protocol = ["https:", "wss:"].includes(backend.protocol) ? "wss:" : "ws:";
  return <WorldApp initialWorld={world} initialRoom={room} initialFromRoom={validWorldPath(search.from) ? search.from : null}
    initialView={search.view === "robot" ? "robot" : "world"} socketBase={backend.toString().replace(/\/$/, "")} reactorConfigured={!!process.env.REACTOR_API_KEY} />;
}
