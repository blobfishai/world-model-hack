import { experimentView } from "@/app/lib/room-jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const initial = await experimentView(id);
  if (!initial) return Response.json({ error: "Unknown experiment" }, { status: 404 });
  if (new URL(request.url).searchParams.get("stream") !== "1") return Response.json(initial, { headers: { "Cache-Control": "no-store" } });
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      let previous = "";
      const started = Date.now();
      const send = async () => {
        if (stopped) return;
        try {
          const job = await experimentView(id);
          if (stopped) return;
          const data = JSON.stringify(job);
          if (data !== previous) { controller.enqueue(encoder.encode(`data: ${data}\n\n`)); previous = data; }
          if (!job || ["ready", "failed"].includes(job.status) || Date.now() - started > 7 * 60_000) {
            stopped = true;
            controller.close();
          } else timer = setTimeout(send, 1000);
        } catch { if (!stopped) { stopped = true; controller.close(); } }
      };
      request.signal.addEventListener("abort", () => { stopped = true; if (timer) clearTimeout(timer); }, { once: true });
      void send();
    },
    cancel() { stopped = true; if (timer) clearTimeout(timer); },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" } });
}
