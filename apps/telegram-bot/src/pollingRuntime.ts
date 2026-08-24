import { sha256Hex, type CommandContext } from "@vennek/shared";
import { FixedWindowRateLimiter, type RateLimiter } from "./accessControl.js";
import { readTelegramOffset, writeTelegramOffset } from "./runtimeState.js";

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
};

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

export function createTelegramApi(token: string, signal?: AbortSignal): TelegramApi {
  return {
    getUpdates: (params) => telegramCall<TelegramUpdate[]>(token, "getUpdates", params, signal),
    sendMessage: (params) => telegramCall(token, "sendMessage", params, signal)
  };
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
