import * as https from "node:https";
import type { ClientRequest, IncomingHttpHeaders, IncomingMessage, RequestOptions } from "node:http";
import { sha256Hex, type CommandContext } from "@vennek/shared";
import { FixedWindowRateLimiter, type RateLimiter } from "./accessControl.js";
import { readTelegramOffset, writeTelegramOffset } from "./runtimeState.js";

export const TELEGRAM_PRIVATE_FILE_MAX_BYTES = 20 * 1024 * 1024;
export const TELEGRAM_FILE_PATH_MAX_BYTES = 4_096;
const TELEGRAM_FILE_ID_MAX_BYTES = 512;
const TELEGRAM_FILE_UNIQUE_ID_MAX_BYTES = 256;
const TELEGRAM_FILE_DOWNLOAD_TIMEOUT_MS = 15_000;
const TELEGRAM_FILE_ALLOWED_CONTENT_TYPES = new Set([
  "application/octet-stream",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/markdown",
  "text/plain",
  "text/markdown",
]);

export type TelegramFile = Readonly<{
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}>;

export type TelegramFileResponse = Pick<IncomingMessage, "statusCode" | "headers" | "on" | "removeListener" | "resume" | "destroy" | "setTimeout">;
export type TelegramFileRequest = RequestOptions;
export type TelegramHttpsRequest = (
  options: RequestOptions,
  callback: (response: TelegramFileResponse) => void,
) => ClientRequest;

export type TelegramApiOptions = Readonly<{
  /** Test seam only; production always uses node:https against api.telegram.org. */
  request?: TelegramHttpsRequest;
}>;

export type TelegramUpdate = {
  update_id: number;
  message?: {
    from?: {
      id: number | string;
    };
    chat?: {
      id: number | string;
    };
    text?: string;
  };
};

export type TelegramApi = {
  getUpdates(params: { offset: number; timeout: number; allowed_updates: string[] }): Promise<TelegramUpdate[]>;
  sendMessage(params: { chat_id: number | string; text: string; disable_web_page_preview: boolean }): Promise<unknown>;
  getFile?(params: { file_id: string }): Promise<TelegramFile>;
  withDownloadedFile?(
    filePath: string,
    expectedSize: number | undefined,
    signal: AbortSignal | undefined,
    consumer: (bytes: Buffer) => void | Promise<void>,
  ): Promise<void>;
};

export type TelegramPrivateApi = TelegramApi & Required<Pick<TelegramApi, "getFile" | "withDownloadedFile">>;

export type RuntimeLogLevel = "info" | "warn" | "error";

export type RuntimeLogger = (level: RuntimeLogLevel, event: string, fields?: Record<string, unknown>) => void;

export type PollingOptions = {
  api: TelegramApi;
  context?: CommandContext;
  answer: (input: { telegramUserId: string; telegramChatId: string; text: string; updateId?: number }) => Promise<string>;
  logger?: RuntimeLogger;
  signal?: AbortSignal;
  pollTimeoutSeconds?: number;
  retryDelayMs?: number;
  maxCycles?: number;
  rateLimiter?: RateLimiter;
};

type TelegramApiResponse<T> = {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
};

export class TelegramApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "TelegramApiError";
    this.status = status;
  }
}

