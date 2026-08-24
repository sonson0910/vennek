export type RateLimiter = {
  allow(chatId: number | string, nowMs?: number): boolean;
};

export class FixedWindowRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, { startedAt: number; count: number }>();

  constructor(private readonly limit = 10, private readonly windowMs = 60_000) {
    if (!Number.isSafeInteger(limit) || limit <= 0 || !Number.isSafeInteger(windowMs) || windowMs <= 0) {
      throw new Error("Rate limiter limit and window must be positive integers.");
    }
  }

  allow(chatId: number | string, nowMs = Date.now()): boolean {
    const key = String(chatId);
    const window = this.windows.get(key);
    if (!window || nowMs < window.startedAt || nowMs - window.startedAt >= this.windowMs) {
      this.windows.set(key, { startedAt: nowMs, count: 1 });
      return true;
    }
    if (window.count >= this.limit) {
      return false;
    }
    window.count += 1;
    return true;
  }
}
