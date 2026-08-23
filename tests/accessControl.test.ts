import { describe, expect, it } from "vitest";
import { parseAllowedChatIds } from "@vennek/telegram-bot";

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
});
