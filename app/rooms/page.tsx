import type { Metadata } from "next";
import { roomMedia } from "../lib/room-media";
import { isEnvironment, validRoomPath } from "../lib/task-rooms";
import RoomExplorer from "./RoomExplorer";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Rooms — Robofish", description: "Walk through video task experiments. One environment, ten paths forward." };

export default async function RoomsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const search = await searchParams;
  const environment = isEnvironment(search.environment) ? search.environment : "kitchen";
  const room = validRoomPath(search.room) ? search.room : "root";
  return <RoomExplorer media={await roomMedia()} initialEnvironment={environment} initialPath={room} reactorConfigured={!!process.env.REACTOR_API_KEY} />;
}
