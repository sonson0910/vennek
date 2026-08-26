import * as http from "node:http";
import { EventEmitter } from "node:events";
import type { IncomingMessage, RequestOptions } from "node:http";
import { describe, expect, it } from "vitest";
import { PgBoss } from "pg-boss";
import { sha256Hex } from "@vennek/shared";
import {
  createDatabase,
  createPrivateDocumentClient,
  createPrivateDocumentServer,
  extractPrivateDocument,
  KnowledgeRepository,
  retrieveEvidence,
  type EmbeddingProvider,
  type PrivateComparisonCompletion,
  type SourceRegistryEntry,
} from "@vennek/cardano-agent";
import {
  createTelegramApi,
  deliverMessage,
  type TelegramHttpsRequest,
} from "../apps/telegram-bot/src/pollingRuntime.js";
import {
  decryptPrivateComparisonJob,
  PgBossPrivateComparisonQueue,
  PRIVATE_COMPARISON_EXPIRE_SECONDS,
  PRIVATE_COMPARISON_MAX_LIFETIME_SECONDS,
  PRIVATE_COMPARISON_QUEUE,
  PRIVATE_COMPARISON_RETENTION_SECONDS,
  PRIVATE_COMPARISON_RETRY_BACKOFF,
  PRIVATE_COMPARISON_RETRY_DELAY_SECONDS,
  PRIVATE_COMPARISON_RETRY_LIMIT,
  type EncryptedPrivateComparisonJob,
  type PrivateComparisonIngressJob,
} from "../apps/telegram-bot/src/privateComparisonQueue.js";
import { processPrivateComparisonJob } from "../apps/telegram-bot/src/privateComparisonRuntime.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const ownerUrl = process.env.TEST_DATABASE_OWNER_URL;
const runIntegration = describe.skipIf(!databaseUrl || !ownerUrl);

const encryptionKey = Buffer.alloc(32, 0x2a);
const embedding = Array.from({ length: 1_536 }, (_, index) => index === 0 ? 1 : 0);
const generationModel = "task10-private-generation";
const verifierModel = "task10-private-verifier";

type TelegramHarness = {
  server: http.Server;
  port: number;
  messages: Array<{ chat_id: string | number; text: string }>;
  close(): Promise<void>;
};

class ExtractorWorker extends EventEmitter {
  postMessage(message: unknown): void {
    const value = message as { bytes: ArrayBuffer; metadata: { fileName: string; mime: string } };
    void extractPrivateDocument(new Uint8Array(value.bytes), value.metadata)
      .then((result) => this.emit("message", { ok: true, result }))
      .catch(() => this.emit("message", { ok: false, error: "Private document extraction failed" }));
  }

  terminate(): Promise<number> {
    this.emit("exit", 0);
    return Promise.resolve(0);
  }
}

