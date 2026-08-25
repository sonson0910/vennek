import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { PgBoss } from "pg-boss";
import {
  ConversationRepository,
  createDatabase,
  EmbeddingClient,
  ensureConversationPartitions,
  LiteLlmClient,
  KnowledgeRepository,
  PrivateDocumentClient,
  PdfExtractorClient,
  PromotionAuditRepository,
  SearxngClient,
  parseAgentConfig,
  promoteDiscoveredLink,
  promoteQuestionSources,
  retrieveEvidence,
  syncSource,
  type AgentConfig,
  type AnswerCompletionInput,
  type CompletionOutput,
  type EmbeddingProvider,
  type PdfExtractor,
  type PromoteDiscoveredLinkInput,
  type QuestionRetrievalInput,
  type PrivateComparisonCompletion,
} from "@vennek/cardano-agent";
import { createAgentAnswer, processAgentJob, type AgentAnswer, type AgentAnswerDependencies } from "./agentWorker.js";
import { PgBossAgentQueue, type PgBossLike, type PgPoolLike, type TelegramAnswerJob } from "./agentQueue.js";
import type { PrivateComparisonIngressJob } from "./privateComparisonQueue.js";
import { PRIVATE_COMPARISON_QUEUE, parsePrivateComparisonEncryptionKey } from "./privateComparisonQueue.js";
import {
  processPrivateComparisonJob,
  type PrivateComparisonFailureCategory,
} from "./privateComparisonRuntime.js";
import { createTelegramApi, deliverMessage, runPolling, type RuntimeLogLevel } from "./pollingRuntime.js";
import { createWebhookOptions, handleTelegramWebhook } from "./webhookRuntime.js";
import {
  KNOWLEDGE_BOSS_SCHEMA,
  enqueueKnowledgeSource,
  loadKnowledgeSourceRegistry,
  loadKnowledgeSourceMap,
  registerKnowledgeWorker,
} from "./knowledgeWorker.js";
import { createKnowledgePromotionServer, type KnowledgePromotionServerDependencies } from "./knowledgePromotionServer.js";
import { sha256Hex, type CommandContext } from "@vennek/shared";
import { KnowledgePromotionClient } from "./knowledgePromotionClient.js";
import { parsePromotionIdentity, parsePromotionOrigin, type PromotionIdentity } from "./knowledgePromotionProtocol.js";

export function parseAgentWorkerConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): AgentConfig {
  return parseAgentConfig(env, { mode: "worker" });
}

export function createPollingPrivateAdmission(
  boss: PgBossLike,
  database: PgPoolLike,
  encryptionKey: Uint8Array,
): (job: PrivateComparisonIngressJob) => Promise<boolean> {
  const queue = new PgBossAgentQueue(boss, database, encryptionKey);
  return queue.enqueue.bind(queue);
}

const TELEGRAM_QUEUE = "telegram-answer";
const PARTITION_QUEUE = "conversation-partition-maintenance";
const SERVER_DRAIN_TIMEOUT_MS = 15_000;

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const knowledgeMode = parseKnowledgeMode(args);
  if (knowledgeMode === "worker") return runKnowledgeWorker();
  if (knowledgeMode?.startsWith("sync:")) return runKnowledgeSync(knowledgeMode.slice("sync:".length));
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
  const config = parseAgentConfig(process.env);
  const agent = await createConfiguredAgentAnswer(config);
  try {
    console.log(await agent.answer(input, runtimeContext()));
  } finally {
    await agent.close();
  }
}

export function parseKnowledgeMode(args: readonly string[]): "worker" | `sync:${string}` | undefined {
  const worker = args.includes("--knowledge-worker");
  const syncIndex = args.indexOf("--sync-source");
  if (!worker && syncIndex < 0) return undefined;
  if (worker && syncIndex >= 0) throw new Error("--knowledge-worker and --sync-source are mutually exclusive.");
  if (worker && args.length !== 1) throw new Error("--knowledge-worker does not accept additional arguments.");
  if (syncIndex >= 0 && (args.length !== 2 || syncIndex !== 0 || !args[1])) {
    throw new Error("--sync-source requires exactly one source id.");
  }
  return worker ? "worker" : `sync:${args[1]!}`;
}

export type KnowledgeRuntimeConfig = {
  databaseUrl: string;
  liteLlmBaseUrl: URL;
  liteLlmApiKey: string;
  embeddingModel: string;
  searxngBaseUrl: URL;
  promotionPort: number;
  promotionIdentity: PromotionIdentity;
  githubToken?: string;
  pdfExtractorUrl?: string;
  pdfExtractorToken?: string;
};

