import { PlayApp } from "./PlayApp";

export const dynamic = "force-dynamic";
export const metadata = { title: "Fieldwork — a world of small actions", description: "Walk between task rooms, learn from real footage, and see your world rendered live by Reactor." };

export default function PlayPage() {
  return <PlayApp reactorConfigured={!!process.env.REACTOR_API_KEY} />;
}