export async function runPolling(options: PollingOptions): Promise<void> {
  const context = options.context ?? {};
  const logger = options.logger ?? (() => undefined);
  const pollTimeoutSeconds = options.pollTimeoutSeconds ?? 50;
  const retryDelayMs = options.retryDelayMs ?? 3_000;
  const rateLimiter = options.rateLimiter ?? new FixedWindowRateLimiter();
  let offset = readTelegramOffset(context.persistenceRoot);
  let cycles = 0;

  logger("info", "telegram_polling_started", { offset, persistenceEnabled: Boolean(context.persistenceRoot) });

  try {
    while (!options.signal?.aborted) {
      if (options.maxCycles !== undefined && cycles >= options.maxCycles) {
        break;
      }
      cycles += 1;

      try {
        const updates = await options.api.getUpdates({
          offset,
          timeout: pollTimeoutSeconds,
          allowed_updates: ["message"]
        });

        for (const update of updates) {
          if (options.signal?.aborted) {
            break;
          }
          const updateId = validUpdateId(update?.update_id);
          if (updateId === undefined) {
            logger("info", "telegram_update_skipped", { reason: "invalid_update_id" });
            continue;
          }
          const message = isRecord(update?.message) ? update.message : undefined;
          const rawChatId = isRecord(message?.chat) ? message.chat.id : undefined;
          const chatId = canonicalTelegramIdentifier(rawChatId, false);
          const rawText = message?.text;
          const text = typeof rawText === "string" ? rawText.trim() : undefined;
          if (chatId === undefined || !text) {
            const nextOffset = nextOffsetFor(updateId);
            offset = Math.max(offset, nextOffset);
            writeTelegramOffset(context.persistenceRoot, offset);
            logger("info", "telegram_update_skipped", { updateId, offset });
            continue;
          }

          const userId = canonicalTelegramIdentifier(isRecord(message?.from) ? message.from.id : undefined, true);
          if (userId === undefined) {
            const nextOffset = nextOffsetFor(updateId);
            offset = Math.max(offset, nextOffset);
            writeTelegramOffset(context.persistenceRoot, offset);
            logger("info", "telegram_update_skipped", { updateId, offset });
            continue;
          }

          const nextOffset = nextOffsetFor(updateId);

          if (!rateLimiter.allow(chatId)) {
            offset = Math.max(offset, nextOffset);
            writeTelegramOffset(context.persistenceRoot, offset);
            logger("warn", "telegram_update_rate_limited", {
              updateId,
              chatHash: chatHash(chatId),
              offset
            });
            continue;
          }

          const startedAt = Date.now();
          const response = await options.answer({
            telegramUserId: userId,
            telegramChatId: chatId,
            text,
            updateId,
          });
          const delivery = await deliverMessage(options.api, {
            chat_id: chatId,
            text: response,
            disable_web_page_preview: true
          }, retryDelayMs, options.signal);
          if (delivery.aborted) {
            break;
          }
          offset = Math.max(offset, nextOffset);
          writeTelegramOffset(context.persistenceRoot, offset);
          if (!delivery.delivered) {
            logger("warn", "telegram_delivery_abandoned", {
              updateId,
              chatHash: chatHash(chatId),
              ...(delivery.status === undefined ? {} : { status: delivery.status }),
              attempts: delivery.attempts,
              offset
            });
            continue;
          }
          logger("info", "telegram_update_processed", {
            updateId,
            chatHash: chatHash(chatId),
            commandHash: sha256Hex(text.split(/\s+/, 1)[0] ?? "").slice(0, 12),
            durationMs: Date.now() - startedAt,
            offset
          });
        }
      } catch (error) {
        if (options.signal?.aborted) {
          break;
        }
        logger("error", "telegram_polling_error", { error: sanitizeRuntimeError(error) });
        await abortableSleep(retryDelayMs, options.signal);
      }
    }
  } finally {
    logger("info", "telegram_polling_stopped", { offset });
  }
}

export function createTelegramApi(token: string, signal?: AbortSignal, options: TelegramApiOptions = {}): TelegramPrivateApi {
  const request = options.request ?? ((requestOptions, callback) => https.request(requestOptions, callback));
  const api: TelegramPrivateApi = {
    getUpdates: (params) => telegramCall<TelegramUpdate[]>(token, "getUpdates", params, signal),
    sendMessage: (params) => telegramCall(token, "sendMessage", params, signal),
    getFile: async ({ file_id }) => {
      const safeFileId = validateTelegramFileId(file_id);
      let result: unknown;
      try {
        result = await telegramCall<unknown>(token, "getFile", { file_id: safeFileId }, signal);
      } catch (error) {
        const status = error instanceof TelegramApiError ? error.status : 502;
        throw new TelegramApiError(status, "Telegram getFile failed");
      }
      return validateTelegramFile(result, safeFileId);
    },
    withDownloadedFile: (filePath, expectedSize, downloadSignal, consumer) =>
      withTelegramFile(token, filePath, expectedSize, downloadSignal ?? signal, consumer, request),
  };
  return api;
}

