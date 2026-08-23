import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { abortableSleep, runPolling, telegramCall, TelegramApiError, type RateLimiter, type RuntimeLogger, type TelegramApi, type TelegramUpdate } from "@vennek/telegram-bot";
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
    const api = fakeApi({ updates: [{ update_id: 4, message: { chat: { id: 999 } } }] });
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

  it("quarantines a permanent send failure without rerouting the command", async () => {
    const root = mkdtempSync(join(tmpdir(), "vennek-poll-"));
    writeTelegramOffset(root, 20, now);
    const api = fakeApi({
      updates: [{ update_id: 20, message: { chat: { id: 12345 }, text: "/proof permanent-delivery" } }],
      sendError: new TelegramApiError(403, "Forbidden")
    });
    const logs = captureLogs();

    await runPolling({ api, allowedChatIds: new Set(["12345"]), context: { persistenceRoot: root, now }, logger: logs.logger, maxCycles: 1, retryDelayMs: 0 });

    expect(api.sendAttempts).toBe(1);
    expect(readTelegramOffset(root)).toBe(21);
    expect(readFileSync(join(root, "audit-logs", "commands.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
    const abandoned = logs.events.find((event) => event.event === "telegram_delivery_abandoned");
    expect(abandoned).toMatchObject({ level: "warn", updateId: 20, status: 403, attempts: 1 });
    expect(JSON.stringify(abandoned)).not.toContain("12345");
    expect(JSON.stringify(abandoned)).not.toContain("permanent-delivery");
  });

  it("retries a transient send failure and routes the command once", async () => {
    const root = mkdtempSync(join(tmpdir(), "vennek-poll-"));
    const api = fakeApi({
      updates: [{ update_id: 30, message: { chat: { id: 12345 }, text: "/proof transient-delivery" } }],
      sendErrors: [new TelegramApiError(503, "Service unavailable")]
    });
    const logs = captureLogs();

    await runPolling({ api, allowedChatIds: new Set(["12345"]), context: { persistenceRoot: root, now }, logger: logs.logger, maxCycles: 1, retryDelayMs: 0 });

    expect(api.sendAttempts).toBe(2);
    expect(api.sentMessages).toHaveLength(1);
    expect(readTelegramOffset(root)).toBe(31);
    expect(readFileSync(join(root, "audit-logs", "commands.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
    expect(logs.events.some((event) => event.event === "telegram_update_processed")).toBe(true);
    expect(logs.events.some((event) => event.event === "telegram_delivery_abandoned")).toBe(false);
  });

  it("advances past exhausted delivery and processes the next update in the batch", async () => {
    const root = mkdtempSync(join(tmpdir(), "vennek-poll-"));
    const api = fakeApi({
      updates: [
        { update_id: 40, message: { chat: { id: 12345 }, text: "/proof exhausted-delivery" } },
        { update_id: 41, message: { chat: { id: 12345 }, text: "/proof later-delivery" } }
      ],
      sendErrors: [
        new TelegramApiError(503, "Service unavailable"),
        new TelegramApiError(502, "Bad gateway"),
        new Error("network unavailable")
      ]
    });
    const logs = captureLogs();

    await runPolling({ api, allowedChatIds: new Set(["12345"]), context: { persistenceRoot: root, now }, logger: logs.logger, maxCycles: 1, retryDelayMs: 0 });

    expect(api.sendAttempts).toBe(4);
    expect(api.sentMessages).toHaveLength(1);
    expect(readTelegramOffset(root)).toBe(42);
    expect(readFileSync(join(root, "audit-logs", "commands.jsonl"), "utf8").trim().split("\n")).toHaveLength(2);
    expect(logs.events.some((event) => event.event === "telegram_delivery_abandoned" && event.updateId === 40 && event.attempts === 3)).toBe(true);
    expect(logs.events.some((event) => event.event === "telegram_update_processed" && event.updateId === 41)).toBe(true);
  });

  it("retries 429 but quarantines other 4xx failures", async () => {
    const root = mkdtempSync(join(tmpdir(), "vennek-poll-"));
    const api = fakeApi({
      updates: [
        { update_id: 50, message: { chat: { id: 12345 }, text: "/proof retry-after" } },
        { update_id: 51, message: { chat: { id: 12345 }, text: "/proof permanent-client" } }
      ],
      sendErrors: [new TelegramApiError(429, "Too many requests"), undefined, new TelegramApiError(400, "Bad request")]
    });
    const logs = captureLogs();

    await runPolling({ api, allowedChatIds: new Set(["12345"]), context: { persistenceRoot: root, now }, logger: logs.logger, maxCycles: 1, retryDelayMs: 0 });

    expect(api.sendAttempts).toBe(3);
    expect(api.sentMessages).toHaveLength(1);
    expect(logs.events.some((event) => event.event === "telegram_update_processed" && event.updateId === 50)).toBe(true);
    expect(logs.events.some((event) => event.event === "telegram_delivery_abandoned" && event.updateId === 51 && event.status === 400 && event.attempts === 1)).toBe(true);
  });

  it("preserves Telegram error codes and HTTP status in TelegramApiError", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({ ok: false, error_code: 429, description: "Too many requests" }) })
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ ok: false, description: "Unavailable" }) })
      .mockResolvedValueOnce({ ok: true, status: 204, json: async () => ({ ok: true }) }));

    await expect(telegramCall("token", "sendMessage", {})).rejects.toMatchObject({ name: "TelegramApiError", status: 429, message: "Too many requests" });
    await expect(telegramCall("token", "sendMessage", {})).rejects.toMatchObject({ name: "TelegramApiError", status: 503, message: "Unavailable" });
    await expect(telegramCall("token", "sendMessage", {})).rejects.toMatchObject({ name: "TelegramApiError", status: 204, message: "Telegram API sendMessage failed with HTTP 204" });
    vi.unstubAllGlobals();
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
  sendErrors?: Array<Error | undefined>;
  onGetUpdates?: (params: { offset: number; timeout: number; allowed_updates: string[] }) => void;
}): TelegramApi & { sentMessages: unknown[]; sendAttempts: number } {
  const sentMessages: unknown[] = [];
  let sendAttempts = 0;
  const sendErrors = [...(input.sendErrors ?? [])];
  return {
    sentMessages,
    get sendAttempts() {
      return sendAttempts;
    },
    async getUpdates(params) {
      input.onGetUpdates?.(params);
      return input.updates;
    },
    async sendMessage(params) {
      sendAttempts += 1;
      const error = sendErrors.shift() ?? input.sendError;
      if (error) {
        throw error;
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
