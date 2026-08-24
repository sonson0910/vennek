import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { PgBoss } from "pg-boss";
import {
  ConversationRepository,
  createDatabase,
  ensureConversationPartitions,
  parseAgentConfig,
  type AgentConfig,
} from "@vennek/cardano-agent";
import { createAgentAnswer, processAgentJob } from "./agentWorker.js";
import { PgBossAgentQueue, type TelegramAnswerJob } from "./agentQueue.js";
import { createTelegramApi, deliverMessage, runPolling, type RuntimeLogLevel } from "./pollingRuntime.js";
import { createWebhookOptions, handleTelegramWebhook } from "./webhookRuntime.js";
import { sha256Hex, type CommandContext } from "@vennek/shared";

const TELEGRAM_QUEUE = "telegram-answer";
const PARTITION_QUEUE = "conversation-partition-maintenance";
const SERVER_DRAIN_TIMEOUT_MS = 15_000;

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--health")) {
    const { validateRuntimeState } = await import("./runtimeState.js");
    const state = validateRuntimeState(process.env.VENNEK_DATA_DIR);
    logJson("info", "healthcheck", { ok: true, persistenceEnabled: Boolean(process.env.VENNEK_DATA_DIR), offset: state.offset });
    return;
  }
  if (args.includes("--worker")) return runWorker();
  if (args.includes("--webhook")) return runWebhook();
  if (args.includes("--poll")) return runPoll();
  const input = args.join(" ").trim() || "/proposal catalyst-review-workbench";
  const { config } = agentRuntimeConfig();
  const agent = await createConfiguredAgentAnswer(config);
  try {
    console.log(await agent.answer(input, runtimeContext()));
  } finally {
    await agent.close();
  }
}

async function runPoll(): Promise<void> {
  const { config, token } = agentRuntimeConfig();
  const db = createDatabase(config.databaseUrl);
  await ensureConversationPartitions(db);
  const agentAnswer = createAgentAnswer(new ConversationRepository(db, config.encryptionKey));
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    await runPolling({
      api: createTelegramApi(token, controller.signal),
      answer: agentAnswer,
      context: runtimeContext(),
      logger: (level, event, fields) => logJson(level, event, fields),
      signal: controller.signal,
    });
  } finally {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    await db.end();
  }
}

async function runWorker(): Promise<void> {
  const { config, token } = runtimeConfig();
  const db = createDatabase(config.databaseUrl);
  const boss = new PgBoss({ db: { executeSql: (text, values) => db.query(text, values) } });
  const repository = new ConversationRepository(db, config.encryptionKey);
  const api = createTelegramApi(token);
  try {
    await ensureConversationPartitions(db);
    await boss.start();
    await boss.createQueue(TELEGRAM_QUEUE);
    await boss.createQueue(PARTITION_QUEUE);
    await boss.schedule(PARTITION_QUEUE, "0 0 * * *");
    await boss.work(PARTITION_QUEUE, async () => ensureConversationPartitions(db));
    const answer = createAgentAnswer(repository);
    await boss.work<TelegramAnswerJob>(TELEGRAM_QUEUE, async ([job]) => {
      if (!job) return;
      const outcome = await processAgentJob(job.data, {
        answer,
        send: async (chatId, text) => {
          const delivery = await deliverMessage(api, { chat_id: chatId, text, disable_web_page_preview: true }, 3_000);
          if (!delivery.delivered) {
            logJson("warn", "telegram_delivery_abandoned", {
              updateId: job.data.updateId,
              chatHash: `chat-${hashChat(chatId)}`,
              attempts: delivery.attempts,
              ...(delivery.status === undefined ? {} : { status: delivery.status }),
            });
          }
          return delivery;
        },
      });
      await db.query(
        "UPDATE telegram_updates SET status = $1, processed_at = CASE WHEN $1 = 'processed' THEN now() ELSE processed_at END WHERE update_id = $2",
        [outcome.delivered ? "processed" : "failed", job.data.updateId],
      ).catch((error) => logJson("error", "telegram_update_status_failed", { updateId: job.data.updateId, error: sanitizeError(error) }));
    });
    await waitForSignal();
  } finally {
    await boss.stop().catch(() => undefined);
    await db.end().catch(() => undefined);
  }
}

