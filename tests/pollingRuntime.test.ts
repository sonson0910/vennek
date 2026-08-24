import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { abortableSleep, createTelegramApi, runPolling as runTelegramPolling, telegramCall, TelegramApiError, type RateLimiter, type RuntimeLogger, type TelegramApi, type TelegramUpdate } from "@vennek/telegram-bot";
import { readTelegramOffset, writeTelegramOffset } from "@vennek/telegram-bot";
import { routeTelegramText } from "@vennek/telegram-bot";

const now = new Date("2026-07-04T00:00:00.000Z");

type PollingOptions = Parameters<typeof runTelegramPolling>[0];
function runPolling(options: Omit<PollingOptions, "answer"> & { answer?: PollingOptions["answer"] }): Promise<void> {
  const api = {
    ...options.api,
    getUpdates: async (params: Parameters<PollingOptions["api"]["getUpdates"]>[0]) => {
      const updates = await options.api.getUpdates(params);
      return updates.map((update) => update.message?.text !== undefined && update.message.from === undefined
        ? { ...update, message: { ...update.message, from: { id: 1 } } }
        : update);
    },
  };
  return runTelegramPolling({
    ...options,
    api,
    answer: options.answer ?? ((input) => routeTelegramText(input.text, options.context ?? {})),
  });
}

