import { NextResponse } from "next/server";
import { ENVIRONMENTS, isEnvironment, validRoomPath, taskRoom } from "@/app/lib/task-rooms";
import { experimentId, experimentView, requestExperiment, QueueFull } from "@/app/lib/room-jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const environment = url.searchParams.get("environment");
  const room = url.searchParams.get("room") ?? "root";
  if (!isEnvironment(environment) || !validRoomPath(room)) return NextResponse.json({ error: "Unknown task room" }, { status: 400 });
  return NextResponse.json({ experiment: await experimentView(experimentId(taskRoom(environment, room))) }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      // Next may construct request.url with its internal host. The browser's
      // Origin must match the actual HTTP Host, including the preview port.
      const publicHost = request.headers.get("host") ?? new URL(request.url).host;
      const parsedOrigin = new URL(origin);
      if (!["http:", "https:"].includes(parsedOrigin.protocol) || parsedOrigin.host !== publicHost) throw new Error("Cross-origin request");
    } catch {
      return NextResponse.json({ error: "Use the room explorer to start an experiment." }, { status: 403 });
    }
  }
  const body = await request.json().catch(() => null);
  if (!body || !isEnvironment(body.environment) || !validRoomPath(body.room) || (body.force !== undefined && typeof body.force !== "boolean")) {
    return NextResponse.json({ error: "Choose a valid environment and task room." }, { status: 400 });
  }
  if (!process.env.REACTOR_API_KEY) return NextResponse.json({ error: "REACTOR_API_KEY is not configured on the server." }, { status: 503 });
  try {
    const room = taskRoom(body.environment, body.room);
    // The task and original source are derived on the server, never supplied as arbitrary paths or commands.
    if (!Object.hasOwn(ENVIRONMENTS, room.environment)) throw new Error("Unknown environment");
    return NextResponse.json({ experiment: await requestExperiment(room, body.force === true) }, { status: 202 });
  } catch (error) {
    if (error instanceof QueueFull) return NextResponse.json({ error: error.message }, { status: 429 });
    return NextResponse.json({ error: "The experiment could not be started. Try again." }, { status: 500 });
  }
}
