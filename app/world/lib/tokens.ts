// Session-scoped Reactor JWTs from /api/reactor/token, memoized per model for their lifetime (see HeliosApp):
// a session is bound to the token that created it.
export type ReactorModelKey = "lingbot-world-2" | "sana-streaming";

const REFRESH_SKEW_MS = 60_000;
const cached = new Map<ReactorModelKey, { jwt: string; expiresAtMs: number }>();
const inflight = new Map<ReactorModelKey, Promise<string>>();

export function reactorToken(model: ReactorModelKey): Promise<string> {
  const hit = cached.get(model);
  if (hit && Date.now() < hit.expiresAtMs - REFRESH_SKEW_MS) return Promise.resolve(hit.jwt);
  const pending = inflight.get(model);
  if (pending) return pending;
  const request = (async () => {
    try {
      const response = await fetch(`/api/reactor/token?model=${model}`, { cache: "no-store" });
      const body = (await response.json().catch(() => ({}))) as { jwt?: string; expires_at?: number; error?: string; code?: string };
      if (!response.ok || !body.jwt || !body.expires_at) {
        // Keep the status in the message: the capacity retry policy recognizes Reactor's 429s by it.
        const status = `${response.status}${body.code ? ` ${body.code}` : ""}`;
        throw new Error(`${body.error ?? "Reactor token request failed"} (${status})`);
      }
      cached.set(model, { jwt: body.jwt, expiresAtMs: body.expires_at * 1000 });
      return body.jwt;
    } finally {
      inflight.delete(model);
    }
  })();
  inflight.set(model, request);
  return request;
}

/** A stable resolver for a provider's `jwtToken` prop. */
export function tokenResolver(model: ReactorModelKey): () => Promise<string> {
  return () => reactorToken(model);
}
