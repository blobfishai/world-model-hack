import { NextRequest } from "next/server";
import { proxyRoomRequest } from "@/app/lib/room-proxy";

export const dynamic = "force-dynamic";
export async function GET(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  return proxyRoomRequest(request, ["room-builds", ...(await context.params).path]);
}
