import type { Metadata } from "next";
import WorldApp from "./WorldApp";
import { validRoomPath, validWorldId } from "./lib/rooms";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Reactor World — walk the beginning image",
  description: "Walk a Reactor LingBot World 2 world generated from a recording's first frame, then export each task room to MuJoCo Playground.",
};

export default async function WorldPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const search = await searchParams;
  const world = validWorldId(search.w) ? search.w : null;
  const room = validRoomPath(search.room) ? search.room : "root";
  return <WorldApp initialWorld={world} initialRoom={room} reactorConfigured={!!process.env.REACTOR_API_KEY} />;
}
