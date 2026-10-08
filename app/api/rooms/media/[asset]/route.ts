import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { byteRange } from "@/app/lib/byte-range";
import { mediaPath } from "@/app/lib/room-media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function response(request: Request, context: { params: Promise<{ asset: string }> }, head: boolean) {
  const { asset } = await context.params;
  const attempt = new URL(request.url).searchParams.get("attempt");
  if (attempt !== null && !/^[1-9][0-9]{0,8}$/.test(attempt)) return new Response("Invalid attempt", { status: 400 });
  const file = await mediaPath(asset, attempt === null ? undefined : Number(attempt));
  if (!file) return new Response("Media unavailable", { status: 404 });
  const info = await stat(file);
  const headers = new Headers({ "Content-Type": file.endsWith(".jpg") ? "image/jpeg" : "video/mp4",
    "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff" });
  try {
    const range = byteRange(request.headers.get("range"), info.size);
    const start = range?.start ?? 0;
    const end = range?.end ?? info.size - 1;
    headers.set("Content-Length", String(end - start + 1));
    if (range) headers.set("Content-Range", `bytes ${start}-${end}/${info.size}`);
    if (head) return new Response(null, { status: range ? 206 : 200, headers });
    const stream = createReadStream(file, { start, end });
    return new Response(Readable.toWeb(stream) as ReadableStream, { status: range ? 206 : 200, headers });
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    headers.set("Content-Range", `bytes */${info.size}`);
    return new Response(null, { status: 416, headers });
  }
}

export const GET = (request: Request, context: { params: Promise<{ asset: string }> }) => response(request, context, false);
export const HEAD = (request: Request, context: { params: Promise<{ asset: string }> }) => response(request, context, true);
