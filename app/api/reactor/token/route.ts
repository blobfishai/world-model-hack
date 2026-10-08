import { NextResponse } from "next/server";

// The model this app drives. The minted JWT is scoped to it: the token
// can create sessions for this model only, and can act only on the
// sessions it created — nothing else on the account.
const MODELS = new Map([
  ["helios", "reactor/helios"],
  ["sana-streaming", "reactor/sana-streaming"],
  ["lingbot-world-2", "reactor/lingbot-world-2"],
  ["lingbot", "reactor/lingbot"],
]);

// Walkable world sessions bill for wall-clock time while connected, so the
// server also caps how long one LingBot session may live.
const SESSION_SECONDS = new Map([["reactor/lingbot-world-2", 30 * 60], ["reactor/lingbot", 30 * 60]]);

// Session budget for one token — how many sessions it may ever create
// (closed sessions still count). The client reuses one token for its
// whole lifetime, so leave room for a burst of reconnects.
const MAX_SESSIONS = 10;

// How long we ask Reactor to make the JWT valid for (the server caps
// this at 6h). One hour keeps a memoized token — and its remaining
// session budget — from outliving a normal visit.
const TOKEN_LIFETIME_SECONDS = 60 * 60;

// Mint a session-scoped Reactor JWT and return it together with its
// `expires_at`, so the client can memoize it for exactly its lifetime.
// (The client does its own caching in module scope — see fetchToken in
// HeliosApp — because the token must stay stable for a session's whole
// life; the response itself is marked no-store.)
//
// Why `authorization_details`?
//   This is what downscopes the token. Without it the JWT carries the
//   API key's full user-level access; with it the browser only ever
//   holds a credential for MODEL_NAME sessions it started itself, so a
//   leaked token is a bounded loss instead of an account key.
export async function GET(request: Request) {
  const model = MODELS.get(new URL(request.url).searchParams.get("model") ?? "helios");
  if (!model) {
    return NextResponse.json({ error: "Unsupported Reactor model" }, { status: 400 });
  }
  const apiKey = process.env.REACTOR_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "REACTOR_API_KEY is not set on the server" },
      { status: 500 },
    );
  }

  const res = await fetch("https://api.reactor.inc/tokens", {
    method: "POST",
    headers: {
      "Reactor-API-Key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      expires_after: TOKEN_LIFETIME_SECONDS,
      authorization_details: [
        {
          type: "session",
          resources: { models: { match: [model] } },
          constraints: {
            max_sessions: MAX_SESSIONS,
            ...(SESSION_SECONDS.has(model) ? { max_session_duration_seconds: SESSION_SECONDS.get(model) } : {}),
          },
        },
      ],
    }),
  });

  if (!res.ok) {
    // Preserve a quota hint so callers can wait instead of repeatedly minting tokens.
    const detail = await res.json().catch(() => ({}));
    const delay = Number(res.headers.get("Retry-After") ?? detail.retry_after_seconds);
    const limited = res.status === 429;
    return NextResponse.json(
      {
        error: limited ? "Reactor needs a short break before starting another world." : `Reactor /tokens returned ${res.status}`,
        ...(limited ? { code: "RATE_LIMITED", quota_type: detail.quota_type } : {}),
        ...(Number.isFinite(delay) && delay > 0 ? { retry_after_seconds: delay } : {}),
      },
      { status: limited ? 429 : 502, headers: {
        "Cache-Control": "private, no-store",
        ...(Number.isFinite(delay) && delay > 0 ? { "Retry-After": String(delay) } : {}),
      } },
    );
  }

  const { jwt, expires_at } = (await res.json()) as {
    jwt: string;
    expires_at: number;
  };

  // `expires_at` (unix seconds, decided by the server) lets the client
  // memoize the token for exactly its real lifetime. The client fetches
  // with `no-store` and owns the caching itself — a token must stay
  // stable for a session's whole life (the session is bound to the token
  // that created it), and the browser HTTP cache can't be trusted with
  // that (DevTools "Disable cache", eviction).
  return NextResponse.json(
    { jwt, expires_at },
    {
      headers: {
        "Cache-Control": "private, no-store",
      },
    },
  );
}
