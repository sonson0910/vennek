import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readTelegramOffset, stateFilePath, validateRuntimeState, writeTelegramOffset } from "@vennek/telegram-bot";

describe("Telegram runtime state", () => {
  it("defaults missing persistence root or state file to offset 0", () => {
    expect(readTelegramOffset()).toBe(0);
    expect(readTelegramOffset(mkdtempSync(join(tmpdir(), "vennek-runtime-")))).toBe(0);
  });

  it("persists Telegram offset privately", () => {
    const root = mkdtempSync(join(tmpdir(), "vennek-runtime-"));
    writeTelegramOffset(root, 42, new Date("2026-07-04T00:00:00.000Z"));

    const path = stateFilePath(root);
    expect(existsSync(path)).toBe(true);
    expect(readTelegramOffset(root)).toBe(42);
    expect(statMode(join(root, "runtime"))).toBe("700");
    expect(statMode(path)).toBe("600");

    const state = JSON.parse(readFileSync(path, "utf8"));
    expect(state).toMatchObject({ telegramOffset: 42, updatedAt: "2026-07-04T00:00:00.000Z" });
  });

  it("rejects invalid offsets", () => {
    const root = mkdtempSync(join(tmpdir(), "vennek-runtime-"));
    expect(() => writeTelegramOffset(root, -1)).toThrow(/Invalid Telegram offset/);
    expect(() => writeTelegramOffset(root, 1.5)).toThrow(/Invalid Telegram offset/);
  });

  it("surfaces corrupt state instead of replaying from zero silently", () => {
    const root = mkdtempSync(join(tmpdir(), "vennek-runtime-"));
    const path = stateFilePath(root);
    writeTelegramOffset(root, 7);
    writeFileSync(path, "{not-json", "utf8");
    expect(() => readTelegramOffset(root)).toThrow();
    expect(() => validateRuntimeState(root)).toThrow();
  });
});

function statMode(path: string): string {
  return (statSync(path).mode & 0o777).toString(8);
}
