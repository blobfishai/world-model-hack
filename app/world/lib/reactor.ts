// Reactor session policy shared by the LingBot world and the live simulation render. Pure: no DOM or React.

export const LINGBOT_COST_PER_SECOND = 0.007; // reactor/lingbot-world-2, from GET https://api.reactor.inc/pricing
export const SANA_COST_PER_SECOND = 0.0017; // reactor/sana-streaming
export const CAPACITY_RETRY_SECONDS = [10, 20, 40];

/** Reactor answers HTTP 429 when the model has no free capacity or the account's session quota is spent. */
export function isCapacityError(message: string | null | undefined): boolean {
  return Boolean(message && /\b429\b|no available capacity|quota/i.test(message));
}

/** Seconds before retry number `attempt` (0-based), or null once the retries are spent. */
export function capacityRetryDelay(attempt: number): number | null {
  return CAPACITY_RETRY_SECONDS[attempt] ?? null;
}

export function formatCost(seconds: number, perSecond: number): string {
  return `$${(Math.max(0, seconds) * perSecond).toFixed(2)}`;
}
