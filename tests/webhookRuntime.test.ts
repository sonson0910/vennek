import { describe, expect, it, vi } from "vitest";
import { randomInt } from "node:crypto";
import { PgBoss } from "pg-boss";
import {
  createWebhookOptions,
  handleTelegramWebhook,
  PgBossAgentQueue,
  WALLET_SECRET_JOB_MARKER,
  type TelegramAnswerJob,
} from "@vennek/telegram-bot";
import { createDatabase } from "@vennek/cardano-agent";

const secret = "webhook-secret-with-at-least-32-chars";
const databaseUrl = process.env.TEST_DATABASE_URL;
const update = {
  update_id: 77,
  message: {
    from: { id: 11 },
    chat: { id: 22 },
    text: "Cardano là gì?",
  },
};

function request(
  body: BodyInit | null = JSON.stringify(update),
  headers: Record<string, string> = {},
  method = "POST",
): Request {
  const init = {
    method,
    body: method === "GET" || method === "HEAD" ? null : body,
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": secret,
      ...headers,
    },
    duplex: "half",
  } as RequestInit & { duplex: "half" };
  return new Request("https://bot.example/webhook", init);
}

function streamRequest(
  stream: ReadableStream<Uint8Array>,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
): Request {
  const result = request(stream, headers);
  if (signal) return new Request(result, { signal, duplex: "half" } as RequestInit & { duplex: "half" });
  return result;
}

async function expectGeneric(response: Response, status: number, leaked?: string): Promise<void> {
  expect(response.status).toBe(status);
  const text = await response.text();
  expect(text.length).toBeLessThan(64);
  if (leaked) expect(text).not.toContain(leaked);
}

