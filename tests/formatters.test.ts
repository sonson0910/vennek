import { describe, expect, it } from "vitest";
import { formatErrorForTelegram, formatForTelegram, truncate } from "@vennek/telegram-bot";
import type { CommandResult } from "@vennek/shared";

function commandText(text: string): CommandResult {
  return {
    command: "test",
    ok: true,
    text,
    citations: [],
    sourceStatus: "unavailable",
    warnings: []
  };
}

describe("Telegram formatters", () => {
  it("normalizes CRLF and leaves short messages unchanged", () => {
    expect(formatForTelegram(commandText("line1\r\nline2"))).toBe("line1\nline2");
  });

  it("truncates to the exact max length", () => {
    const output = truncate("a".repeat(4000), 3900);
    expect(output.length).toBeLessThanOrEqual(3900);
    expect(output).toContain("[truncated for Telegram]");
  });

  it("preserves citations when truncating command output", () => {
    const output = formatForTelegram(commandText(`${"Long body. ".repeat(700)}\nCitations:\n[S1] https://projectcatalyst.io/example\n    Snippet: source evidence`));
    expect(output.length).toBeLessThanOrEqual(3900);
    expect(output).toContain("Citations:");
    expect(output).toContain("[S1]");
  });

  it("formats errors with the human decision frame", () => {
    expect(formatErrorForTelegram(new Error("boom"))).toContain("Draft analysis; human decides.\nCommand failed: boom");
    expect(formatErrorForTelegram("bad")).toContain("Command failed: bad");
  });
});
