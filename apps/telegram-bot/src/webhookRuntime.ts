import { createHash, timingSafeEqual } from "node:crypto";
import { protectWalletSecret, type AgentQueue, type TelegramAnswerJob } from "./agentQueue.js";

const MAX_BODY_BYTES = 256 * 1024;
const MAX_EMPTY_READS = 8;
export const TELEGRAM_TEXT_MAX_BYTES = 16_384;
const MIN_WEBHOOK_SECRET_LENGTH = 32;
const MAX_WEBHOOK_SECRET_LENGTH = 256;
const SECRET_HEADER = "x-telegram-bot-api-secret-token";

export type WebhookOptions = {
  secret: string;
  enqueue: AgentQueue["enqueue"];
};

class PayloadTooLargeError extends Error {}
class InvalidPayloadError extends Error {}
class RequestAbortedError extends Error {}

export function createWebhookOptions(secret: string, enqueue: AgentQueue["enqueue"]): WebhookOptions {
  assertWebhookSecret(secret);
  return Object.freeze({ secret, enqueue });
}

export function assertWebhookSecret(secret: unknown): asserts secret is string {
  if (typeof secret !== "string" || secret.length < MIN_WEBHOOK_SECRET_LENGTH || secret.length > MAX_WEBHOOK_SECRET_LENGTH || !/^[A-Za-z0-9_-]+$/u.test(secret)) {
    throw new Error("Telegram webhook secret must contain 32 to 256 ASCII token characters.");
  }
}

export async function handleTelegramWebhook(request: Request, options: WebhookOptions): Promise<Response> {
  if (!safeSecretEqual(request.headers.get(SECRET_HEADER), options.secret)) {
    await cancelBody(request);
    return genericResponse(401, "Unauthorized");
  }

  if (request.method !== "POST") {
    await cancelBody(request);
    return genericResponse(405, "Method not allowed");
  }

  if (!isJsonContentType(request.headers.get("content-type"))) {
    await cancelBody(request);
    return genericResponse(400, "Bad request");
  }

  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^[0-9]+$/u.test(declaredLength)) {
      await cancelBody(request);
      return genericResponse(400, "Bad request");
    }
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length)) {
      await cancelBody(request);
      return genericResponse(400, "Bad request");
    }
    if (length > MAX_BODY_BYTES) {
      await cancelBody(request);
      return genericResponse(413, "Payload too large");
    }
  }

  let body: Uint8Array;
  try {
    body = await readBody(request);
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      return genericResponse(413, "Payload too large");
    }
    return genericResponse(400, "Bad request");
  }

  if (request.signal.aborted) return genericResponse(400, "Bad request");

  let parsed: TelegramAnswerJob | undefined;
  try {
    parsed = parseTelegramJob(body);
  } catch {
    return genericResponse(400, "Bad request");
  }

  if (!parsed) return new Response(null, { status: 202 });
  const job = protectWalletSecret(parsed);

  try {
    await options.enqueue(job);
  } catch {
    return genericResponse(500, "Internal server error");
  }

  return new Response(null, { status: 202 });
}

function safeSecretEqual(actual: string | null, expected: string): boolean {
  if (!actual || typeof expected !== "string" || expected.length === 0) return false;
  const actualDigest = createHash("sha256").update(actual, "utf8").digest();
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

function isJsonContentType(value: string | null): boolean {
  return value?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

async function readBody(request: Request): Promise<Uint8Array> {
  const body = request.body;
  if (!body) throw new InvalidPayloadError("Missing request body");

  const reader = body.getReader();
  const buffer = new Uint8Array(MAX_BODY_BYTES);
  let total = 0;
  let emptyReads = 0;
  try {
    while (true) {
      const result = await readChunk(reader, request.signal);
      if (result.done) break;
      const chunk = result.value;
      if (chunk.byteLength === 0) {
        emptyReads += 1;
        if (emptyReads > MAX_EMPTY_READS) throw new InvalidPayloadError("Too many empty body reads");
        continue;
      }
      if (chunk.byteLength > MAX_BODY_BYTES - total) throw new PayloadTooLargeError("Request body too large");
      buffer.set(chunk, total);
      total += chunk.byteLength;
    }
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // Preserve the original bounded-read classification if cancellation fails.
    }
    throw error;
  } finally {
    reader.releaseLock();
  }

  return buffer.subarray(0, total);
}

async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (!signal) return reader.read();
  if (signal.aborted) throw new RequestAbortedError("Request aborted");

  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      void reader.cancel().catch(() => undefined);
      reject(new RequestAbortedError("Request aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function parseTelegramJob(bytes: Uint8Array): TelegramAnswerJob | undefined {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new InvalidPayloadError("Invalid JSON");
  }

  if (!isPlainObject(value) || !isPositiveSafeInteger(value.update_id)) {
    throw new InvalidPayloadError("Invalid update");
  }
  const message = value.message;
  if (message === undefined) {
    return undefined;
  }
  if (!isPlainObject(message)) throw new InvalidPayloadError("Invalid message");
  const from = message.from;
  const chat = message.chat;
  const userId = isPlainObject(from) ? from.id : undefined;
  const chatId = isPlainObject(chat) ? chat.id : undefined;
  const hasText = Object.prototype.hasOwnProperty.call(message, "text");
  if (!hasText) return undefined;
  if (typeof message.text !== "string") throw new InvalidPayloadError("Invalid text");
  if (!isPositiveSafeInteger(userId) || !isSafeNonzeroInteger(chatId)) {
    throw new InvalidPayloadError("Invalid identifiers");
  }
  if (message.text.trim().length === 0) {
    throw new InvalidPayloadError("Invalid text");
  }
  if (message.text.length > TELEGRAM_TEXT_MAX_BYTES || Buffer.byteLength(message.text, "utf8") > TELEGRAM_TEXT_MAX_BYTES) {
    throw new InvalidPayloadError("Text too large");
  }

  return {
    updateId: value.update_id,
    telegramUserId: String(userId),
    telegramChatId: String(chatId),
    text: message.text,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isSafeNonzeroInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value !== 0;
}

async function cancelBody(request: Request): Promise<void> {
  try {
    await request.body?.cancel();
  } catch {
    // The request is already closed or locked; the response still remains safe.
  }
}

function genericResponse(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