export type KnowledgeDatabaseConfig = { databaseUrl: string };

export function parseKnowledgeDatabaseConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): KnowledgeDatabaseConfig {
  const databaseUrl = env.DATABASE_KNOWLEDGE_URL?.trim();
  if (!databaseUrl) throw new Error("DATABASE_KNOWLEDGE_URL is required");
  return { databaseUrl };
}

export function parseKnowledgeRuntimeConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): KnowledgeRuntimeConfig {
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  const database = parseKnowledgeDatabaseConfig(env);
  if (env.KNOWLEDGE_PROMOTION_URL !== undefined) {
    throw new Error("KNOWLEDGE_PROMOTION_URL is client-only");
  }
  const baseValue = required("LITELLM_BASE_URL");
  let baseUrl: URL;
  try { baseUrl = new URL(baseValue); } catch { throw new Error("LITELLM_BASE_URL must be a valid URL"); }
  if (!["http:", "https:"].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password) {
    throw new Error("LITELLM_BASE_URL must be an HTTP(S) URL without credentials");
  }
  const searxngBaseUrl = parseSearxngBaseUrl(required("SEARXNG_BASE_URL"));
  const promotionPort = parseKnowledgePromotionPort(required("KNOWLEDGE_PROMOTION_PORT"));
  const promotionIdentity = parsePromotionIdentity(
    required("KNOWLEDGE_PROMOTION_KEY_ID"),
    required("KNOWLEDGE_PROMOTION_KEY"),
  );
  const pdfUrl = env.PDF_EXTRACTOR_URL?.trim();
  const pdfToken = env.PDF_EXTRACTOR_TOKEN?.trim();
  if ((pdfUrl && !pdfToken) || (!pdfUrl && pdfToken)) throw new Error("PDF extractor URL and token must be configured together");
  return {
    ...database,
    liteLlmBaseUrl: baseUrl,
    liteLlmApiKey: required("LITELLM_API_KEY"),
    embeddingModel: required("VENNEK_EMBEDDING_MODEL"),
    searxngBaseUrl,
    promotionPort,
    promotionIdentity,
    ...(env.GITHUB_TOKEN?.trim() ? { githubToken: env.GITHUB_TOKEN.trim() } : {}),
    ...(pdfUrl && pdfToken ? { pdfExtractorUrl: pdfUrl, pdfExtractorToken: pdfToken } : {}),
  };
}

function parseSearxngBaseUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("SEARXNG_BASE_URL must be a valid URL"); }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("SEARXNG_BASE_URL must be an HTTP(S) origin without credentials or path");
  }
  return url;
}

function parseKnowledgePromotionPort(value: string): number {
  if (!/^[1-9][0-9]{0,4}$/.test(value)) throw new Error("KNOWLEDGE_PROMOTION_PORT must be a canonical integer from 1 to 65535");
  const port = Number(value);
  if (port > 65_535) throw new Error("KNOWLEDGE_PROMOTION_PORT must be a canonical integer from 1 to 65535");
  return port;
}

async function runKnowledgeSync(sourceId: string): Promise<void> {
  const config = parseKnowledgeDatabaseConfig();
  const entries = loadKnowledgeSourceMap();
  if (!entries.has(sourceId)) throw new Error("Unknown Cardano source id.");
  const db = createDatabase(config.databaseUrl);
  const boss = createRuntimePgBoss(db, KNOWLEDGE_BOSS_SCHEMA);
  try {
    await boss.start();
    const jobId = await enqueueKnowledgeSource(boss, sourceId);
    console.log(jobId);
  } finally {
    await boss.stop().catch(() => undefined);
    await db.end();
  }
}

export type KnowledgePromotionHandlerInput = Readonly<{
  search: Pick<SearxngClient, "search">;
  repository: PromoteDiscoveredLinkInput["repository"];
  embedder: PromoteDiscoveredLinkInput["embedder"];
  embeddingModel: string;
  loadRegistry?: () => unknown;
  promoteLink?: (input: PromoteDiscoveredLinkInput) => Promise<unknown>;
  pdfExtractor?: PdfExtractor;
}>;