export type TelegramDeliveryResult =
  | { delivered: true; attempts: number; aborted?: false }
  | { delivered: false; attempts: number; aborted?: false; status?: number }
  | { delivered: false; attempts: number; aborted: true; status?: number };

const TELEGRAM_DELIVERY_MAX_ATTEMPTS = 3;

export async function deliverMessage(
  api: TelegramApi,
  params: { chat_id: number | string; text: string; disable_web_page_preview: boolean },
  retryDelayMs: number,
  signal?: AbortSignal
): Promise<TelegramDeliveryResult> {
  if (signal?.aborted) {
    return { delivered: false, aborted: true, attempts: 0 };
  }

  for (let attempts = 1; attempts <= TELEGRAM_DELIVERY_MAX_ATTEMPTS; attempts += 1) {
    try {
      await api.sendMessage(params);
      return { delivered: true, attempts };
    } catch (error) {
      const status = error instanceof TelegramApiError ? error.status : undefined;
      const permanent = status !== undefined && status >= 400 && status <= 499 && status !== 429;
      if (signal?.aborted) {
        return { delivered: false, aborted: true, attempts, ...(status === undefined ? {} : { status }) };
      }
      if (permanent || attempts === TELEGRAM_DELIVERY_MAX_ATTEMPTS) {
        return { delivered: false, attempts, ...(status === undefined ? {} : { status }) };
      }
      await abortableSleep(retryDelayMs, signal);
      if (signal?.aborted) {
        return { delivered: false, aborted: true, attempts, ...(status === undefined ? {} : { status }) };
      }
    }
  }

  return { delivered: false, attempts: TELEGRAM_DELIVERY_MAX_ATTEMPTS };
}

export async function telegramCall<T>(token: string, method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(params),
    signal
  });

  let payload: TelegramApiResponse<T> | null;
  try {
    payload = (await response.json()) as TelegramApiResponse<T>;
  } catch {
    throw new TelegramApiError(response.status, `Telegram API ${method} returned invalid JSON (HTTP ${response.status})`);
  }
  if (!payload || !response.ok || !payload.ok || payload.result === undefined) {
    throw new TelegramApiError(payload?.error_code ?? response.status, payload?.description ?? `Telegram API ${method} failed with HTTP ${response.status}`);
  }

  return payload.result;
}

export function validateTelegramFilePath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > TELEGRAM_FILE_PATH_MAX_BYTES) {
    throw new Error("Telegram file path is invalid");
  }
  if (
    value.startsWith("/") || value.endsWith("/") || value.includes("//") || value.includes("\\") ||
    value.includes("?") || value.includes("#") || value.includes("%") ||
    /[\u0000-\u001f\u007f]|\p{Cc}|\p{Cf}|\p{Zl}|\p{Zp}/u.test(value)
  ) {
    throw new Error("Telegram file path is invalid");
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === ".." || !/^[A-Za-z0-9._~-]+$/u.test(segment))) {
    throw new Error("Telegram file path is invalid");
  }
  return value;
}

function validateTelegramFileId(value: unknown): string {
  if (
    typeof value !== "string" || value.length === 0 || value.trim() !== value ||
    Buffer.byteLength(value, "utf8") > TELEGRAM_FILE_ID_MAX_BYTES ||
    /[\u0000-\u001f\u007f]|\p{Cc}|\p{Cf}|\p{Zl}|\p{Zp}/u.test(value)
  ) {
    throw new Error("Telegram file id is invalid");
  }
  return value;
}

