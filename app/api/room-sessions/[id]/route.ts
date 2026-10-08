import { NextRequest } from "next/server";
import { proxyRoomRequest } from "@/app/lib/room-proxy";

export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return proxyRoomRequest(request, ["sessions", (await context.params).id]);
}
