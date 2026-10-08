/** Reactor may expose quota details as SDK fields or inside its HTTP error message. */
export function connectionFailure(cause: unknown) {
  const fields = cause && typeof cause === "object" ? cause as Record<string, unknown> : {};
  const message = typeof fields.message === "string" ? fields.message : String(cause);
  let body: Record<string, unknown> = {};
  const start = message.indexOf("{");
  if (start >= 0) {
    try {
      const parsed = JSON.parse(message.slice(start, message.lastIndexOf("}") + 1));
      if (parsed && typeof parsed === "object") body = parsed;
    } catch {}
  }
  const status = Number(fields.status ?? body.status);
  const quota = String(fields.quota_type ?? body.quota_type ?? "");
  const delay = Math.max(0, ...[
    fields.retry_after_ms, fields.retryAfter,
    Number(fields.retry_after_seconds) * 1000, Number(body.retry_after_seconds) * 1000,
  ].map(Number).filter(value => Number.isFinite(value) && value >= 0));
  if (status === 402 || /(?:out of credits|insufficient credits|billing cap)/i.test(message)) {
    return { retryable: false, retryAfterMs: 0, message: "Reactor's generation credit limit has been reached. Recorded rooms are still available." };
  }
  const limited = status === 429 || fields.code === "RATE_LIMITED" || /(?:HTTP (?:status )?429|quota_exceeded)/i.test(message);
  // Permanent/token budgets need user or server action; waiting cannot refill them.
  const temporary = !quota || /^(?:sessions_per_minute|concurrent_sessions|active_sessions|sessions_concurrent)$/.test(quota);
  if (limited && temporary) return {
    retryable: true, retryAfterMs: delay,
    message: /concurrent/.test(quota) ? "Reactor's live worlds are busy. Recorded rooms are still available." : "Reactor needs a short break before starting another world. Your recorded room is still available.",
  };
  if (limited) return { retryable: false, retryAfterMs: 0, message: "This Reactor session budget is exhausted. Recorded rooms are still available." };
  if (/no SDP answer|timed out waiting for (?:session|transport)|session.*not ready|transport.*timed out/i.test(message)) return {
    retryable: false, retryAfterMs: 0,
    message: "Reactor could not finish connecting the live video. Enter again to reconnect. Your recorded room is still available.",
  };
  return { retryable: false, retryAfterMs: 0, message };
}

export const REACTOR_COOLDOWN_KEY = "robot-worlds:reactor-cooldown";
export const MAX_CONNECTION_RETRIES = 2;

export function readCooldown() {
  try {
    const until = Number(localStorage.getItem(REACTOR_COOLDOWN_KEY));
    return Number.isFinite(until) && until > Date.now() ? until : 0;
  } catch { return 0; }
}

export function saveCooldown(delay: number) {
  const until = Math.max(readCooldown(), Date.now() + delay);
  try { localStorage.setItem(REACTOR_COOLDOWN_KEY, String(until)); } catch {}
  return until;
}

export function waitForRetry(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); reject(new DOMException("Connection cancelled", "AbortError")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", cancel); resolve(); }, milliseconds);
    if (signal.aborted) cancel();
    else signal.addEventListener("abort", cancel, { once: true });
  });
}
