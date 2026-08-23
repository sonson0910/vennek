import { describe, expect, it } from "vitest";
import { FixedWindowRateLimiter, parseAllowedChatIds } from "@vennek/telegram-bot";

describe("Telegram pilot access control", () => {
  it("parses direct and group chat ids", () => {
    expect([...parseAllowedChatIds("123,-456, 789, 123")]).toEqual(["123", "-456", "789"]);
  });

  it("fails closed on missing or malformed configuration", () => {
    expect(() => parseAllowedChatIds()).toThrow(/VENNEK_TELEGRAM_ALLOWED_CHAT_IDS/);
    expect(() => parseAllowedChatIds(" ")).toThrow(/VENNEK_TELEGRAM_ALLOWED_CHAT_IDS/);
    expect(() => parseAllowedChatIds("123,abc")).toThrow(/Invalid Telegram chat id/);
    expect(() => parseAllowedChatIds("123.0")).toThrow(/Invalid Telegram chat id/);
    expect(() => parseAllowedChatIds(",")).toThrow(/VENNEK_TELEGRAM_ALLOWED_CHAT_IDS/);
  });

  it("limits each chat independently within fixed windows", () => {
    const limiter = new FixedWindowRateLimiter(2, 60_000);

    expect(limiter.allow("chat123", 0)).toBe(true);
    expect(limiter.allow("chat123", 1)).toBe(true);
    expect(limiter.allow("chat123", 2)).toBe(false);
    expect(limiter.allow("chat123", 60_000)).toBe(true);
    expect(limiter.allow("chat456", 2)).toBe(true);
  });

  it("rejects non-positive and non-integer settings", () => {
    expect(() => new FixedWindowRateLimiter(0, 60_000)).toThrow();
    expect(() => new FixedWindowRateLimiter(2, 0)).toThrow();
    expect(() => new FixedWindowRateLimiter(-1, 60_000)).toThrow();
    expect(() => new FixedWindowRateLimiter(2, -1)).toThrow();
    expect(() => new FixedWindowRateLimiter(1.5, 60_000)).toThrow();
    expect(() => new FixedWindowRateLimiter(2, 1.5)).toThrow();
  });
});
