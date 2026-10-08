import { NextRequest } from "next/server";
import { proxyRoomRequest } from "@/app/lib/room-proxy";

export const dynamic = "force-dynamic";
async function handle(request: NextRequest, context: { params: Promise<{ path?: string[] }> }) {
  const { path = [] } = await context.params;
  return proxyRoomRequest(request, ["worlds", ...path]);
}
export { handle as GET, handle as POST, handle as DELETE };
