import { spawn, type ChildProcess } from "node:child_process";
import * as http from "node:http";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PgBoss } from "pg-boss";
import { createDatabase } from "@vennek/cardano-agent";
import { runMigrations } from "./migrate-agent.js";
import {
  decryptPrivateComparisonJob,
  encryptPrivateComparisonJob,
  PgBossPrivateComparisonQueue,
  PRIVATE_COMPARISON_QUEUE,
  type PrivateComparisonIngressJob,
} from "../apps/telegram-bot/dist/privateComparisonQueue.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const node = process.execPath;
const privateToken = Buffer.alloc(32, 0x41).toString("base64url");
const telegramToken = "123456:SmokeTelegramToken";
const smokeKey = Buffer.alloc(32, 0x2a);
const publicEvidence = "Cardano uses proof of stake and Ouroboros consensus.";
const vector = `[${Array.from({ length: 1_536 }, (_, index) => index === 0 ? 1 : 0).join(",")}]`;

type SmokeMessage = { chat_id: string | number; text: string };

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("smoke server did not bind"));
      resolvePort(address.port);
    });
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
}

async function body(request: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function json(response: http.ServerResponse, value: unknown, status = 200): void {
  const payload = Buffer.from(JSON.stringify(value));
  response.writeHead(status, { "content-type": "application/json", "content-length": payload.byteLength });
  response.end(payload);
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error("compiled private worker smoke timed out");
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    once(child, "exit").then(() => undefined),
    new Promise<void>((resolveExit) => setTimeout(resolveExit, 3_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

function spawnService(entrypoint: string, env: NodeJS.ProcessEnv, args: readonly string[] = []): ChildProcess {
  const child = spawn(node, [entrypoint, ...args], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stderr?.on("data", (chunk) => process.stderr.write(`[smoke ${entrypoint}] ${String(chunk)}`));
  child.stdout?.on("data", (chunk) => process.stdout.write(`[smoke ${entrypoint}] ${String(chunk)}`));
  return child;
}

async function startTelegramHarness(files: Map<string, Buffer>): Promise<{ server: http.Server; port: number; messages: SmokeMessage[] }> {
  const messages: SmokeMessage[] = [];
  const server = http.createServer(async (request, response) => {
    if (request.method === "POST" && request.url === `/bot${telegramToken}/getFile`) {
      const value = JSON.parse((await body(request)).toString("utf8")) as { file_id?: string };
      const file = files.get(value.file_id ?? "");
      if (!file) return json(response, { ok: false, error_code: 404, description: "file not found" }, 404);
      return json(response, { ok: true, result: { file_id: value.file_id, file_unique_id: `unique-${value.file_id}`, file_size: file.byteLength, file_path: `documents/${value.file_id}.txt` } });
    }
    if (request.method === "POST" && request.url === `/bot${telegramToken}/sendMessage`) {
      const value = JSON.parse((await body(request)).toString("utf8")) as SmokeMessage;
      messages.push(value);
      return json(response, { ok: true, result: { message_id: messages.length } });
    }
    if (request.method === "GET" && request.url?.startsWith(`/file/bot${telegramToken}/documents/`)) {
      const fileId = request.url.slice(`/file/bot${telegramToken}/documents/`.length).replace(/\.txt$/u, "");
      const file = files.get(fileId);
      if (!file) {
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "text/plain", "content-length": file.byteLength });
      response.end(file);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  return { server, port: await listen(server), messages };
}

async function startLiteLlm(): Promise<{ server: http.Server; port: number; setFailNext(): void; qualityCalls: () => number }> {
  let failNext = false;
  let qualityCalls = 0;
  const server = http.createServer(async (request, response) => {
    const value = JSON.parse((await body(request)).toString("utf8")) as { model?: string };
    if (request.url === "/v1/embeddings") {
      return json(response, { data: [{ index: 0, embedding: Array.from({ length: 1_536 }, (_, index) => index === 0 ? 1 : 0) }] });
    }
    if (request.url === "/v1/chat/completions") {
      const model = value.model ?? "";
      if (model === "cardano-private-quality") {
        qualityCalls += 1;
        if (failNext) {
          failNext = false;
          return json(response, { error: "smoke transient provider failure" }, 503);
        }
      }
      const content = model === "cardano-private-verifier"
        ? JSON.stringify({ supported: [true] })
        : JSON.stringify({ language: "en", claims: [{ text: publicEvidence, privateCitationIds: ["U1"], cardanoCitationIds: ["E1"], kind: "fact" }] });
      return json(response, {
        model,
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });
    }
    response.writeHead(404);
    response.end();
  });
  return { server, port: await listen(server), setFailNext: () => { failNext = true; }, qualityCalls: () => qualityCalls };
}

async function seedEvidence(db: ReturnType<typeof createDatabase>, suffix: string): Promise<{ sourceId: string; versionId: string }> {
  const sourceId = `compiled-smoke-${suffix}`;
  const source = {
    id: sourceId,
    owner: "Cardano Foundation",
    trustTier: "official",
    kind: "page",
    url: `https://docs.cardano.org/${sourceId}`,
    allowedDomains: ["docs.cardano.org"],
    topics: ["consensus", "staking"],
    networks: ["mainnet"],
    refresh: "daily",
  };
  const contentHash = createHash("sha256").update(publicEvidence).digest("hex");
  await db.query("INSERT INTO knowledge_sources (id, owner, trust_tier, registry) VALUES ($1, $2, $3, $4::jsonb)", [sourceId, source.owner, source.trustTier, JSON.stringify(source)]);
  const version = await db.query<{ id: string }>(
    "INSERT INTO source_versions (source_id, canonical_url, title, content, content_hash, retrieved_at) VALUES ($1, $2, $3, $4, $5, now()) RETURNING id::text",
    [sourceId, source.url, "Cardano consensus smoke evidence", publicEvidence, contentHash],
  );
  const versionId = version.rows[0]?.id;
  assert(versionId, "smoke evidence version was not created");
  const chunkHash = createHash("sha256").update(`${source.url}\n${publicEvidence}`).digest("hex");
  await db.query(
    "INSERT INTO knowledge_chunks (version_id, ordinal, heading, content, content_hash, embedding_model, embedding) VALUES ($1, 0, $2, $3, $4, $5, $6::vector)",
    [versionId, "Cardano consensus", publicEvidence, chunkHash, "cardano-embedding", vector],
  );
  return { sourceId, versionId };
}

async function waitForUpdate(db: ReturnType<typeof createDatabase>, updateId: number): Promise<void> {
  await waitFor(async () => {
    const result = await db.query<{ status: string }>("SELECT status FROM telegram_updates WHERE update_id = $1", [updateId]);
    return result.rows[0]?.status === "processed";
  });
}

async function main(): Promise<void> {
  const databaseUrl = process.env.SMOKE_DATABASE_URL?.trim() || process.env.TEST_DATABASE_URL?.trim();
  const ownerUrl = process.env.SMOKE_DATABASE_OWNER_URL?.trim() || process.env.TEST_DATABASE_OWNER_URL?.trim();
  if (!databaseUrl || !ownerUrl) {
    console.log("compiled private worker smoke skipped: SMOKE_DATABASE_URL and SMOKE_DATABASE_OWNER_URL are required");
    return;
  }

  process.env.DATABASE_OWNER_URL = ownerUrl;
  console.log("compiled private worker smoke: migrate");
  await runMigrations();
  const db = createDatabase(databaseUrl);
  const boss = new PgBoss({ db: { executeSql: (text, values) => db.query(text, values) }, migrate: false, createSchema: false, maintenanceIntervalSeconds: 1, superviseIntervalSeconds: 1 });
  const suffix = `${process.pid}-${Date.now()}`;
  const updateBase = 8_800_000_000_000_000 + (Date.now() % 1_000_000_000) * 1_000 + (process.pid % 1_000);
  assert(Number.isSafeInteger(updateBase + 4), "smoke update id is not a safe integer");
  const smokeOwner = String(updateBase);
  const evidence = await seedEvidence(db, suffix);
  console.log("compiled private worker smoke: local services");
  const files = new Map<string, Buffer>([
    ["safe", Buffer.from(`Cardano private smoke ${suffix}`)],
    ["spoofed", Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n")],
    ["retry", Buffer.from(`Cardano private retry smoke ${suffix}`)],
  ]);
  const telegram = await startTelegramHarness(files);
  const litellm = await startLiteLlm();
  const extractorPortServer = http.createServer();
  const extractorPort = await listen(extractorPortServer);
  await close(extractorPortServer);
  const extractor = spawnService("packages/cardano-agent/dist/privateComparison/privateDocumentServer.js", {
    ...process.env,
    PRIVATE_DOCUMENT_EXTRACTOR_TOKEN: privateToken,
    PRIVATE_DOCUMENT_EXTRACTOR_PORT: String(extractorPort),
  });
  console.log("compiled private worker smoke: extractor starting");
  await waitFor(async () => {
    try { return (await fetch(`http://127.0.0.1:${extractorPort}/health`)).status === 200; } catch { return false; }
  }, 5_000);
  const hook = resolve(root, "scripts/compiled-worker-network-hook.mjs");
  const worker = spawnService("apps/telegram-bot/dist/main.js", {
    ...process.env,
    DATABASE_URL: databaseUrl,
    VENNEK_ENCRYPTION_KEY: smokeKey.toString("base64"),
    LITELLM_BASE_URL: `http://127.0.0.1:${litellm.port}`,
    LITELLM_API_KEY: "smoke-key",
    VENNEK_MODEL_FAST: "cardano-fast",
    VENNEK_MODEL_QUALITY: "cardano-quality",
    VENNEK_MODEL_VERIFIER: "cardano-verifier",
    VENNEK_EMBEDDING_MODEL: "cardano-embedding",
    TELEGRAM_BOT_TOKEN: telegramToken,
    PRIVATE_DOCUMENT_EXTRACTOR_URL: "http://private-document-extractor:8083",
    PRIVATE_DOCUMENT_EXTRACTOR_TOKEN: privateToken,
    VENNEK_PRIVATE_MODEL_QUALITY: "cardano-private-quality",
    VENNEK_PRIVATE_MODEL_VERIFIER: "cardano-private-verifier",
    KNOWLEDGE_PROMOTION_URL: "http://127.0.0.1:9",
    KNOWLEDGE_PROMOTION_KEY_ID: "compiled-smoke",
    KNOWLEDGE_PROMOTION_KEY: Buffer.alloc(32, 0x31).toString("base64"),
    VENNEK_SMOKE_TELEGRAM_PORT: String(telegram.port),
    VENNEK_SMOKE_EXTRACTOR_PORT: String(extractorPort),
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${hook}`.trim(),
  }, ["--worker"]);
  console.log("compiled private worker smoke: worker starting");

  const queue = new PgBossPrivateComparisonQueue(boss, db, smokeKey);
  try {
    await boss.start();
    await boss.createQueue(PRIVATE_COMPARISON_QUEUE, { policy: "standard", retryLimit: 3, retryDelay: 1, retryBackoff: true, expireInSeconds: 300, retentionSeconds: 300, deleteAfterSeconds: 1 });
    const base = (updateId: number, fileId: string, caption = "Compare this Cardano consensus claim") => ({
      kind: "private-compare" as const,
      updateId,
      telegramUserId: smokeOwner,
      telegramChatId: smokeOwner,
      metadata: { caption, fileId, fileUniqueId: `unique-${fileId}`, fileName: "claim.txt", mime: "text/plain", fileSize: files.get(fileId)!.byteLength },
    });
    assert(await queue.enqueue(base(updateBase + 1, "safe")), "safe smoke job was not admitted");
    console.log("compiled private worker smoke: safe job");
    await waitForUpdate(db, updateBase + 1);
    assert(telegram.messages.length >= 1 && telegram.messages.at(-1)!.text.includes("Cardano uses proof of stake"), "safe compiled worker delivery failed");

    assert(await queue.enqueue(base(updateBase + 2, "spoofed")), "spoof smoke job was not admitted");
    console.log("compiled private worker smoke: terminal job");
    await waitForUpdate(db, updateBase + 2);
    assert(telegram.messages.length >= 2 && /sorry|xin lỗi|lo siento/i.test(telegram.messages.at(-1)!.text), "deterministic terminal rejection was not localized and delivered once");

    litellm.setFailNext();
    const qualityBeforeRetry = litellm.qualityCalls();
    assert(await queue.enqueue(base(updateBase + 3, "retry")), "retry smoke job was not admitted");
    console.log("compiled private worker smoke: retry job");
    await waitForUpdate(db, updateBase + 3);
    assert(litellm.qualityCalls() >= qualityBeforeRetry + 2, "transient provider failure did not retry the compiled worker job");
    assert(telegram.messages.length === 3, "retry smoke job delivered more than once");

    const tamperInput: PrivateComparisonIngressJob = base(updateBase + 4, "safe");
    const encrypted = encryptPrivateComparisonJob(tamperInput, smokeKey);
    const tampered = { ...encrypted, encrypted: { ...encrypted.encrypted, ciphertext: `${encrypted.encrypted.ciphertext.slice(0, -1)}${encrypted.encrypted.ciphertext.endsWith("A") ? "B" : "A"}` } };
    let tamperRejected = false;
    try { decryptPrivateComparisonJob(tampered, smokeKey, { updateId: tamperInput.updateId, telegramUserId: tamperInput.telegramUserId, telegramChatId: tamperInput.telegramChatId }); } catch { tamperRejected = true; }
    assert(tamperRejected, "tampered queue envelope was accepted by compiled crypto path");

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_500));
    const marker = `%${suffix}%`;
    for (const [schema, table] of [["public", "telegram_updates"], ["pgboss", "job"], ["pgboss", "job_common"]] as const) {
      const result = await db.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${schema}.${table} AS surface WHERE to_jsonb(surface)::text LIKE $1`, [marker]);
      assert(result.rows[0]?.count === "0", `private marker retained in ${schema}.${table}`);
    }
    console.log("compiled private worker smoke passed: delivery, terminal reject, retry, tamper rejection, zero marker retention");
  } finally {
    worker.kill("SIGTERM");
    await waitForExit(worker);
    extractor.kill("SIGTERM");
    await waitForExit(extractor);
    await close(telegram.server).catch(() => undefined);
    await close(litellm.server).catch(() => undefined);
    await boss.stop().catch(() => undefined);
    await db.query("DELETE FROM pgboss.job WHERE (data->>'updateId')::numeric BETWEEN $1 AND $2", [updateBase + 1, updateBase + 4]).catch(() => undefined);
    await db.query("DELETE FROM usage_ledger WHERE telegram_user_id = $1", [smokeOwner]).catch(() => undefined);
    await db.query("DELETE FROM retrieval_cache WHERE query_hash = $1", [createHash("sha256").update("Compare this Cardano consensus claim").digest("hex")]).catch(() => undefined);
    await db.query("DELETE FROM telegram_updates WHERE update_id BETWEEN $1 AND $2", [updateBase + 1, updateBase + 4]).catch(() => undefined);
    await db.query("DELETE FROM telegram_admission_windows WHERE subject_id = $1 AND subject_type IN ('user', 'chat')", [smokeOwner]).catch(() => undefined);
    await db.query("DELETE FROM knowledge_sources WHERE id = $1", [evidence.sourceId]).catch(() => undefined);
    await db.end().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