async function runWebhook(): Promise<void> {
  const { config, webhookSecret } = runtimeConfig();
  const db = createDatabase(config.databaseUrl);
  const boss = new PgBoss({ db: { executeSql: (text, values) => db.query(text, values) } });
  const queue = new PgBossAgentQueue(boss, db);
  const options = createWebhookOptions(webhookSecret, queue.enqueue.bind(queue));
  const server = createServer({ maxHeaderSize: 16 * 1024 }, (request, response) => {
    const requestAbort = new AbortController();
    const abort = (): void => {
      if (!response.writableEnded) requestAbort.abort();
    };
    request.once("aborted", abort);
    response.once("close", abort);
    void handleNodeRequest(request, response, options, requestAbort.signal).catch(() => {
      response.statusCode = 500;
      response.end("Internal server error");
    }).finally(() => {
      request.off("aborted", abort);
      response.off("close", abort);
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.timeout = 15_000;
  server.maxHeadersCount = 64;
  try {
    await ensureConversationPartitions(db);
    await boss.start();
    await boss.createQueue(TELEGRAM_QUEUE);
    await listen(server, Number(process.env.PORT ?? 8080));
    await waitForServerDrain(server);
  } finally {
    await closeServer(server);
    await boss.stop().catch(() => undefined);
    await db.end().catch(() => undefined);
  }
}

async function handleNodeRequest(request: IncomingMessage, response: ServerResponse, options: ReturnType<typeof createWebhookOptions>, signal: AbortSignal): Promise<void> {
  const requestPath = request.url?.startsWith("/") ? request.url : "/";
  const url = new URL(requestPath, "http://127.0.0.1");
  if (url.pathname !== "/telegram/webhook") {
    response.statusCode = 404;
    response.end("Not found");
    return;
  }
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (typeof value === "string") headers.set(key, value);
    else if (value) headers.set(key, value.join(", "));
  }
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : request;
  const webRequest = new Request(url, {
    method: request.method ?? "GET",
    headers,
    body: body as unknown as BodyInit,
    signal,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  const result = await handleTelegramWebhook(webRequest, options);
  response.statusCode = result.status;
  result.headers.forEach((value, key) => response.setHeader(key, value));
  response.end(await result.text());
}

async function createConfiguredAgentAnswer(config: AgentConfig): Promise<{
  answer(input: string, context: CommandContext): Promise<string>;
  close(): Promise<void>;
}> {
  const db = createDatabase(config.databaseUrl);
  await ensureConversationPartitions(db);
  const agentAnswer = createAgentAnswer(new ConversationRepository(db, config.encryptionKey));
  return {
    answer: (input) => agentAnswer({ telegramUserId: "1", telegramChatId: "1", text: input }),
    close: () => db.end(),
  };
}

function agentRuntimeConfig(): { config: AgentConfig; token: string } {
  return { config: parseAgentConfig(process.env), token: requiredEnv("TELEGRAM_BOT_TOKEN") };
}

function runtimeConfig(): { config: AgentConfig; token: string; webhookSecret: string } {
  const { config, token } = agentRuntimeConfig();
  return { config, token, webhookSecret: requiredEnv("TELEGRAM_WEBHOOK_SECRET") };
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function runtimeContext(): CommandContext {
  return { persistenceRoot: process.env.VENNEK_DATA_DIR, enableFixtures: process.env.VENNEK_ENABLE_FIXTURES === "true", blockfrostProjectId: process.env.BLOCKFROST_PROJECT_ID, blockfrostNetwork: parseBlockfrostNetwork(process.env.BLOCKFROST_NETWORK) };
}

function parseBlockfrostNetwork(value: string | undefined): CommandContext["blockfrostNetwork"] {
  return value === "preprod" || value === "preview" || value === "mainnet" ? value : undefined;
}

function logJson(level: RuntimeLogLevel, event: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ level, event, timestamp: new Date().toISOString(), ...fields });
  if (level === "error") console.error(line);
  else console.log(line);
}

function sanitizeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\b\d{6,12}:[A-Za-z0-9_-]{20,}\b/g, "[redacted]");
}

function hashChat(chatId: string): string {
  return sha256Hex(chatId).slice(0, 12);
}

function listen(server: ReturnType<typeof createServer>, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(port, "0.0.0.0", () => {
      server.off("error", onError);
      resolve();
    });
  });
}

function waitForSignal(): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      process.off("SIGTERM", done);
      process.off("SIGINT", done);
      resolve();
    };
    process.once("SIGTERM", done);
    process.once("SIGINT", done);
  });
}

function waitForServerDrain(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve) => {
    let closing = false;
    const close = (): void => {
      if (closing) return;
      closing = true;
      process.off("SIGTERM", close);
      process.off("SIGINT", close);
      void closeServer(server).then(resolve);
    };
    process.once("SIGTERM", close);
    process.once("SIGINT", close);
  });
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => {
    let finished = false;
    let forceCloseTimer: NodeJS.Timeout | undefined;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      if (forceCloseTimer) clearTimeout(forceCloseTimer);
      resolve();
    };
    forceCloseTimer = setTimeout(() => {
      server.closeAllConnections?.();
      finish();
    }, SERVER_DRAIN_TIMEOUT_MS);
    forceCloseTimer.unref();
    server.close(finish);
    server.closeIdleConnections?.();
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const message = error instanceof Error ? error.message : String(error);
    console.error(token ? message.replaceAll(token, "[redacted]") : message);
    process.exitCode = 1;
  });
}