describe("Telegram polling runtime", () => {
  it("routes a public text update through the injected agent answer", async () => {
    const answer = vi.fn(async () => "agent answer");
    const api = fakeApi({ updates: [{ update_id: 1, message: { from: { id: 42 }, chat: { id: 99 }, text: "hello" } }] });

    await runPolling({ api, answer, maxCycles: 1, retryDelayMs: 0 });

    expect(answer).toHaveBeenCalledOnce();
    expect(answer).toHaveBeenCalledWith({ telegramUserId: "42", telegramChatId: "99", text: "hello" });
    expect(api.sentMessages).toHaveLength(1);
  });

  it("skips malformed runtime identifiers without invoking the agent", async () => {
    const root = mkdtempSync(join(tmpdir(), "vennek-poll-malformed-"));
    const answer = vi.fn(async () => "must not answer");
    const api = fakeApi({
      updates: [
        { update_id: "12" as unknown as number, message: { from: { id: 1 }, chat: { id: 2 }, text: "bad update" } },
        { update_id: 12, message: { from: { id: 1 }, chat: { id: "01" }, text: "bad chat" } },
        { update_id: 13, message: { from: { id: "01" }, chat: { id: 2 }, text: "bad user" } },
        { update_id: 14, message: { from: { id: 1 }, chat: { id: 2 }, text: "good" } },
      ] as unknown as TelegramUpdate[],
    });

    await runTelegramPolling({ api, answer, context: { persistenceRoot: root }, maxCycles: 1, retryDelayMs: 0 });

    expect(answer).toHaveBeenCalledOnce();
    expect(readTelegramOffset(root)).toBe(15);
  });

  it("accepts the maximum safe Telegram update id without overflowing the offset", async () => {
    const root = mkdtempSync(join(tmpdir(), "vennek-poll-max-update-"));
    const answer = vi.fn(async () => "agent answer");
    const api = fakeApi({
      updates: [{ update_id: Number.MAX_SAFE_INTEGER, message: { from: { id: 1 }, chat: { id: 2 }, text: "max" } }],
    });

    await runTelegramPolling({ api, answer, context: { persistenceRoot: root }, maxCycles: 1, retryDelayMs: 0 });

    expect(answer).toHaveBeenCalledOnce();
    expect(readTelegramOffset(root)).toBe(Number.MAX_SAFE_INTEGER);
    expect(api.sentMessages).toHaveLength(1);
  });

  it("starts from persisted offset and advances after a handled update", async () => {
    const root = mkdtempSync(join(tmpdir(), "vennek-poll-"));
    writeTelegramOffset(root, 10, now);
    const offsets: number[] = [];
    const api = fakeApi({
      updates: [{ update_id: 10, message: { chat: { id: 12345 }, text: "/sources catalyst-review-workbench" } }],
      onGetUpdates: (params) => offsets.push(params.offset)
    });
    const logs = captureLogs();

    await runPolling({ api, context: { persistenceRoot: root, enableFixtures: true, now }, logger: logs.logger, maxCycles: 1, retryDelayMs: 0 });

    expect(offsets).toEqual([10]);
    expect(readTelegramOffset(root)).toBe(11);
    expect(api.sentMessages).toHaveLength(1);
    expect(logs.events.some((event) => event.event === "telegram_update_processed" && event.chatHash && !event.chatId)).toBe(true);
  });

  it("hashes unknown command text before logging a processed update", async () => {
    const root = mkdtempSync(join(tmpdir(), "vennek-poll-"));
    const sentinel = "SECRET_LOG_SENTINEL_123456789";
    const api = fakeApi({
      updates: [{ update_id: 2, message: { chat: { id: 12345 }, text: sentinel } }]
    });
    const logs = captureLogs();

    await runPolling({ api, context: { persistenceRoot: root, now }, logger: logs.logger, maxCycles: 1, retryDelayMs: 0 });

    expect(readTelegramOffset(root)).toBe(3);
    expect(api.sentMessages).toHaveLength(1);
    expect(logs.events.some((event) => event.event === "telegram_update_processed" && event.updateId === 2)).toBe(true);
    expect(JSON.stringify(logs.events)).not.toContain(sentinel);
    expect(logs.events.find((event) => event.event === "telegram_update_processed")).toMatchObject({ commandHash: expect.any(String) });
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

    await runPolling({ api, context: { persistenceRoot: root, now }, logger: logs.logger, maxCycles: 1, retryDelayMs: 0 });

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

    await runPolling({ api, context: { persistenceRoot: root, now }, logger: logs.logger, maxCycles: 1, retryDelayMs: 0 });

    expect(api.sendAttempts).toBe(2);
    expect(api.sentMessages).toHaveLength(1);
    expect(readTelegramOffset(root)).toBe(31);
    expect(readFileSync(join(root, "audit-logs", "commands.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
    expect(logs.events.some((event) => event.event === "telegram_update_processed")).toBe(true);
    expect(logs.events.some((event) => event.event === "telegram_delivery_abandoned")).toBe(false);
  });

  it("stops without quarantine or offset advancement when send is aborted", async () => {
    const root = mkdtempSync(join(tmpdir(), "vennek-poll-"));
    writeTelegramOffset(root, 60, now);
    const controller = new AbortController();
    let sendAttempts = 0;
    const api: TelegramApi = {
      async getUpdates() {
        return [{ update_id: 60, message: { chat: { id: 12345 }, text: "/proof abort-during-send" } }];
      },
      async sendMessage() {
        sendAttempts += 1;
        controller.abort();
        throw new Error("request aborted");
      }
    };
    const logs = captureLogs();

    await runPolling({ api, context: { persistenceRoot: root, now }, logger: logs.logger, signal: controller.signal, maxCycles: 1, retryDelayMs: 0 });

    expect(sendAttempts).toBe(1);
    expect(readTelegramOffset(root)).toBe(60);
    expect(logs.events.some((event) => event.event === "telegram_delivery_abandoned")).toBe(false);
    expect(logs.events.some((event) => event.event === "telegram_polling_error")).toBe(false);
    expect(logs.events.some((event) => event.event === "telegram_polling_stopped")).toBe(true);
  });

  it("stops without a second send when aborted during retry sleep", async () => {
    const root = mkdtempSync(join(tmpdir(), "vennek-poll-"));
    writeTelegramOffset(root, 70, now);
    const controller = new AbortController();
    let sendAttempts = 0;
    const api: TelegramApi = {
      async getUpdates() {
        return [{ update_id: 70, message: { chat: { id: 12345 }, text: "/proof abort-during-retry" } }];
      },
      async sendMessage() {
        sendAttempts += 1;
        setTimeout(() => controller.abort(), 10);
        throw new TelegramApiError(503, "Service unavailable");
      }
    };
    const logs = captureLogs();

    await runPolling({ api, context: { persistenceRoot: root, now }, logger: logs.logger, signal: controller.signal, maxCycles: 1, retryDelayMs: 1_000 });

    expect(sendAttempts).toBe(1);
    expect(readTelegramOffset(root)).toBe(70);
    expect(logs.events.some((event) => event.event === "telegram_delivery_abandoned")).toBe(false);
  });

  it("commits a send that resolves while the signal aborts", async () => {
    const root = mkdtempSync(join(tmpdir(), "vennek-poll-"));
    writeTelegramOffset(root, 80, now);
    const controller = new AbortController();
    let sendAttempts = 0;
    const api: TelegramApi = {
      async getUpdates() {
        return [{ update_id: 80, message: { chat: { id: 12345 }, text: "/proof send-resolved" } }];
      },
      async sendMessage() {
        sendAttempts += 1;
        controller.abort();
        return { ok: true };
      }
    };
    const logs = captureLogs();

    await runPolling({ api, context: { persistenceRoot: root, now }, logger: logs.logger, signal: controller.signal, maxCycles: 1, retryDelayMs: 0 });

    expect(sendAttempts).toBe(1);
    expect(readTelegramOffset(root)).toBe(81);
    expect(logs.events.some((event) => event.event === "telegram_update_processed" && event.updateId === 80)).toBe(true);
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

    await runPolling({ api, context: { persistenceRoot: root, now }, logger: logs.logger, maxCycles: 1, retryDelayMs: 0 });

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

    await runPolling({ api, context: { persistenceRoot: root, now }, logger: logs.logger, maxCycles: 1, retryDelayMs: 0 });

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

  it("quarantines HTTP 403 invalid JSON after one delivery attempt", async () => {
    const root = mkdtempSync(join(tmpdir(), "vennek-poll-"));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true, result: [{ update_id: 90, message: { chat: { id: 12345 }, text: "/proof invalid-json-403" } }] }) })
      .mockResolvedValueOnce({ ok: false, status: 403, json: async () => { throw new Error("raw TOKEN_SECRET request body"); } });
    vi.stubGlobal("fetch", fetchMock);
    const logs = captureLogs();

    await runPolling({ api: createTelegramApi("TOKEN_SECRET"), context: { persistenceRoot: root, now }, logger: logs.logger, maxCycles: 1, retryDelayMs: 0 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(readTelegramOffset(root)).toBe(91);
    expect(logs.events.some((event) => event.event === "telegram_delivery_abandoned" && event.updateId === 90 && event.status === 403 && event.attempts === 1)).toBe(true);
    expect(JSON.stringify(logs.events)).not.toContain("TOKEN_SECRET");
    expect(JSON.stringify(logs.events)).not.toContain("request body");
    vi.unstubAllGlobals();
  });

  it("treats a 2xx invalid JSON response as transient delivery failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "vennek-poll-"));
    const malformed = { ok: true, status: 200, json: async () => { throw new Error("raw TOKEN_SECRET request body"); } };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true, result: [{ update_id: 100, message: { chat: { id: 12345 }, text: "/proof invalid-json-2xx" } }] }) })
      .mockResolvedValue(malformed);
    vi.stubGlobal("fetch", fetchMock);
    const logs = captureLogs();

    await runPolling({ api: createTelegramApi("TOKEN_SECRET"), context: { persistenceRoot: root, now }, logger: logs.logger, maxCycles: 1, retryDelayMs: 0 });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(readTelegramOffset(root)).toBe(101);
    expect(logs.events.some((event) => event.event === "telegram_delivery_abandoned" && event.updateId === 100 && event.status === 200 && event.attempts === 3)).toBe(true);
    expect(JSON.stringify(logs.events)).not.toContain("TOKEN_SECRET");
    vi.unstubAllGlobals();
  });

  it("routes public chats without an allowlist when rate limit permits", async () => {
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
      context: { persistenceRoot: root, enableFixtures: true, now },
      logger: logs.logger,
      rateLimiter,
      maxCycles: 1,
      retryDelayMs: 0
    });

    expect(consumedChats).toEqual(["999"]);
    expect(readTelegramOffset(root)).toBe(9);
    expect(api.sentMessages).toHaveLength(1);
    expect(logs.events.some((event) => event.event === "telegram_update_processed" && event.updateId === 8)).toBe(true);
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
    const updates = Array.from({ length: 11 }, (_, index) => ({
      update_id: index + 1,
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
      context: { persistenceRoot: root, now },
      logger: logs.logger,
      maxCycles: 2,
      retryDelayMs: 0
    });

    expect(offsets).toEqual([0, 7]);
    expect(sentMessages).toHaveLength(10);
    expect(readTelegramOffset(root)).toBe(12);
    expect(logs.events.filter((event) => event.event === "telegram_update_rate_limited")).toEqual([
      {
        level: "warn",
        event: "telegram_update_rate_limited",
        updateId: 11,
        chatHash: expect.any(String),
        offset: 12
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
      return input.updates.map((update) => update.message?.text !== undefined && update.message.from === undefined
        ? { ...update, message: { ...update.message, from: { id: 1 } } }
        : update);
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