export function createKnowledgePromotionHandler(
  input: KnowledgePromotionHandlerInput,
): KnowledgePromotionServerDependencies["promote"] {
  const loadRegistry = input.loadRegistry ?? loadKnowledgeSourceRegistry;
  const promoteLink = input.promoteLink ?? promoteDiscoveredLink;
  return (question, signal) => {
    const registry = loadRegistry();
    return promoteQuestionSources({
      question,
      registry,
      search: input.search,
      signal,
      promote: async (link, promotionSignal, deadlineAt) => {
        const promoted = await promoteLink({
          link,
          registry,
          repository: input.repository,
          embedder: input.embedder,
          embeddingModel: input.embeddingModel,
          signal: promotionSignal,
          deadlineAt,
          ...(input.pdfExtractor ? { pdfExtractor: input.pdfExtractor } : {}),
        });
        if (!hasSourceId(promoted)) throw new Error("Live source promotion failed");
        return promoted;
      },
    });
  };
}

function hasSourceId(value: unknown): value is { sourceId: string } {
  return typeof value === "object" && value !== null && "sourceId" in value &&
    typeof (value as { sourceId?: unknown }).sourceId === "string" &&
    (value as { sourceId: string }).sourceId.length > 0;
}

async function runKnowledgeWorker(): Promise<void> {
  const config = parseKnowledgeRuntimeConfig();
  const db = createDatabase(config.databaseUrl);
  const boss = createRuntimePgBoss(db, KNOWLEDGE_BOSS_SCHEMA);
  const embedder = new EmbeddingClient(config.liteLlmBaseUrl, config.liteLlmApiKey, config.embeddingModel);
  const repository = new KnowledgeRepository(db);
  const search = new SearxngClient(config.searxngBaseUrl);
  const audit = new PromotionAuditRepository(db);
  const pdfExtractor = config.pdfExtractorUrl && config.pdfExtractorToken
    ? new PdfExtractorClient({ url: config.pdfExtractorUrl, token: config.pdfExtractorToken })
    : undefined;
  let promotionServer: ReturnType<typeof createKnowledgePromotionServer> | undefined;
  try {
    promotionServer = createKnowledgePromotionServer({
      identity: config.promotionIdentity,
      audit,
      promote: createKnowledgePromotionHandler({
        search,
        repository,
        embedder,
        embeddingModel: config.embeddingModel,
        ...(pdfExtractor ? { pdfExtractor } : {}),
      }),
    });
    await boss.start();
    await audit.prune(new Date()).catch(() => undefined);
    await listen(promotionServer, config.promotionPort);
    await registerKnowledgeWorker({
      boss,
      sync: (entry, signal) => syncSource({ entry, repository, embedder, embeddingModel: config.embeddingModel, signal, ...(config.githubToken ? { githubToken: config.githubToken } : {}), ...(pdfExtractor ? { pdfExtractor } : {}) }),
    });
    await waitForSignal();
  } finally {
    if (promotionServer) await closeServer(promotionServer);
    await boss.stop().catch(() => undefined);
    await db.end().catch(() => undefined);
  }
}

async function runPoll(): Promise<void> {
  const { config, token } = agentRuntimeConfig();
  const db = createDatabase(config.databaseUrl);
  const boss = createRuntimePgBoss(db);
  const controller = new AbortController();
  const enqueuePrivate = createPollingPrivateAdmission(boss, db, config.encryptionKey);
  const stop = (): void => controller.abort();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    await ensureConversationPartitions(db);
    await boss.start();
    const agentAnswer = createRuntimeAgentAnswer(db, config);
    await runPolling({
      api: createTelegramApi(token, controller.signal),
      answer: agentAnswer,
      enqueuePrivate,
      context: runtimeContext(),
      logger: (level, event, fields) => logJson(level, event, fields),
      signal: controller.signal,
    });
  } finally {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    await boss.stop().catch(() => undefined);
    await db.end();
  }
}

