import { describe, expect, it } from "vitest";
import { FixedWindowRateLimiter } from "@vennek/telegram-bot";

describe("Telegram public access controls", () => {
  it("limits each chat independently within fixed windows", () => {
    const limiter = new FixedWindowRateLimiter(2, 60_000);

    expect(limiter.allow("chat123", 0)).toBe(true);
    expect(limiter.allow("chat123", 1)).toBe(true);
    expect(limiter.allow("chat123", 2)).toBe(false);
    expect(limiter.allow("chat123", 60_000)).toBe(true);
    expect(limiter.allow("chat456", 2)).toBe(true);
  });

  it("starts a fresh window after the clock moves backward", () => {
    const limiter = new FixedWindowRateLimiter(1, 60_000);

    expect(limiter.allow("chat123", 1_000_000)).toBe(true);
    expect(limiter.allow("chat123", 0)).toBe(true);
    expect(limiter.allow("chat123", 1)).toBe(false);
  });

  it("defaults to ten commands per chat and resets at the window boundary", () => {
    const limiter = new FixedWindowRateLimiter();

    for (let index = 0; index < 10; index += 1) {
      expect(limiter.allow("chat123", index)).toBe(true);
    }
    expect(limiter.allow("chat123", 59_999)).toBe(false);
    expect(limiter.allow("chat123", 60_000)).toBe(true);
  });

  it("rejects non-positive and non-integer settings", () => {
    expect(() => new FixedWindowRateLimiter(0, 60_000)).toThrow();
    expect(() => new FixedWindowRateLimiter(2, 0)).toThrow();
    expect(() => new FixedWindowRateLimiter(-1, 60_000)).toThrow();
    expect(() => new FixedWindowRateLimiter(2, -1)).toThrow();
    expect(() => new FixedWindowRateLimiter(1.5, 60_000)).toThrow();
    expect(() => new FixedWindowRateLimiter(2, 1.5)).toThrow();
    expect(() => new FixedWindowRateLimiter(Number.MAX_SAFE_INTEGER + 1, 60_000)).toThrow();
    expect(() => new FixedWindowRateLimiter(2, Number.MAX_SAFE_INTEGER + 1)).toThrow();
    expect(() => new FixedWindowRateLimiter(Number.MAX_VALUE, 60_000)).toThrow();
    expect(() => new FixedWindowRateLimiter(2, Number.MAX_VALUE)).toThrow();
  });
});