function validateTelegramFile(value: unknown, expectedFileId: string): TelegramFile {
  if (!isPlainObject(value)) throw new Error("Telegram getFile response is invalid");
  let ownKeys: PropertyKey[];
  try {
    ownKeys = Reflect.ownKeys(value);
  } catch {
    throw new Error("Telegram getFile response is invalid");
  }
  const allowed = new Set(["file_id", "file_unique_id", "file_size", "file_path"]);
  if (ownKeys.some((key) => typeof key !== "string" || !allowed.has(key))) throw new Error("Telegram getFile response is invalid");

  const fileId = value.file_id;
  const fileUniqueId = value.file_unique_id;
  if (fileId !== expectedFileId || !boundedTelegramText(fileId, TELEGRAM_FILE_ID_MAX_BYTES) || !boundedTelegramText(fileUniqueId, TELEGRAM_FILE_UNIQUE_ID_MAX_BYTES)) {
    throw new Error("Telegram getFile response is invalid");
  }

  const fileSize = value.file_size;
  if (Object.hasOwn(value, "file_size") && fileSize === undefined) throw new Error("Telegram getFile response is invalid");
  if (fileSize !== undefined && (typeof fileSize !== "number" || !Number.isSafeInteger(fileSize) || fileSize < 1 || fileSize > TELEGRAM_PRIVATE_FILE_MAX_BYTES)) {
    throw new Error("Telegram getFile response is invalid");
  }
  const safeFileSize = fileSize === undefined ? undefined : fileSize as number;
  const filePath = value.file_path;
  if (Object.hasOwn(value, "file_path") && filePath === undefined) throw new Error("Telegram getFile response is invalid");
  const safeFilePath = filePath === undefined ? undefined : validateTelegramFilePath(filePath);

  const result: { file_id: string; file_unique_id: string; file_size?: number; file_path?: string } = {
    file_id: fileId,
    file_unique_id: fileUniqueId,
  };
  if (safeFileSize !== undefined) result.file_size = safeFileSize;
  if (safeFilePath !== undefined) result.file_path = safeFilePath;
  return Object.freeze(result);
}

function boundedTelegramText(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value &&
    Buffer.byteLength(value, "utf8") <= maxBytes &&
    !/[\u0000-\u001f\u007f]|\p{Cc}|\p{Cf}|\p{Zl}|\p{Zp}/u.test(value);
}

