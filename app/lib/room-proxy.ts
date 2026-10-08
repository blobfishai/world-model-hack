import { NextRequest, NextResponse } from "next/server";

export async function proxyRoomRequest(request: NextRequest, path: string[]) {
  const base = process.env.ROOM_SIM_URL ?? "http://127.0.0.1:8000";
  const url = new URL(path.map(encodeURIComponent).join("/"), `${base.replace(/\/$/, "")}/`);
  url.search = request.nextUrl.search;
  const headers = new Headers();
  for (const name of ["content-type", "range"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  try {
    const response = await fetch(url, {
      method: request.method,
      headers,
      body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
      duplex: "half",
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    } as RequestInit);
    const output = new Headers({ "Cache-Control": "no-store" });
    for (const name of ["content-type", "content-length", "content-range", "accept-ranges", "content-disposition"]) {
      const value = response.headers.get(name);
      if (value) output.set(name, value);
    }
    return new Response(response.body, { status: response.status, headers: output });
  } catch {
    return NextResponse.json(
      { error: "The room service is offline. Run pnpm rooms:server in another terminal." },
      { status: 503 },
    );
  }
}
