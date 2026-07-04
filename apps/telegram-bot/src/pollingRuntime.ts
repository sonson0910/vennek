import { sha256Hex, type CommandContext } from "@vennek/shared";
import { routeTelegramText } from "./router.js";
import { readTelegramOffset, writeTelegramOffset } from "./runtimeState.js";

export type TelegramUpdate = {
  update_id: number;
  message?: {
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
  logger?: RuntimeLogger;
  signal?: AbortSignal;
  pollTimeoutSeconds?: number;
  retryDelayMs?: number;
  maxCycles?: number;
};

type TelegramApiResponse<T> = {
  ok: boolean;
  result?: T;
  description?: string;
};

export async function runPolling(options: PollingOptions): Promise<void> {
  const context = options.context ?? {};
  const logger = options.logger ?? (() => undefined);
  const pollTimeoutSeconds = options.pollTimeoutSeconds ?? 50;
  const retryDelayMs = options.retryDelayMs ?? 3_000;
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
          const nextOffset = update.update_id + 1;
          const chatId = update.message?.chat?.id;
          const text = update.message?.text?.trim();
          if (chatId === undefined || !text) {
            offset = Math.max(offset, nextOffset);
            writeTelegramOffset(context.persistenceRoot, offset);
            logger("info", "telegram_update_skipped", { updateId: update.update_id, offset });
            continue;
          }

          const startedAt = Date.now();
          const response = await routeTelegramText(text, context);
          await options.api.sendMessage({
            chat_id: chatId,
            text: response,
            disable_web_page_preview: true
          });
          offset = Math.max(offset, nextOffset);
          writeTelegramOffset(context.persistenceRoot, offset);
          logger("info", "telegram_update_processed", {
            updateId: update.update_id,
            chatHash: chatHash(chatId),
            command: text.split(/\s+/, 1)[0] ?? "",
            durationMs: Date.now() - startedAt,
            offset
          });
        }
      } catch (error) {
        logger("error", "telegram_polling_error", { error: error instanceof Error ? error.message : String(error) });
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

export async function telegramCall<T>(token: string, method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(params),
    signal
  });

  const payload = (await response.json()) as TelegramApiResponse<T>;
  if (!response.ok || !payload.ok || payload.result === undefined) {
    throw new Error(payload.description ?? `Telegram API ${method} failed with HTTP ${response.status}`);
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
