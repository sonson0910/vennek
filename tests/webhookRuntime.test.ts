import { describe, expect, it, vi } from "vitest";
import {
  handleTelegramWebhook,
  PgBossAgentQueue,
  type TelegramAnswerJob,
} from "@vennek/telegram-bot";

const secret = "webhook-secret";
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
): Request {
  return request(stream, headers);
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
    [secret, ""],
  ])("rejects secret length/value mismatch (%s / %s)", async (headerSecret, configuredSecret) => {
    const enqueue = vi.fn();
    const response = await handleTelegramWebhook(
      request(JSON.stringify(update), { "x-telegram-bot-api-secret-token": headerSecret }),
      { secret: configuredSecret, enqueue },
    );

    await expectGeneric(response, 401);
    expect(enqueue).not.toHaveBeenCalled();
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
  it("sends telegram-answer jobs with singleton de-duplication and retries", async () => {
    const send = vi.fn().mockResolvedValue("job-id");
    const queue = new PgBossAgentQueue({ send });
    const job: TelegramAnswerJob = {
      updateId: 77,
      telegramUserId: "11",
      telegramChatId: "22",
      text: "Cardano là gì?",
    };

    await expect(queue.enqueue(job)).resolves.toBe(true);
    expect(send).toHaveBeenCalledWith("telegram-answer", job, {
      singletonKey: "77",
      retryLimit: 3,
      retryBackoff: true,
    });
  });

  it("maps a null pg-boss job id to an already-seen result", async () => {
    const send = vi.fn().mockResolvedValue(null);
    const queue = new PgBossAgentQueue({ send });

    await expect(queue.enqueue({ ...update, updateId: 77, telegramUserId: "11", telegramChatId: "22", text: "x" })).resolves.toBe(false);
  });
});