async function runWorker(): Promise<void> {
  const { config, token } = agentRuntimeConfig(true);
  const promotionClient = new KnowledgePromotionClient(parseKnowledgePromotionClientConfig());
  const db = createDatabase(config.databaseUrl);
  const boss = createRuntimePgBoss(db);
  const api = createTelegramApi(token);
  const extractor = new PrivateDocumentClient({
    url: config.privateDocumentExtractorUrl!.toString(),
    token: config.privateDocumentExtractorToken!,
  });
  const privateEmbedder = new EmbeddingClient(config.liteLlmBaseUrl, config.liteLlmApiKey, config.models.embedding);
  const privateLlm = new LiteLlmClient(config.liteLlmBaseUrl, config.liteLlmApiKey);
  try {
    await ensureConversationPartitions(db);
    await boss.start();
    await boss.schedule(PARTITION_QUEUE, "0 0 * * *");
    await boss.work(PARTITION_QUEUE, async () => ensureConversationPartitions(db));
    const answer = createRuntimeAgentAnswer(db, config, { discover: promotionClient.promote.bind(promotionClient) });
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
    await boss.work(PRIVATE_COMPARISON_QUEUE, async ([job]) => {
      if (!job) return;
      const data = job.data;
      const updateId = typeof data === "object" && data !== null && typeof (data as { updateId?: unknown }).updateId === "number"
        ? (data as { updateId: number }).updateId
        : undefined;
      try {
        if (updateId === undefined) throw new Error("invalid private comparison job");
        const outcome = await processPrivateComparisonJob(data, {
          api,
          encryptionKey: config.encryptionKey,
          extractor,
          retrieve: retrieveEvidence,
          db,
          embedder: privateEmbedder,
          embeddingModel: config.models.embedding,
          generationModel: config.privateModels!.quality,
          verifierModel: config.privateModels!.verifier,
          complete: privateCompletion(privateLlm),
          recordUsage: (telegramUserId, usage) => recordPrivateUsage(db, telegramUserId, usage),
          send: async (chatId, text) => {
            const delivery = await deliverMessage(api, { chat_id: chatId, text, disable_web_page_preview: true }, 3_000, job.signal);
            if (!delivery.delivered) {
              logJson("warn", "telegram_delivery_abandoned", {
                updateId,
                chatHash: `chat-${hashChat(chatId)}`,
                attempts: delivery.attempts,
                ...(delivery.status === undefined ? {} : { status: delivery.status }),
              });
            }
            return delivery;
          },
          signal: job.signal,
          markStatus: (id, status) => markTelegramUpdate(db, id, status),
          log: (category) => logPrivateComparisonFailure(category),
        });
        if (!outcome.delivered && !outcome.aborted && !outcome.terminal) throw new Error("private comparison delivery failed");
      } catch (error) {
        if (updateId === undefined) logPrivateComparisonFailure(privateFailureCategory(error));
        throw error;
      }
    });
    await waitForSignal();
  } finally {
    await boss.stop().catch(() => undefined);
    await db.end().catch(() => undefined);
  }
}

async function runWebhook(): Promise<void> {
  const { databaseUrl, webhookSecret, encryptionKey } = webhookRuntimeConfig();
  const db = createDatabase(databaseUrl);
  const boss = createRuntimePgBoss(db);
  const queue = new PgBossAgentQueue(boss, db, encryptionKey);
  const options = createWebhookOptions(webhookSecret, queue.enqueue.bind(queue), encryptionKey);
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
    await listen(server, Number(process.env.PORT ?? 8080));
    await waitForServerDrain(server);
  } finally {
    await closeServer(server);
    await boss.stop().catch(() => undefined);
    await db.end().catch(() => undefined);
  }
}

function createRuntimePgBoss(db: ReturnType<typeof createDatabase>, schema?: string): PgBoss {
  return new PgBoss({
    db: { executeSql: (text, values) => db.query(text, values) },
    migrate: false,
    createSchema: false,
    ...(schema ? { schema } : {}),
  });
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
  try {
    await ensureConversationPartitions(db);
    const agentAnswer = createRuntimeAgentAnswer(db, config);
    return {
      answer: (input) => agentAnswer({ telegramUserId: "1", telegramChatId: "1", text: input }),
      close: () => db.end(),
    };
  } catch (error) {
    await db.end().catch(() => undefined);
    throw error;
  }
}

function createRuntimeAgentAnswer(
  db: ReturnType<typeof createDatabase>,
  config: AgentConfig,
  clients: RuntimeAgentClients = {},
): AgentAnswer {
  const dependencies = createRuntimeAgentDependencies(db, config, clients);
  return createAgentAnswer(new ConversationRepository(db, config.encryptionKey), dependencies);
}

export type RuntimeAgentClients = {
  embedder?: EmbeddingProvider;
  complete?: (input: AnswerCompletionInput) => Promise<CompletionOutput>;
  retrieve?: typeof retrieveEvidence;
  discover?: (input: QuestionRetrievalInput) => Promise<void>;
};

export function parseKnowledgePromotionClientConfig(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): { origin: URL; identity: PromotionIdentity } {
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  return {
    origin: parsePromotionOrigin(required("KNOWLEDGE_PROMOTION_URL")),
    identity: parsePromotionIdentity(
      required("KNOWLEDGE_PROMOTION_KEY_ID"),
      required("KNOWLEDGE_PROMOTION_KEY"),
    ),
  };
}