function withTelegramFile(
  token: string,
  filePath: string,
  expectedSize: number | undefined,
  signal: AbortSignal | undefined,
  consumer: (bytes: Buffer) => void | Promise<void>,
  request: TelegramHttpsRequest,
): Promise<void> {
  let safePath: string;
  try {
    safePath = validateTelegramFilePath(filePath);
    if (expectedSize !== undefined && (!Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize > TELEGRAM_PRIVATE_FILE_MAX_BYTES)) {
      throw new Error("Telegram file size is invalid");
    }
    if (!boundedTelegramToken(token)) throw new Error("Telegram token is invalid");
  } catch {
    return Promise.reject(new TelegramApiError(400, "Telegram file download failed"));
  }

  return new Promise<void>((resolve, reject) => {
    let requestClient: ClientRequest | undefined;
    let response: TelegramFileResponse | undefined;
    let buffer = Buffer.alloc(TELEGRAM_PRIVATE_FILE_MAX_BYTES);
    let total = 0;
    let settled = false;
    let consuming = false;
    let networkComplete = false;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let deadlineExpired = false;
    let requestErrorListener: (() => void) | undefined;
    let responseDataListener: ((chunk: Buffer | string) => void) | undefined;
    let responseErrorListener: (() => void) | undefined;
    let responseEndListener: (() => void) | undefined;

    const cleanBuffer = (): void => {
      buffer.fill(0);
    };
    const clearDeadline = (): void => {
      if (deadlineTimer !== undefined) {
        clearTimeout(deadlineTimer);
        deadlineTimer = undefined;
      }
    };
    const detachNetworkListeners = (): void => {
      if (requestClient && requestErrorListener) requestClient.removeListener("error", requestErrorListener);
      if (response && responseDataListener) response.removeListener("data", responseDataListener);
      if (response && responseErrorListener) response.removeListener("error", responseErrorListener);
      if (response && responseEndListener) response.removeListener("end", responseEndListener);
      requestErrorListener = undefined;
      responseDataListener = undefined;
      responseErrorListener = undefined;
      responseEndListener = undefined;
    };
    const fail = (status = 502): void => {
      if (settled || networkComplete) return;
      settled = true;
      clearDeadline();
      if (requestClient && requestErrorListener) requestClient.removeListener("error", requestErrorListener);
      requestErrorListener = undefined;
      try { response?.destroy?.(); } catch { /* best-effort cancellation */ }
      try { requestClient?.destroy?.(); } catch { /* best-effort cancellation */ }
      cleanBuffer();
      signal?.removeEventListener("abort", onAbort);
      reject(new TelegramApiError(status, "Telegram file download failed"));
    };
    const succeed = (): void => {
      if (settled || consuming || networkComplete) return;
      if (total < 1 || (expectedSize !== undefined && total !== expectedSize)) {
        fail(502);
        return;
      }
      networkComplete = true;
      clearDeadline();
      signal?.removeEventListener("abort", onAbort);
      detachNetworkListeners();
      consuming = true;
      const view = buffer.subarray(0, total);
      Promise.resolve()
        .then(() => consumer(view))
        .then(() => {
          if (settled) return;
          settled = true;
          clearDeadline();
          signal?.removeEventListener("abort", onAbort);
          cleanBuffer();
          resolve();
        })
        .catch(() => {
          if (settled) return;
          settled = true;
          clearDeadline();
          signal?.removeEventListener("abort", onAbort);
          cleanBuffer();
          reject(new TelegramApiError(502, "Telegram file consumer failed"));
        })
        .finally(() => {
          cleanBuffer();
        });
    };
    const onAbort = (): void => fail(499);
    const onResponse = (incoming: TelegramFileResponse): void => {
      if (settled || networkComplete) {
        try { incoming.destroy?.(); } catch { /* best-effort cancellation */ }
        try { incoming.resume?.(); } catch { /* best-effort cancellation */ }
        return;
      }
      response = incoming;
      const status = incoming.statusCode;
      const contentType = headerValue(incoming.headers, "content-type");
      const contentEncoding = incoming.headers["content-encoding"];
      const rawLength = incoming.headers["content-length"];
      const declaredLength = parseTelegramContentLength(rawLength);
      if (
        status !== 200 ||
        contentType === undefined ||
        !TELEGRAM_FILE_ALLOWED_CONTENT_TYPES.has(contentType.split(";", 1)[0]!.trim().toLowerCase()) ||
        contentEncoding !== undefined ||
        (rawLength !== undefined && declaredLength === undefined) ||
        (declaredLength !== undefined && declaredLength > TELEGRAM_PRIVATE_FILE_MAX_BYTES) ||
        (expectedSize !== undefined && declaredLength !== undefined && expectedSize !== declaredLength)
      ) {
        responseDataListener = zeroTelegramResponseChunk;
        incoming.on("data", responseDataListener);
        fail(status && status >= 400 ? status : 502);
        incoming.resume?.();
        return;
      }

      incoming.setTimeout?.(TELEGRAM_FILE_DOWNLOAD_TIMEOUT_MS, () => fail(408));
      if (settled) {
        try { incoming.destroy?.(); } catch { /* best-effort cancellation */ }
        try { incoming.resume?.(); } catch { /* best-effort cancellation */ }
        return;
      }
      responseDataListener = (chunk: Buffer | string): void => {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        try {
          if (settled || total + value.byteLength > TELEGRAM_PRIVATE_FILE_MAX_BYTES || (declaredLength !== undefined && total + value.byteLength > declaredLength)) {
            fail(502);
            return;
          }
          value.copy(buffer, total);
          total += value.byteLength;
        } finally {
          value.fill(0);
        }
      };
      responseErrorListener = (): void => fail(502);
      responseEndListener = (): void => {
        if (declaredLength !== undefined && total !== declaredLength) {
          fail(502);
          return;
        }
        succeed();
      };
      incoming.on("data", responseDataListener);
      incoming.on("error", responseErrorListener);
      incoming.on("end", responseEndListener);
    };

    deadlineTimer = setTimeout(() => {
      deadlineExpired = true;
      fail(408);
    }, TELEGRAM_FILE_DOWNLOAD_TIMEOUT_MS);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }

    try {
      requestClient = request({
        protocol: "https:",
        hostname: "api.telegram.org",
        port: 443,
        path: `/file/bot${token}/${safePath}`,
        method: "GET",
        agent: false,
        headers: { "accept-encoding": "identity" },
      }, onResponse);
      if (deadlineExpired) {
        try { requestClient.destroy?.(); } catch { /* best-effort cancellation */ }
        return;
      }
      requestErrorListener = (): void => fail(502);
      requestClient.once("error", requestErrorListener);
      requestClient.setTimeout(TELEGRAM_FILE_DOWNLOAD_TIMEOUT_MS, () => fail(408));
      if (settled) return;
      requestClient.end();
    } catch {
      fail(502);
    }
  });
}

