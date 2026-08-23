import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { abortableSleep, runPolling, type RateLimiter, type RuntimeLogger, type TelegramApi, type TelegramUpdate } from "@vennek/telegram-bot";
import { readTelegramOffset, writeTelegramOffset } from "@vennek/telegram-bot";

const now = new Date("2026-07-04T00:00:00.000Z");

describe("Telegram polling runtime", () => {
  it("starts from persisted offset and advances after a handled update", async () => {
    const root = mkdtempSync(join(tmpdir(), "vennek-poll-"));
    writeTelegramOffset(root, 10, now);
    const offsets: number[] = [];
    const api = fakeApi({
      updates: [{ update_id: 10, message: { chat: { id: 12345 }, text: "/sources catalyst-review-workbench" } }],
      onGetUpdates: (params) => offsets.push(params.offset)
    });
    const logs = captureLogs();

    await runPolling({ api, allowedChatIds: new Set(["12345"]), context: { persistenceRoot: root, enableFixtures: true, now }, logger: logs.logger, maxCycles: 1, retryDelayMs: 0 });

    expect(offsets).toEqual([10]);
    expect(readTelegramOffset(root)).toBe(11);
    expect(api.sentMessages).toHaveLength(1);
    expect(logs.events.some((event) => event.event === "telegram_update_processed" && event.chatHash && !event.chatId)).toBe(true);
  });

  it("advances offset for intentionally skipped non-text updates", async () => {
    const root = mkdtempSync(join(tmpdir(), "vennek-poll-"));
    const consumedChats: Array<number | string> = [];
    const api = fakeApi({ updates: [{ update_id: 4, message: { chat: { id: 12345 } } }] });
    const logs = captureLogs();
    const rateLimiter: RateLimiter = {
      allow(chatId) {
        consumedChats.push(chatId);
        return true;
      }
    };

    await runPolling({
      api,
      allowedChatIds: new Set(["12345"]),
      context: { persistenceRoot: root, now },
      logger: logs.logger,
      rateLimiter,
      maxCycles: 1,
      retryDelayMs: 0
    });

    expect(consumedChats).toEqual([]);
    expect(readTelegramOffset(root)).toBe(5);
    expect(api.sentMessages).toHaveLength(0);
    expect(logs.events.find((event) => event.event === "telegram_update_skipped")).toEqual({
      level: "info",
      event: "telegram_update_skipped",
      updateId: 4,
      offset: 5
    });
  });

  it("does not advance offset when sendMessage fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "vennek-poll-"));
    writeTelegramOffset(root, 20, now);
    const api = fakeApi({
      updates: [{ update_id: 20, message: { chat: { id: 12345 }, text: "/sources catalyst-review-workbench" } }],
      sendError: new Error("send failed for token SECRET_TOKEN")
    });
    const logs = captureLogs();

    await runPolling({ api, allowedChatIds: new Set(["12345"]), context: { persistenceRoot: root, enableFixtures: true, now }, logger: logs.logger, maxCycles: 1, retryDelayMs: 0 });

    expect(readTelegramOffset(root)).toBe(20);
    expect(logs.events.some((event) => event.event === "telegram_polling_error")).toBe(true);
    expect(JSON.stringify(logs.events)).not.toContain("SECRET_TOKEN");
  });

  it("rejects unauthorized chats without routing or persistence but advances offset", async () => {
    const root = mkdtempSync(join(tmpdir(), "vennek-poll-"));
    const consumedChats: Array<number | string> = [];
    const api = fakeApi({
      updates: [{ update_id: 8, message: { chat: { id: 999 }, text: "/sources catalyst-review-workbench" } }]
    });
    const logs = captureLogs();
    const rateLimiter: RateLimiter = {
      allow(chatId) {
        consumedChats.push(chatId);
        return true;
      }
    };

    await runPolling({
      api,
      allowedChatIds: new Set(["123"]),
      context: { persistenceRoot: root, enableFixtures: true, now },
      logger: logs.logger,
      rateLimiter,
      maxCycles: 1,
      retryDelayMs: 0
    });

    expect(consumedChats).toEqual([]);
    expect(readTelegramOffset(root)).toBe(9);
    expect(api.sentMessages).toHaveLength(0);
    expect(existsSync(join(root, "source-cache"))).toBe(false);
    expect(existsSync(join(root, "audit-logs", "commands.jsonl"))).toBe(false);
    const rejected = logs.events.find((event) => event.event === "telegram_update_rejected");
    expect(rejected).toEqual({
      level: "warn",
      event: "telegram_update_rejected",
      updateId: 8,
      chatHash: expect.any(String),
      offset: 9
    });
    expect(JSON.stringify(rejected)).not.toContain("999");
    expect(JSON.stringify(rejected)).not.toContain("/sources");
  });

  it("rate-limits allowed chats before routing and side effects", async () => {
    const root = mkdtempSync(join(tmpdir(), "vennek-poll-"));
    const api = fakeApi({
      updates: [{ update_id: 12, message: { chat: { id: 12345 }, text: "/sources catalyst-review-workbench" } }]
    });
    const logs = captureLogs();
    const rateLimiter: RateLimiter = { allow: () => false };

    await runPolling({
      api,
      allowedChatIds: new Set(["12345"]),
      context: { persistenceRoot: root, enableFixtures: true, now },
      logger: logs.logger,
      rateLimiter,
      maxCycles: 1,
      retryDelayMs: 0
    });

    expect(readTelegramOffset(root)).toBe(13);
    expect(api.sentMessages).toHaveLength(0);
    expect(existsSync(join(root, "source-cache"))).toBe(false);
    expect(existsSync(join(root, "audit-logs", "commands.jsonl"))).toBe(false);
    const rateLimited = logs.events.find((event) => event.event === "telegram_update_rate_limited");
    expect(rateLimited).toEqual({
      level: "warn",
      event: "telegram_update_rate_limited",
      updateId: 12,
      chatHash: expect.any(String),
      offset: 13
    });
    expect(JSON.stringify(rateLimited)).not.toContain("12345");
    expect(JSON.stringify(rateLimited)).not.toContain("/sources");
  });

  it("keeps the default rate limiter across polling cycles", async () => {
    const root = mkdtempSync(join(tmpdir(), "vennek-poll-"));
    const updates = Array.from({ length: 11 }, (_, updateId) => ({
      update_id: updateId,
      message: { chat: { id: 12345 }, text: "/proof rate-limit-test" }
    }));
    const batches = [updates.slice(0, 6), updates.slice(6)];
    const offsets: number[] = [];
    const sentMessages: unknown[] = [];
    let batchIndex = 0;
    const api: TelegramApi & { sentMessages: unknown[] } = {
      sentMessages,
      async getUpdates(params) {
        offsets.push(params.offset);
        return batches[batchIndex++] ?? [];
      },
      async sendMessage(params) {
        sentMessages.push(params);
        return { ok: true };
      }
    };
    const logs = captureLogs();

    await runPolling({
      api,
      allowedChatIds: new Set(["12345"]),
      context: { persistenceRoot: root, now },
      logger: logs.logger,
      maxCycles: 2,
      retryDelayMs: 0
    });

    expect(offsets).toEqual([0, 6]);
    expect(sentMessages).toHaveLength(10);
    expect(readTelegramOffset(root)).toBe(11);
    expect(logs.events.filter((event) => event.event === "telegram_update_rate_limited")).toEqual([
      {
        level: "warn",
        event: "telegram_update_rate_limited",
        updateId: 10,
        chatHash: expect.any(String),
        offset: 11
      }
    ]);
  });

  it("abortable sleep exits promptly when aborted", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const sleeping = abortableSleep(10_000, controller.signal);
    controller.abort();
    await sleeping;
    expect(Date.now() - started).toBeLessThan(500);
  });
});

function fakeApi(input: {
  updates: TelegramUpdate[];
  sendError?: Error;
  onGetUpdates?: (params: { offset: number; timeout: number; allowed_updates: string[] }) => void;
}): TelegramApi & { sentMessages: unknown[] } {
  const sentMessages: unknown[] = [];
  return {
    sentMessages,
    async getUpdates(params) {
      input.onGetUpdates?.(params);
      return input.updates;
    },
    async sendMessage(params) {
      if (input.sendError) {
        throw input.sendError;
      }
      sentMessages.push(params);
      return { ok: true };
    }
  };
}

function captureLogs(): { logger: RuntimeLogger; events: Array<Record<string, unknown>> } {
  const events: Array<Record<string, unknown>> = [];
  return {
    events,
    logger(level, event, fields = {}) {
      events.push({ level, event, ...fields });
    }
  };
}