export function createRuntimeAgentDependencies(
  db: ReturnType<typeof createDatabase>,
  config: AgentConfig,
  clients: RuntimeAgentClients = {},
): AgentAnswerDependencies {
  const embedder = clients.embedder ?? new EmbeddingClient(config.liteLlmBaseUrl, config.liteLlmApiKey, config.models.embedding);
  const llm = clients.complete ? undefined : new LiteLlmClient(config.liteLlmBaseUrl, config.liteLlmApiKey);
  const complete = clients.complete ?? ((input: AnswerCompletionInput) => llm!.complete(input));
  const retrieve = clients.retrieve ?? retrieveEvidence;
  const discover = clients.discover;
  const models = Object.freeze({
    fast: config.models.fast,
    quality: config.models.quality,
    verifier: config.models.verifier,
  });
  return {
    retrieve: ({ question, language }) => retrieve(
      { query: question, language, embeddingModel: config.models.embedding, cachePolicy: "stable" },
      { db, embedder },
    ),
    ...(discover === undefined ? {} : { discover: ({ question, language }: QuestionRetrievalInput) => discover({ question, language }) }),
    complete: async (input) => {
      const requestedModel = input.model;
      const messages = input.messages.map((message) => Object.freeze({ role: message.role, content: message.content }));
      const request = Object.freeze({
        model: requestedModel,
        messages: Object.freeze(messages),
        temperature: 0 as const,
      }) as unknown as AnswerCompletionInput;
      const output = await complete(request);
      return Object.freeze({
        text: output.text,
        model: requestedModel,
        promptTokens: output.promptTokens,
        completionTokens: output.completionTokens,
      });
    },
    models,
    recordUsage: async (telegramUserId, usage) => {
      await db.query(
        `INSERT INTO usage_ledger
         (telegram_user_id, model, prompt_tokens, completion_tokens, latency_ms)
         VALUES ($1, $2, $3, $4, $5)`,
        [telegramUserId, usage.model, usage.promptTokens, usage.completionTokens, usage.latencyMs],
      );
    },
  };
}

function agentRuntimeConfig(requirePrivateComparison = false): { config: AgentConfig; token: string } {
  return {
    config: requirePrivateComparison ? parseAgentWorkerConfig(process.env) : parseAgentConfig(process.env),
    token: requiredEnv("TELEGRAM_BOT_TOKEN"),
  };
}

function privateCompletion(client: LiteLlmClient): PrivateComparisonCompletion {
  return async (input) => {
    const output = await client.complete(input);
    return { ...output, model: input.model };
  };
}

async function recordPrivateUsage(
  db: ReturnType<typeof createDatabase>,
  telegramUserId: string,
  usage: { model: string; promptTokens: number; completionTokens: number; latencyMs: number },
): Promise<void> {
  await db.query(
    `INSERT INTO usage_ledger
     (telegram_user_id, model, prompt_tokens, completion_tokens, latency_ms)
     VALUES ($1, $2, $3, $4, $5)`,
    [telegramUserId, usage.model, usage.promptTokens, usage.completionTokens, usage.latencyMs],
  );
}

async function markTelegramUpdate(
  db: ReturnType<typeof createDatabase>,
  updateId: number,
  status: "processed" | "failed",
): Promise<void> {
  await db.query(
    "UPDATE telegram_updates SET status = $1, processed_at = CASE WHEN $1 = 'processed' THEN now() ELSE processed_at END WHERE update_id = $2",
    [status, updateId],
  );
}

function logPrivateComparisonFailure(category: PrivateComparisonFailureCategory): void {
  logJson("error", "private_comparison_failed", { category });
}

function privateFailureCategory(error: unknown): PrivateComparisonFailureCategory {
  if (error && typeof error === "object" && "category" in error) {
    const category = (error as { category?: unknown }).category;
    if (category === "validation" || category === "telegram" || category === "extraction" || category === "retrieval" || category === "comparison" || category === "delivery" || category === "processing") return category;
  }
  return "processing";
}

export type WebhookRuntimeConfig = {
  databaseUrl: string;
  webhookSecret: string;
  encryptionKey: Buffer;
};

export function parseWebhookRuntimeConfig(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): WebhookRuntimeConfig {
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  return {
    databaseUrl: required("DATABASE_URL"),
    webhookSecret: required("TELEGRAM_WEBHOOK_SECRET"),
    encryptionKey: parsePrivateComparisonEncryptionKey(env),
  };
}

function webhookRuntimeConfig(): WebhookRuntimeConfig {
  return parseWebhookRuntimeConfig();
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