function appBoss(database: ReturnType<typeof createDatabase>): PgBoss {
  return new PgBoss({
    db: { executeSql: (text, values) => database.query(text, values) },
    migrate: false,
    createSchema: false,
    maintenanceIntervalSeconds: 1,
    monitorIntervalSeconds: 1,
    superviseIntervalSeconds: 1,
  });
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Expected a TCP test server address"));
        return;
      }
      resolve(address.port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function readBody(request: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function json(response: http.ServerResponse, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(200, { "content-type": "application/json", "content-length": body.byteLength });
  response.end(body);
}

async function createTelegramHarness(token: string, bytes: Buffer, fileId: string, fileUniqueId: string): Promise<TelegramHarness> {
  const messages: Array<{ chat_id: string | number; text: string }> = [];
  const server = http.createServer(async (request, response) => {
    if (request.method === "POST" && request.url === `/bot${token}/getFile`) {
      json(response, { ok: true, result: { file_id: fileId, file_unique_id: fileUniqueId, file_size: bytes.byteLength, file_path: "documents/task10-private.md" } });
      return;
    }
    if (request.method === "POST" && request.url === `/bot${token}/sendMessage`) {
      const value = JSON.parse((await readBody(request)).toString("utf8")) as { chat_id: string | number; text: string };
      messages.push(value);
      json(response, { ok: true, result: { message_id: messages.length } });
      return;
    }
    if (request.method === "GET" && request.url === `/file/bot${token}/documents/task10-private.md`) {
      response.writeHead(200, { "content-type": "text/markdown", "content-length": bytes.byteLength });
      response.end(bytes);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  const port = await listen(server);
  return { server, port, messages, close: () => closeServer(server) };
}

function localRequest(port: number): TelegramHttpsRequest {
  return ((options, callback) => http.request({
    ...options,
    protocol: "http:",
    hostname: "127.0.0.1",
    port,
  }, callback)) as TelegramHttpsRequest;
}

function privateExtractorRequest(port: number): typeof http.request {
  const request = (options: RequestOptions, callback?: (response: IncomingMessage) => void) => http.request({
    ...options,
    protocol: "http:",
    hostname: "127.0.0.1",
    port,
  }, callback);
  return request as typeof http.request;
}

function localTelegramFetch(port: number): { restore(): void } {
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const source = typeof input === "string" || input instanceof URL ? input.toString() : input.url;
    const url = new URL(source);
    if (url.hostname !== "api.telegram.org") return previous(input, init);
    return previous(`http://127.0.0.1:${port}${url.pathname}${url.search}`, init);
  }) as typeof fetch;
  return { restore: () => { globalThis.fetch = previous; } };
}

function deterministicEmbedder(): EmbeddingProvider {
  return { embed: async (inputs) => inputs.map((_, index) => ({ index, embedding })) };
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for integration state");
}

async function noPrivateMarkers(db: ReturnType<typeof createDatabase>, markers: readonly string[]): Promise<void> {
  const patterns = markers.map((marker) => `%${marker}%`);
  const surfaces = [
    ["public", "telegram_users"],
    ["public", "conversation_messages"],
    ["public", "conversation_summaries"],
    ["public", "telegram_updates"],
    ["public", "usage_ledger"],
    ["public", "knowledge_sources"],
    ["public", "source_versions"],
    ["public", "knowledge_chunks"],
    ["public", "retrieval_cache"],
    ["public", "knowledge_promotion_requests"],
    ["pgboss", "job"],
    ["pgboss", "job_common"],
    ["pgboss", "job_dependency"],
    ["pgboss", "queue"],
    ["pgboss", "queue_stats"],
    ["pgboss", "schedule"],
    ["pgboss", "subscription"],
    ["pgboss", "warning"],
    ["pgboss", "bam"],
    ["pgboss", "version"],
  ] as const;
  for (const [schema, table] of surfaces) {
    const result = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${schema}.${table} AS surface WHERE to_jsonb(surface)::text LIKE ANY($1::text[])`,
      [patterns],
    );
    expect(result.rows[0]?.count, `${schema}.${table}`).toBe("0");
  }
}

async function expectNoPrivateConversationState(
  db: ReturnType<typeof createDatabase>,
  updateId: number,
  caption: string,
): Promise<void> {
  const ownerId = String(updateId);
  const messages = await db.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM conversation_messages WHERE telegram_user_id = $1 OR telegram_chat_id = $1",
    [ownerId],
  );
  expect(messages.rows[0]?.count).toBe("0");
  const summaries = await db.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM conversation_summaries WHERE telegram_user_id = $1",
    [ownerId],
  );
  expect(summaries.rows[0]?.count).toBe("0");
  const cached = await db.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM retrieval_cache WHERE query_hash = $1",
    [sha256Hex(caption)],
  );
  expect(cached.rows[0]?.count).toBe("0");
}

function tamperBase64(value: string): string {
  return `${value[0] === "A" ? "B" : "A"}${value.slice(1)}`;
}

async function clearPrivateJobs(boss: PgBoss): Promise<void> {
  for (const job of await boss.findJobs(PRIVATE_COMPARISON_QUEUE)) {
    await boss.deleteJob(PRIVATE_COMPARISON_QUEUE, job.id).catch(() => undefined);
  }
}

function privateJob(updateId: number, markers: { caption: string; fileId: string; fileUniqueId: string; fileName: string }): PrivateComparisonIngressJob {
  const userId = String(updateId);
  return {
    kind: "private-compare",
    updateId,
    telegramUserId: userId,
    telegramChatId: userId,
    metadata: {
      caption: markers.caption,
      fileId: markers.fileId,
      fileUniqueId: markers.fileUniqueId,
      fileName: markers.fileName,
      mime: "text/markdown",
    },
  };
}

runIntegration("private comparison PostgreSQL/PgBoss lifecycle", () => {
  it("encrypts, claims, extracts, retrieves, compares, delivers once, and leaves no private marker", async () => {
    const owner = createDatabase(ownerUrl!);
    const app = createDatabase(databaseUrl!);
    const boss = appBoss(app);
    const updateId = 8_700_000_000_000_000 + (Date.now() % 100_000);
    const suffix = `${process.pid}-${updateId}`;
    const markers = {
      caption: `TASK10_CAPTION_${suffix}`,
      fileId: `TASK10_FILE_ID_${suffix}`,
      fileUniqueId: `TASK10_FILE_UNIQUE_${suffix}`,
      fileName: `TASK10_FILENAME_${suffix}.md`,
    };
    const extractedPhrase = `TASK10_EXTRACTED_${suffix}`;
    const answerMarker = `TASK10_ANSWER_${suffix}`;
    const fileBytes = Buffer.from(`# Private staking notes\n\n${extractedPhrase}\nCardano uses proof of stake.`, "utf8");
    const token = "123456:task10local";
    const telegram = await createTelegramHarness(token, fileBytes, markers.fileId, markers.fileUniqueId);
    const telegramFetch = localTelegramFetch(telegram.port);
    const extractor = createPrivateDocumentServer({
      token: Buffer.alloc(32, 9).toString("base64url"),
      workerFactory: () => new ExtractorWorker(),
    });
    const extractorPort = await (async () => {
      await extractor.listen(0);
      const address = extractor.server.address();
      if (!address || typeof address === "string") throw new Error("Expected extractor TCP address");
      return address.port;
    })();
    const api = createTelegramApi(token, undefined, { request: localRequest(telegram.port) });
    const extractorClient = createPrivateDocumentClient({
      url: "http://private-document-extractor:8083",
      token: Buffer.alloc(32, 9).toString("base64url"),
      request: privateExtractorRequest(extractorPort),
    });
    const sourceId = `task10-public-${suffix}`;
    const publicText = "Cardano uses proof of stake and delegates can stake ADA.";
    const publicUrl = `https://cardano.example/task10/${suffix}`;
    const repository = new KnowledgeRepository(owner);
    const embedder = deterministicEmbedder();
    const publicEntry: SourceRegistryEntry = {
      id: sourceId,
      owner: "Cardano Foundation",
      trustTier: "official",
      kind: "page",
      url: publicUrl,
      allowedDomains: ["cardano.example"],
      topics: ["developer"],
      networks: ["mainnet"],
      refresh: "daily",
    };
    let jobId: string | undefined;
    let stopped = false;
    try {
      await repository.ensureSource(publicEntry);
      const version = await repository.storeVersion({
        sourceId,
        canonicalUrl: publicUrl,
        title: "Task 10 public staking evidence",
        content: publicText,
        contentHash: sha256Hex(publicText),
        retrievedAt: new Date("2026-08-26T00:00:00.000Z"),
      });
      await repository.replaceChunks(version.id, [{
        ordinal: 0,
        heading: "Proof of stake",
        content: publicText,
        contentHash: sha256Hex(`Proof of stake\n${publicText}`),
        embeddingModel: "task10-embedding",
        embedding,
      }]);

      await expect(api.getFile({ file_id: markers.fileId })).resolves.toMatchObject({
        file_id: markers.fileId,
        file_unique_id: markers.fileUniqueId,
        file_path: "documents/task10-private.md",
      });
      let downloaded = "";
      await api.withDownloadedFile("documents/task10-private.md", fileBytes.byteLength, undefined, (bytes) => {
        downloaded = bytes.toString("utf8");
      });
      expect(downloaded).toBe(fileBytes.toString("utf8"));
      await expect(api.sendMessage({ chat_id: String(updateId), text: "task10 transport check", disable_web_page_preview: true })).resolves.toBeDefined();
      telegram.messages.length = 0;
      await expect(extractorClient.extract(fileBytes, { fileName: markers.fileName, mime: "text/markdown" })).resolves.toMatchObject({
        type: "markdown",
        title: markers.fileName.slice(0, -3),
        text: expect.stringContaining(extractedPhrase),
      });

      await boss.start();
      await clearPrivateJobs(boss);
      const queue = new PgBossPrivateComparisonQueue(boss, app, encryptionKey);
      const ingress = privateJob(updateId, markers);
      await expect(queue.enqueue(ingress)).resolves.toBe(true);
      await expect(queue.enqueue(ingress)).resolves.toBe(false);

      const admitted = await boss.findJobs(PRIVATE_COMPARISON_QUEUE, { key: `private:${updateId}`, queued: true });
      expect(admitted).toHaveLength(1);
      const encrypted = admitted[0]?.data as EncryptedPrivateComparisonJob;
      jobId = admitted[0]?.id;
      expect(jobId).toEqual(expect.any(String));
      expect(JSON.stringify(encrypted)).not.toContain(markers.caption);
      expect(JSON.stringify(encrypted)).not.toContain(markers.fileId);
      expect(JSON.stringify(encrypted)).not.toContain(markers.fileName);
      expect(decryptPrivateComparisonJob(encrypted, encryptionKey, {
        updateId,
        telegramUserId: String(updateId),
        telegramChatId: String(updateId),
      })).toMatchObject(markers);
      expect(() => decryptPrivateComparisonJob({ ...encrypted, telegramChatId: "9001" }, encryptionKey, {
        updateId,
        telegramUserId: String(updateId),
        telegramChatId: String(updateId),
      })).toThrow(/owner|authentication/i);
      expect(() => decryptPrivateComparisonJob(encrypted, encryptionKey, {
        updateId,
        telegramUserId: "9001",
        telegramChatId: "9001",
      })).toThrow(/owner|authentication/i);

      const evidence = await retrieveEvidence({ query: "Cardano proof of stake", language: "en", embeddingModel: "task10-embedding", cachePolicy: "stable" }, { db: app, embedder });
      expect(evidence[0]).toMatchObject({ sourceId, url: publicUrl, stale: false });

      const retrievalRequests: Array<Parameters<typeof retrieveEvidence>[0]> = [];
      const retrieve = async (
        input: Parameters<typeof retrieveEvidence>[0],
        dependencies: Parameters<typeof retrieveEvidence>[1],
      ) => {
        retrievalRequests.push(input);
        return retrieveEvidence(input, dependencies);
      };
      const completionRequests: Array<Parameters<PrivateComparisonCompletion>[0]> = [];
      const complete: PrivateComparisonCompletion = async (input) => {
        completionRequests.push(input);
        return {
          text: input.model === generationModel
            ? JSON.stringify({ language: "en", claims: [{ text: `${answerMarker}: The file's ${extractedPhrase} agrees with Cardano proof of stake.`, privateCitationIds: ["U1"], cardanoCitationIds: ["E1"], kind: "fact" }] })
            : '{"supported":[true]}',
          model: input.model,
          promptTokens: 7,
          completionTokens: 5,
        };
      };
      const processed = new Promise<void>((resolve, reject) => {
        void boss.work(PRIVATE_COMPARISON_QUEUE, async ([job]) => {
          if (!job) return;
          try {
            const data = job.data as { updateId?: unknown };
            if (data.updateId !== updateId) return;
            const outcome = await processPrivateComparisonJob(job.data, {
              api,
              encryptionKey,
              extractor: extractorClient,
              retrieve,
              db: app,
              embedder,
              embeddingModel: "task10-embedding",
              generationModel,
              verifierModel,
              complete,
              recordUsage: async (telegramUserId, usage) => {
                await app.query(
                  `INSERT INTO usage_ledger (telegram_user_id, model, prompt_tokens, completion_tokens, latency_ms)
                   VALUES ($1, $2, $3, $4, $5)`,
                  [telegramUserId, usage.model, usage.promptTokens, usage.completionTokens, usage.latencyMs],
                );
              },
              send: (chatId, text) => deliverMessage(api, { chat_id: chatId, text, disable_web_page_preview: true }, 1),
              markStatus: async (id, status) => {
                await app.query(
                  "UPDATE telegram_updates SET status = $1, processed_at = CASE WHEN $1 = 'processed' THEN now() ELSE processed_at END WHERE update_id = $2",
                  [status, id],
                );
              },
            });
            expect(outcome).toMatchObject({ delivered: true, attempts: 1 });
            resolve();
          } catch (error) {
            reject(error);
          }
        }).catch(reject);
      });
      await expect(Promise.race([processed, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("PgBoss worker timeout")), 10_000))])).resolves.toBeUndefined();
      expect(telegram.messages).toHaveLength(1);
      expect(telegram.messages[0]?.text).toContain(answerMarker);
      expect(telegram.messages[0]?.text).toContain(`[User file: ${markers.fileName.slice(0, -3)}]`);
      expect(telegram.messages[0]?.text).toContain(publicUrl);
      expect(retrievalRequests).toHaveLength(1);
      expect(retrievalRequests[0]).toMatchObject({
        query: markers.caption,
        personalized: true,
        embeddingModel: "task10-embedding",
      });
      expect(completionRequests).toHaveLength(2);
      const generationPrompt = completionRequests[0]?.messages.map((message) => message.content).join("\n") ?? "";
      expect(completionRequests[0]?.model).toBe(generationModel);
      expect(generationPrompt).toContain(markers.caption);
      expect(generationPrompt).toContain(extractedPhrase);
      expect(generationPrompt).toContain(publicUrl);
      expect(generationPrompt).toContain(publicText);
      const verificationPrompt = completionRequests[1]?.messages.map((message) => message.content).join("\n") ?? "";
      expect(completionRequests[1]?.model).toBe(verifierModel);
      expect(verificationPrompt).toContain(extractedPhrase);
      expect(verificationPrompt).toContain(publicUrl);

      await waitFor(async () => {
        await boss.supervise(PRIVATE_COMPARISON_QUEUE);
        return (await boss.findJobs(PRIVATE_COMPARISON_QUEUE, { id: jobId })).length === 0;
      });
      const update = await owner.query<{ update_id: string; status: string }>(
        "SELECT update_id::text, status FROM telegram_updates WHERE update_id = $1",
        [updateId],
      );
      expect(update.rows).toEqual([{ update_id: String(updateId), status: "processed" }]);
      await expectNoPrivateConversationState(owner, updateId, markers.caption);
      await noPrivateMarkers(owner, [markers.caption, markers.fileName, markers.fileId, markers.fileUniqueId, extractedPhrase, answerMarker]);
    } finally {
      if (!stopped) {
        stopped = true;
        await boss.stop().catch(() => undefined);
      }
      await extractor.close().catch(() => undefined);
      await telegram.close().catch(() => undefined);
      telegramFetch.restore();
      await owner.query("DELETE FROM usage_ledger WHERE telegram_user_id = $1", [String(updateId)]).catch(() => undefined);
      await owner.query("DELETE FROM retrieval_cache").catch(() => undefined);
      await owner.query("DELETE FROM telegram_updates WHERE update_id = $1", [updateId]).catch(() => undefined);
      await owner.query("DELETE FROM source_versions WHERE source_id = $1", [sourceId]).catch(() => undefined);
      await owner.query("DELETE FROM knowledge_sources WHERE id = $1", [sourceId]).catch(() => undefined);
      await app.end().catch(() => undefined);
      await owner.end().catch(() => undefined);
    }
  }, 30_000);

  it("rejects persisted ciphertext, IV, and tag tampering through the claimed production path", async () => {
    const owner = createDatabase(ownerUrl!);
    const app = createDatabase(databaseUrl!);
    const boss = appBoss(app);
    const queue = new PgBossPrivateComparisonQueue(boss, app, encryptionKey);
    const jobIds: string[] = [];
    const updateIds: number[] = [];
    const failures: string[] = [];
    const runtimeDependencies = {
      api: {
        getFile: async () => { throw new Error("Telegram must not be reached after tamper"); },
        withDownloadedFile: async () => { throw new Error("Telegram must not be reached after tamper"); },
      },
      encryptionKey,
      extractor: { extract: async () => { throw new Error("Extractor must not be reached after tamper"); } },
      retrieve: async () => [],
      db: app,
      embedder: deterministicEmbedder(),
      embeddingModel: "task10-embedding",
      generationModel,
      verifierModel,
      complete: async ({ model }: { model: string }) => ({ text: "", model, promptTokens: 0, completionTokens: 0 }),
      send: async () => ({ delivered: true, attempts: 1 }),
      log: (category: string) => failures.push(category),
    };
    try {
      await boss.start();
      await boss.createQueue(PRIVATE_COMPARISON_QUEUE, {
        retryLimit: PRIVATE_COMPARISON_RETRY_LIMIT,
        retryDelay: PRIVATE_COMPARISON_RETRY_DELAY_SECONDS,
        retryBackoff: PRIVATE_COMPARISON_RETRY_BACKOFF,
        expireInSeconds: PRIVATE_COMPARISON_EXPIRE_SECONDS,
        retentionSeconds: PRIVATE_COMPARISON_RETENTION_SECONDS,
        deleteAfterSeconds: 1,
      });
      for (const field of ["ciphertext", "iv", "tag"] as const) {
        const updateId = 8_710_000_000_000_000 + (Date.now() % 100_000) * 10 + updateIds.length;
        updateIds.push(updateId);
        const metadata = {
          caption: `TASK10_TAMPER_CAPTION_${field}_${updateId}`,
          fileId: `TASK10_TAMPER_FILE_${field}_${updateId}`,
          fileUniqueId: `TASK10_TAMPER_UNIQUE_${field}_${updateId}`,
          fileName: `TASK10_TAMPER_FILENAME_${field}_${updateId}.md`,
        };
        await expect(queue.enqueue(privateJob(updateId, metadata))).resolves.toBe(true);
        const queued = await boss.findJobs(PRIVATE_COMPARISON_QUEUE, { key: `private:${updateId}`, queued: true });
        expect(queued).toHaveLength(1);
        const jobId = queued[0]?.id;
        if (!jobId) throw new Error("Expected a persisted private job");
        jobIds.push(jobId);
        const encrypted = (queued[0]?.data as EncryptedPrivateComparisonJob).encrypted;
        const tampered = tamperBase64(encrypted[field]);
        await owner.query(
          "UPDATE pgboss.job SET data = jsonb_set(data, ARRAY['encrypted', $1::text], to_jsonb($2::text), false) WHERE id = $3",
          [field, tampered, jobId],
        );
        const claimed = await boss.fetch(PRIVATE_COMPARISON_QUEUE);
        expect(claimed).toHaveLength(1);
        const claimedData = claimed[0]?.data as EncryptedPrivateComparisonJob;
        expect(claimedData.encrypted[field]).toBe(tampered);
        await expect(processPrivateComparisonJob(claimedData, runtimeDependencies)).rejects.toThrow(/validation/i);
      }
      expect(failures).toEqual(["validation", "validation", "validation"]);
    } finally {
      if (jobIds.length > 0) {
        await owner.query("DELETE FROM pgboss.job WHERE id = ANY($1::uuid[])", [jobIds]).catch(() => undefined);
      }
      for (const updateId of updateIds) {
        await owner.query("DELETE FROM telegram_updates WHERE update_id = $1", [updateId]).catch(() => undefined);
        await owner.query(
          "DELETE FROM telegram_admission_windows WHERE (subject_type = 'user' AND subject_id = $1) OR (subject_type = 'chat' AND subject_id = $2)",
          [String(updateId), String(updateId)],
        ).catch(() => undefined);
      }
      await boss.stop().catch(() => undefined);
      await app.end().catch(() => undefined);
      await owner.end().catch(() => undefined);
    }
  }, 30_000);

  it("requeues an expired active private job with bounded retry metadata and a 1514-second lifetime", async () => {
    const owner = createDatabase(ownerUrl!);
    const app = createDatabase(databaseUrl!);
    const boss = appBoss(app);
    const updateId = 8_700_000_000_000_000 + (Date.now() % 100_000);
    const job = privateJob(updateId, {
      caption: `TASK10_RETRY_CAPTION_${updateId}`,
      fileId: `TASK10_RETRY_FILE_${updateId}`,
      fileUniqueId: `TASK10_RETRY_UNIQUE_${updateId}`,
      fileName: `TASK10_RETRY_FILENAME_${updateId}.md`,
    });
    try {
      await boss.start();
      await clearPrivateJobs(boss);
      const queue = new PgBossPrivateComparisonQueue(boss, app, encryptionKey);
      await expect(queue.enqueue(job)).resolves.toBe(true);
      const active = await boss.fetch(PRIVATE_COMPARISON_QUEUE);
      const jobId = active[0]?.id;
      if (!jobId) throw new Error("Expected an active private job");
      await owner.query("UPDATE pgboss.job SET started_on = now() - interval '1801 seconds' WHERE id = $1", [jobId]);
      await waitFor(async () => {
        await boss.supervise(PRIVATE_COMPARISON_QUEUE);
        const jobs = await boss.findJobs(PRIVATE_COMPARISON_QUEUE, { key: `private:${updateId}` });
        return jobs[0]?.state === "retry";
      });
      const retried = await boss.findJobs(PRIVATE_COMPARISON_QUEUE, { key: `private:${updateId}` });
      expect(retried).toHaveLength(1);
      expect(retried[0]).toMatchObject({
        state: "retry",
        retryLimit: PRIVATE_COMPARISON_RETRY_LIMIT,
        retryDelay: PRIVATE_COMPARISON_RETRY_DELAY_SECONDS,
        retryBackoff: PRIVATE_COMPARISON_RETRY_BACKOFF,
        expireInSeconds: PRIVATE_COMPARISON_EXPIRE_SECONDS,
        deleteAfterSeconds: 1,
      });
      const retryJob = retried[0]!;
      expect(retryJob.retryCount).toBeGreaterThanOrEqual(0);
      expect(retryJob.retryCount).toBeLessThanOrEqual(PRIVATE_COMPARISON_RETRY_LIMIT);
      expect(retryJob.keepUntil.getTime() - retryJob.createdOn.getTime()).toBeLessThanOrEqual(PRIVATE_COMPARISON_RETENTION_SECONDS * 1_000);
      expect(retryJob.startAfter.getTime() - retryJob.createdOn.getTime()).toBeLessThanOrEqual(PRIVATE_COMPARISON_MAX_LIFETIME_SECONDS * 1_000);
      expect(PRIVATE_COMPARISON_MAX_LIFETIME_SECONDS).toBe(1_514);
      expect(PRIVATE_COMPARISON_MAX_LIFETIME_SECONDS).toBeLessThan(3_600);
      await boss.deleteJob(PRIVATE_COMPARISON_QUEUE, jobId).catch(() => undefined);
      for (const remaining of await boss.findJobs(PRIVATE_COMPARISON_QUEUE, { key: `private:${updateId}` })) {
        await boss.deleteJob(PRIVATE_COMPARISON_QUEUE, remaining.id).catch(() => undefined);
      }
    } finally {
      await boss.stop().catch(() => undefined);
      await owner.query("DELETE FROM telegram_updates WHERE update_id = $1", [updateId]).catch(() => undefined);
      await app.end().catch(() => undefined);
      await owner.end().catch(() => undefined);
    }
  }, 20_000);
});