function zeroTelegramResponseChunk(chunk: Buffer | string): void {
  if (Buffer.isBuffer(chunk)) chunk.fill(0);
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return typeof value === "string" ? value : undefined;
}

function parseTelegramContentLength(value: string | string[] | undefined): number | undefined {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/u.test(value)) return undefined;
  const length = Number(value);
  return Number.isSafeInteger(length) && length >= 1 ? length : undefined;
}

function boundedTelegramToken(value: string): boolean {
  return value.length > 0 && Buffer.byteLength(value, "utf8") <= TELEGRAM_FILE_ID_MAX_BYTES &&
    !/[\u0000-\u001f\u007f\p{Cc}\p{Cf}\p{Zl}\p{Zp}\\/?#]/u.test(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  try {
    return typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;
  } catch {
    return false;
  }
}

export function abortableSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted || milliseconds <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolveSleep) => {
    const timeout = setTimeout(cleanup, milliseconds);
    const abort = (): void => cleanup();
    function cleanup(): void {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      resolveSleep();
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function chatHash(chatId: number | string): string {
  return `chat-${sha256Hex(String(chatId)).slice(0, 12)}`;
}

function validUpdateId(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= Number.MAX_SAFE_INTEGER ? value : undefined;
}

function nextOffsetFor(updateId: number): number {
  return updateId + 1;
}

function canonicalTelegramIdentifier(value: unknown, user: boolean): string | undefined {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || (user ? value <= 0 : value === 0)) return undefined;
    const parsed = BigInt(value);
    return parsed >= BigInt("-9223372036854775808") && parsed <= BigInt("9223372036854775807") ? String(value) : undefined;
  }
  if (typeof value !== "string" || !/^-?[1-9][0-9]*$/u.test(value) || (user && value.startsWith("-"))) {
    return undefined;
  }
  try {
    const parsed = BigInt(value);
    if (parsed < BigInt("-9223372036854775808") || parsed > BigInt("9223372036854775807") || (user ? parsed <= 0n : parsed === 0n)) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sanitizeRuntimeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\b\d{6,12}:[A-Za-z0-9_-]{20,}\b/g, "[redacted]")
    .replace(/\b(token\s+)[A-Za-z0-9:_-]+\b/gi, "$1[redacted]");
}