describe("Telegram webhook", () => {
  it("rejects an invalid secret without reading or enqueueing the body", async () => {
    const getReader = vi.fn(() => {
      throw new Error("body should not be read");
    });
    const enqueue = vi.fn();
    const invalidRequest = {
      method: "POST",
      headers: new Headers({
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "wrong",
      }),
      body: { getReader },
    } as unknown as Request;
    const response = await handleTelegramWebhook(
      invalidRequest,
      { secret, enqueue },
    );

    expect(response.status).toBe(401);
    expect(getReader).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it.each([
    ["", secret],
    ["wrong", secret],
    ["longer-than-secret", secret],
  ])("rejects secret length/value mismatch (%s / %s)", async (headerSecret, configuredSecret) => {
    const enqueue = vi.fn();
    const response = await handleTelegramWebhook(
      request(JSON.stringify(update), { "x-telegram-bot-api-secret-token": headerSecret }),
      { secret: configuredSecret, enqueue },
    );

    await expectGeneric(response, 401);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("rejects a weak configured secret at the configuration boundary", () => {
    expect(() => createWebhookOptions("too-short", vi.fn())).toThrow(/32/);
    expect(() => createWebhookOptions("x".repeat(257), vi.fn())).toThrow(/256/);
  });

  it("accepts an exact direct-handler token even when startup validation was bypassed", async () => {
    const enqueue = vi.fn().mockResolvedValue(true);
    const response = await handleTelegramWebhook(
      request(JSON.stringify(update), { "x-telegram-bot-api-secret-token": "right" }),
      { secret: "right", enqueue },
    );

    expect(response.status).toBe(202);
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it.each([
    ["GET", "application/json", 405],
    ["PUT", "application/json", 405],
    ["POST", "text/plain", 400],
    ["POST", "application/json-patch+json", 400],
    ["POST", "", 400],
  ])("rejects method/content type (%s / %s)", async (method, contentType, status) => {
    const enqueue = vi.fn();
    const response = await handleTelegramWebhook(
      request(JSON.stringify(update), { "content-type": contentType }, method),
      { secret, enqueue },
    );

    await expectGeneric(response, status);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("accepts application/json with a charset", async () => {
    const enqueue = vi.fn().mockResolvedValue(true);
    const response = await handleTelegramWebhook(
      request(JSON.stringify(update), { "content-type": "Application/JSON; charset=utf-8" }),
      { secret, enqueue },
    );

    expect(response.status).toBe(202);
    expect(enqueue).toHaveBeenCalledWith({
      updateId: 77,
      telegramUserId: "11",
      telegramChatId: "22",
      text: "Cardano là gì?",
    });
  });

  it("rejects string private owner IDs at the webhook boundary", async () => {
    const enqueue = vi.fn();
    const response = await handleTelegramWebhook(
      request(JSON.stringify({
        update_id: 78,
        message: {
          from: { id: "777" },
          chat: { id: "777", type: "private" },
          caption: "compare",
          document: { file_id: "file-78", file_unique_id: "unique-78" },
        },
      })),
      { secret, enqueue, encryptionKey: Buffer.alloc(32) },
    );

    await expectGeneric(response, 400);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("rejects an oversized declared body before reading it", async () => {
    const enqueue = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("body should not be read"));
      },
    });
    const response = await handleTelegramWebhook(
      streamRequest(stream, { "content-length": String(256 * 1024 + 1) }),
      { secret, enqueue },
    );

    await expectGeneric(response, 413);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("rejects an oversized chunked body and cancels the reader", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(256 * 1024 + 1));
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = await handleTelegramWebhook(streamRequest(stream), { secret, enqueue: vi.fn() });

    await expectGeneric(response, 413);
    expect(cancelled).toBe(true);
  });

  it("rejects a stream that yields too many empty chunks", async () => {
    let reads = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads += 1;
        controller.enqueue(new Uint8Array());
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = await handleTelegramWebhook(streamRequest(stream), { secret, enqueue: vi.fn() });

    await expectGeneric(response, 400);
    expect(reads).toBeLessThan(20);
    expect(cancelled).toBe(true);
  });

  it.each([
    "{",
    JSON.stringify({ update_id: -1, message: update.message }),
    JSON.stringify({ update_id: Number.MAX_SAFE_INTEGER + 1, message: update.message }),
    JSON.stringify({ update_id: 1, message: { from: { id: 0 }, chat: { id: 22 }, text: "x" } }),
    JSON.stringify({ update_id: 1, message: { from: { id: 11 }, chat: { id: 0 }, text: "x" } }),
    JSON.stringify({ update_id: 1, message: { from: { id: 11 }, chat: { id: 22 }, text: "  " } }),
    JSON.stringify({ update_id: 1, message: { from: { id: "11" }, chat: { id: 22 }, text: "x" } }),
  ])("rejects malformed JSON or unsafe schema: %s", async (body) => {
    const enqueue = vi.fn();
    const response = await handleTelegramWebhook(request(body), { secret, enqueue });

    await expectGeneric(response, 400, body);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it.each([
    { update_id: 78, message: { from: { id: 11 }, chat: { id: 22 }, photo: [{ file_id: "photo" }] } },
    { update_id: 79, message: { from: { id: 11 }, chat: { id: 22 }, sticker: { file_id: "sticker" } } },
    { update_id: 80, callback_query: { id: "callback" } },
    { update_id: 82, chosen_inline_result: { result_id: "inline" } },
    { update_id: 83, guest_message: { chat: { id: 22 } } },
  ])("accepts valid unsupported Telegram updates without enqueueing", async (body) => {
    const enqueue = vi.fn();
    const response = await handleTelegramWebhook(request(JSON.stringify(body)), { secret, enqueue });

    expect(response.status).toBe(202);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("accepts a message without text instead of queueing it", async () => {
    const enqueue = vi.fn();
    const response = await handleTelegramWebhook(
      request(JSON.stringify({ update_id: 81, message: { message_id: 1, date: 2, from: { id: 11 }, chat: { id: 22 } } })),
      { secret, enqueue },
    );

    expect(response.status).toBe(202);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it.each([
    { text: 7 },
    { text: "  " },
    { text: "valid", from: { id: 0 } },
  ])("rejects malformed text messages even with Telegram metadata: %j", async (message) => {
    const enqueue = vi.fn();
    const response = await handleTelegramWebhook(
      request(JSON.stringify({ update_id: 84, message: { message_id: 1, date: 2, chat: { id: 22 }, from: { id: 11 }, ...message } })),
      { secret, enqueue },
    );

    await expectGeneric(response, 400);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it.each(["1e2", "0x10", "+1", "1.0", ""])(
    "rejects non-decimal content-length %s",
    async (contentLength) => {
      const enqueue = vi.fn();
      const response = await handleTelegramWebhook(
        request(JSON.stringify(update), { "content-length": contentLength }),
        { secret, enqueue },
      );

      await expectGeneric(response, 400);
      expect(enqueue).not.toHaveBeenCalled();
    },
  );

  it.each([0, -0])("rejects non-positive update_id %s", async (updateId) => {
    const enqueue = vi.fn();
    const response = await handleTelegramWebhook(
      request(JSON.stringify({ ...update, update_id: updateId })),
      { secret, enqueue },
    );

    await expectGeneric(response, 400);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("caps text by UTF-8 bytes before queueing", async () => {
    const enqueue = vi.fn();
    const response = await handleTelegramWebhook(
      request(JSON.stringify({ ...update, message: { ...update.message, text: "é".repeat(8193) } })),
      { secret, enqueue },
    );

    await expectGeneric(response, 400);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("reads tiny chunks into the bounded body buffer", async () => {
    const encoded = new TextEncoder().encode(JSON.stringify(update));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of encoded) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    });
    const enqueue = vi.fn().mockResolvedValue(true);
    const response = await handleTelegramWebhook(streamRequest(stream), { secret, enqueue });

    expect(response.status).toBe(202);
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it("cancels body reading when the request aborts", async () => {
    const controller = new AbortController();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const promise = handleTelegramWebhook(
      streamRequest(stream, {}, controller.signal),
      { secret, enqueue: vi.fn() },
    );
    controller.abort();

    await expectGeneric(await promise, 400);
    expect(cancelled).toBe(true);
  });

  it("redacts detected wallet secrets before calling the injected enqueue boundary", async () => {
    const mnemonic = `${Array.from({ length: 11 }, () => "abandon").join(" ")} about`;
    const enqueue = vi.fn().mockResolvedValue(true);
    const response = await handleTelegramWebhook(
      request(JSON.stringify({ ...update, message: { ...update.message, text: mnemonic } })),
      { secret, enqueue },
    );

    expect(response.status).toBe(202);
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ text: WALLET_SECRET_JOB_MARKER, walletSecretDetected: true }));
    expect(JSON.stringify(enqueue.mock.calls[0])).not.toContain(mnemonic);
  });

  it("canonicalizes a valid negative chat id and ignores extra fields", async () => {
    const enqueue = vi.fn().mockResolvedValue(true);
    const body = JSON.stringify({
      ...update,
      message: { ...update.message, chat: { id: -9007199254740991 } },
      extra: "ignored",
    });
    const response = await handleTelegramWebhook(request(body), { secret, enqueue });

    expect(response.status).toBe(202);
    expect(enqueue).toHaveBeenCalledWith({
      updateId: 77,
      telegramUserId: "11",
      telegramChatId: "-9007199254740991",
      text: "Cardano là gì?",
    });
  });

  it("returns 202 for an already-seen update when enqueue reports false", async () => {
    const enqueue = vi.fn().mockResolvedValue(false);
    const response = await handleTelegramWebhook(request(), { secret, enqueue });

    expect(response.status).toBe(202);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("returns a generic 500 when enqueue fails without leaking the error", async () => {
    const sentinel = "QUEUE_SECRET_SENTINEL_123456789";
    const enqueue = vi.fn().mockRejectedValue(new Error(sentinel));
    const response = await handleTelegramWebhook(request(), { secret, enqueue });

    await expectGeneric(response, 500, sentinel);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});

describe("PgBossAgentQueue", () => {
  function fakeDatabase(claimRows: unknown[] = [{ update_id: "77" }], admissionRows: unknown[] = []) {
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    const client = {
      query: vi.fn(async (text: string, values?: unknown[]) => {
        queries.push({ text, values });
        if (text.startsWith("INSERT INTO telegram_updates")) return { rows: claimRows };
        if (text.startsWith("SELECT clock_timestamp")) return { rows: [{ now: new Date("2026-08-24T00:00:00.000Z") }] };
        if (text.startsWith("SELECT window_started_at")) return { rows: admissionRows };
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const database = { connect: vi.fn(async () => client) };
    return { client, database, queries };
  }

  it("sends telegram-answer jobs with singleton de-duplication and retries", async () => {
    const { database, client, queries } = fakeDatabase();
    const send = vi.fn().mockImplementation(async (_name: string, _job: TelegramAnswerJob, options: { db?: { executeSql(text: string, values?: unknown[]): Promise<unknown> } }) => {
      await options.db?.executeSql("SELECT 1", []);
      return "job-id";
    });
    const queue = new PgBossAgentQueue({ send }, database);
    const job: TelegramAnswerJob = {
      updateId: 77,
      telegramUserId: "11",
      telegramChatId: "22",
      text: "Cardano là gì?",
    };

    await expect(queue.enqueue(job)).resolves.toBe(true);
    expect(send).toHaveBeenCalledWith(
      "telegram-answer",
      job,
      expect.objectContaining({ singletonKey: "77", retryLimit: 3, retryBackoff: true, db: expect.any(Object) }),
    );
    expect(queries.map(({ text }) => text)).toEqual([
      "BEGIN",
      expect.stringContaining("INSERT INTO telegram_updates"),
      "SELECT clock_timestamp() AS now",
      expect.stringContaining("INSERT INTO telegram_admission_windows"),
      expect.stringContaining("SELECT window_started_at"),
      expect.stringContaining("INSERT INTO telegram_admission_windows"),
      expect.stringContaining("SELECT window_started_at"),
      expect.stringContaining("UPDATE telegram_admission_windows"),
      expect.stringContaining("UPDATE telegram_admission_windows"),
      "SELECT 1",
      "COMMIT",
    ]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("rolls back and throws when pg-boss returns null after claiming", async () => {
    const { database, queries } = fakeDatabase();
    const send = vi.fn().mockResolvedValue(null);
    const queue = new PgBossAgentQueue({ send }, database);

    await expect(queue.enqueue({ ...update, updateId: 77, telegramUserId: "11", telegramChatId: "22", text: "x" })).rejects.toThrow(/queue insertion failed/i);
    expect(queries.map(({ text }) => text)).toEqual([
      "BEGIN",
      expect.stringContaining("INSERT INTO telegram_updates"),
      "SELECT clock_timestamp() AS now",
      expect.stringContaining("INSERT INTO telegram_admission_windows"),
      expect.stringContaining("SELECT window_started_at"),
      expect.stringContaining("INSERT INTO telegram_admission_windows"),
      expect.stringContaining("SELECT window_started_at"),
      expect.stringContaining("UPDATE telegram_admission_windows"),
      expect.stringContaining("UPDATE telegram_admission_windows"),
      "ROLLBACK",
    ]);
  });

  it("keeps the claim atomic and skips a replay without calling pg-boss", async () => {
    const { database, queries } = fakeDatabase([]);
    const send = vi.fn();
    const queue = new PgBossAgentQueue({ send }, database);

    await expect(queue.enqueue({ updateId: 77, telegramUserId: "11", telegramChatId: "22", text: "x" })).resolves.toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(queries.map(({ text }) => text)).toEqual(["BEGIN", expect.stringContaining("INSERT INTO telegram_updates"), "ROLLBACK"]);
  });

  it("commits a terminal failed claim when the user or chat admission window is full", async () => {
    const { database, client, queries } = fakeDatabase(
      [{ update_id: "77" }],
      [{ window_started_at: new Date("2026-08-24T00:00:00.000Z"), accepted_count: 10 }],
    );
    const send = vi.fn();
    const queue = new PgBossAgentQueue({ send }, database);

    await expect(queue.enqueue({ updateId: 77, telegramUserId: "11", telegramChatId: "22", text: "x" })).resolves.toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(queries.map(({ text }) => text)).toEqual([
      "BEGIN",
      expect.stringContaining("INSERT INTO telegram_updates"),
      "SELECT clock_timestamp() AS now",
      expect.stringContaining("INSERT INTO telegram_admission_windows"),
      expect.stringContaining("SELECT window_started_at"),
      expect.stringContaining("INSERT INTO telegram_admission_windows"),
      expect.stringContaining("SELECT window_started_at"),
      expect.stringContaining("UPDATE telegram_updates SET status = 'failed'"),
      "COMMIT",
    ]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("allows only one concurrent claim to reach pg-boss", async () => {
    const first = fakeDatabase([{ update_id: "77" }]);
    const second = fakeDatabase([]);
    const database = {
      connect: vi.fn().mockResolvedValueOnce(first.client).mockResolvedValueOnce(second.client),
    };
    const send = vi.fn().mockResolvedValue("job-id");
    const queue = new PgBossAgentQueue({ send }, database);

    await expect(Promise.all([
      queue.enqueue({ updateId: 77, telegramUserId: "11", telegramChatId: "22", text: "first" }),
      queue.enqueue({ updateId: 77, telegramUserId: "11", telegramChatId: "22", text: "replay" }),
    ])).resolves.toEqual([true, false]);
    expect(send).toHaveBeenCalledOnce();
  });

  it("rolls back a failed enqueue so the update can be retried", async () => {
    const { database, queries } = fakeDatabase();
    const send = vi.fn().mockRejectedValue(new Error("db sentinel"));
    const queue = new PgBossAgentQueue({ send }, database);

    await expect(queue.enqueue({ updateId: 77, telegramUserId: "11", telegramChatId: "22", text: "x" })).rejects.toThrow("db sentinel");
    expect(queries.map(({ text }) => text)).toEqual([
      "BEGIN",
      expect.stringContaining("INSERT INTO telegram_updates"),
      "SELECT clock_timestamp() AS now",
      expect.stringContaining("INSERT INTO telegram_admission_windows"),
      expect.stringContaining("SELECT window_started_at"),
      expect.stringContaining("INSERT INTO telegram_admission_windows"),
      expect.stringContaining("SELECT window_started_at"),
      expect.stringContaining("UPDATE telegram_admission_windows"),
      expect.stringContaining("UPDATE telegram_admission_windows"),
      "ROLLBACK",
    ]);
  });

  it("replaces mnemonic and signing-key text with the fixed safe job marker", async () => {
    const { database } = fakeDatabase();
    const send = vi.fn().mockResolvedValue("job-id");
    const queue = new PgBossAgentQueue({ send }, database);
    const mnemonic = `${Array.from({ length: 11 }, () => "abandon").join(" ")} about`;
    const signingKey = '{"type":"PaymentSigningKeyShelley_ed25519","cborHex":"5820abcdef"}';

    await queue.enqueue({ updateId: 77, telegramUserId: "11", telegramChatId: "22", text: mnemonic });
    await queue.enqueue({ updateId: 78, telegramUserId: "11", telegramChatId: "22", text: signingKey });

    for (const call of send.mock.calls) {
      expect(call[1].text).toBe(WALLET_SECRET_JOB_MARKER);
      expect(JSON.stringify(call[1])).not.toContain(mnemonic);
      expect(JSON.stringify(call[1])).not.toContain(signingKey);
      expect(call[1].walletSecretDetected).toBe(true);
    }
  });
});

describe.skipIf(!databaseUrl)("Telegram webhook PostgreSQL/pg-boss integration", () => {
  it("claims one concurrent update, completes its job, and rejects replay", async () => {
    const db = createDatabase(databaseUrl!);
    const boss = new PgBoss(databaseUrl!);
    const updateId = 8_000_000_000_000_000 + randomInt(0, 100_000_000);
    const telegramUserId = `integration-${process.pid}`;
    const telegramChatId = `integration-chat-${process.pid}-${Date.now()}-${randomInt(0, 100_000)}`;
    const job = { updateId, telegramUserId, telegramChatId, text: "integration" };
    const queue = new PgBossAgentQueue(boss, db);
    let jobId: string | undefined;

    try {
      await boss.start();
      await boss.createQueue("telegram-answer");
      const results = await Promise.all([queue.enqueue(job), queue.enqueue(job)]);
      expect(results.sort()).toEqual([false, true]);

      const jobs = await boss.findJobs<{ updateId: number }>("telegram-answer", { key: String(updateId), queued: true });
      expect(jobs).toHaveLength(1);
      jobId = jobs[0]?.id;
      if (!jobId) throw new Error("Expected an integration job");
      await boss.complete("telegram-answer", jobId, undefined, { includeQueued: true });
      await expect(queue.enqueue(job)).resolves.toBe(false);
    } finally {
      if (jobId) {
        await boss.deleteJob("telegram-answer", jobId).catch(() => undefined);
      }
      await boss.stop().catch(() => undefined);
      await db.query("DELETE FROM telegram_updates WHERE update_id = $1", [updateId]).catch(() => undefined);
      await db.query(
        "DELETE FROM telegram_admission_windows WHERE (subject_type = 'user' AND subject_id = $1) OR (subject_type = 'chat' AND subject_id = $2)",
        [telegramUserId, telegramChatId],
      ).catch(() => undefined);
      await db.end();
    }
  }, 30_000);

  it("enforces atomic per-user and per-chat admission without creating rejected jobs", async () => {
    const db = createDatabase(databaseUrl!);
    const boss = new PgBoss(databaseUrl!);
    const queue = new PgBossAgentQueue(boss, db);
    const base = 8_100_000_000_000_000 + randomInt(0, 100_000_000);
    const updateIds: number[] = [];
    const admissionSubjects = new Set<string>();
    const rememberSubject = (subjectType: "user" | "chat", subjectId: string): void => {
      admissionSubjects.add(`${subjectType}\u0000${subjectId}`);
    };
    try {
      await boss.start();
      await boss.createQueue("telegram-answer");

      const sameUserJobs = Array.from({ length: 11 }, (_, index) => ({
        updateId: base + index,
        telegramUserId: `admission-user-${base}`,
        telegramChatId: `admission-chat-${base}-${index}`,
        text: "accepted",
      }));
      updateIds.push(...sameUserJobs.map(({ updateId }) => updateId));
      for (const job of sameUserJobs) {
        rememberSubject("user", job.telegramUserId);
        rememberSubject("chat", job.telegramChatId);
      }
      const sameUserResults = await Promise.all(sameUserJobs.map((job) => queue.enqueue(job)));
      expect(sameUserResults.filter(Boolean)).toHaveLength(10);
      expect(sameUserResults.filter((result) => !result)).toHaveLength(1);
      const rejectedUserUpdate = sameUserJobs[sameUserResults.findIndex((result) => !result)]!.updateId;

      const sameChatJobs = Array.from({ length: 11 }, (_, index) => ({
        updateId: base + 100 + index,
        telegramUserId: `admission-other-user-${base}-${index}`,
        telegramChatId: `admission-chat-${base}`,
        text: "accepted",
      }));
      updateIds.push(...sameChatJobs.map(({ updateId }) => updateId));
      for (const job of sameChatJobs) {
        rememberSubject("user", job.telegramUserId);
        rememberSubject("chat", job.telegramChatId);
      }
      const sameChatResults = await Promise.all(sameChatJobs.map((job) => queue.enqueue(job)));
      expect(sameChatResults.filter(Boolean)).toHaveLength(10);
      expect(sameChatResults.filter((result) => !result)).toHaveLength(1);
      const rejectedChatUpdate = sameChatJobs[sameChatResults.findIndex((result) => !result)]!.updateId;

      updateIds.push(base + 200);
      const independentJob = { updateId: base + 200, telegramUserId: `admission-independent-user-${base}`, telegramChatId: `admission-independent-chat-${base}`, text: "accepted" };
      rememberSubject("user", independentJob.telegramUserId);
      rememberSubject("chat", independentJob.telegramChatId);
      await expect(queue.enqueue(independentJob)).resolves.toBe(true);
      const rejectedJobs = await boss.findJobs<{ updateId: number }>("telegram-answer", { key: String(rejectedUserUpdate), queued: true });
      expect(rejectedJobs).toHaveLength(0);
      const rejectedChatJobs = await boss.findJobs<{ updateId: number }>("telegram-answer", { key: String(rejectedChatUpdate), queued: true });
      expect(rejectedChatJobs).toHaveLength(0);
    } finally {
      for (const updateId of updateIds) {
        const jobs = await boss.findJobs<{ updateId: number }>("telegram-answer", { key: String(updateId), queued: true }).catch(() => []);
        for (const job of jobs) await boss.deleteJob("telegram-answer", job.id).catch(() => undefined);
      }
      if (updateIds.length > 0) await db.query("DELETE FROM telegram_updates WHERE update_id = ANY($1::bigint[])", [updateIds]).catch(() => undefined);
      for (const subject of admissionSubjects) {
        const separator = subject.indexOf("\u0000");
        const subjectType = subject.slice(0, separator);
        const subjectId = subject.slice(separator + 1);
        await db.query("DELETE FROM telegram_admission_windows WHERE subject_type = $1 AND subject_id = $2", [subjectType, subjectId]).catch(() => undefined);
      }
      await boss.stop().catch(() => undefined);
      await db.end();
    }
  }, 30_000);
});
