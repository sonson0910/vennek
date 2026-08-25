import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { Server } from "node:http";
import { afterAll, describe, expect, it } from "vitest";
import type { PublicHttpsLookup, PublicHttpsRequest } from "@vennek/cardano-governance-skills";
import {
  KnowledgeRepository,
  PromotionAuditRepository,
  SearxngClient,
  createDatabase,
  promoteDiscoveredLink,
  promoteQuestionSources,
  retrieveEvidence,
  type EmbeddingProvider,
  type SourceRegistryEntry,
} from "@vennek/cardano-agent";
import {
  createKnowledgePromotionServer,
} from "../apps/telegram-bot/src/knowledgePromotionServer.js";
import { KnowledgePromotionClient } from "../apps/telegram-bot/src/knowledgePromotionClient.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const db = databaseUrl ? createDatabase(databaseUrl) : undefined;

const identity = {
  keyId: `task10-${process.pid}-${Date.now()}`.slice(0, 63),
  key: Buffer.alloc(32, 17),
} as const;

async function listenForTest(server: Server): Promise<URL> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind TCP.");
  return new URL(`http://127.0.0.1:${address.port}/`);
}

async function closeForTest(server: Server | undefined): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function vector(): number[] {
  return Array.from({ length: 1_536 }, (_, index) => index === 0 ? 1 : 0);
}

function fixtureRequest(body: string): PublicHttpsRequest {
  return ((_, callback) => {
    const response = Object.assign(Readable.from([Buffer.from(body)]), {
      statusCode: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-length": String(Buffer.byteLength(body)),
      },
    });
    callback(response as never);
    return { end() {} } as never;
  }) as PublicHttpsRequest;
}

describe.skipIf(!databaseUrl)("live knowledge promotion loopback", () => {
  it("promotes a discovered official source through the signed server and retrieves fresh evidence", async () => {
    const suffix = `${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const sourceId = `task10-fixture-${suffix}`;
    const embeddingModel = `task10-cardano-embedding-${suffix}`;
    const callerId = identity.keyId;
    const question = `task10 Cardano evidence ${suffix}`;
    const entry: SourceRegistryEntry = {
      id: sourceId,
      owner: "Cardano",
      trustTier: "official",
      kind: "page",
      url: "https://docs.cardano.org/",
      allowedDomains: ["docs.cardano.org"],
      topics: ["developer"],
      networks: ["mainnet"],
      refresh: "daily",
    };
    const registry = [entry];
    const sourceUrl = `https://docs.cardano.org/task10/${suffix}`;
    const responseBody = `<html><head><title>${question}</title></head><body><h1>${question}</h1><p>Deterministic Cardano evidence fixture.</p></body></html>`;
    const searchQueries: string[] = [];
    const search = new SearxngClient(new URL("https://search.example.test/"), async (url, init) => {
      expect(init?.method).toBe("GET");
      searchQueries.push(new URL(String(url)).searchParams.get("q") ?? "");
      return new Response(JSON.stringify({
        results: [{ title: question, content: `Search result for ${question}`, url: sourceUrl }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const embedder: EmbeddingProvider = {
      embed: async (inputs) => inputs.map((_, index) => ({ index, embedding: vector() })),
    };
    const lookup: PublicHttpsLookup = async (hostname, options) => {
      expect(hostname).toBe("docs.cardano.org");
      expect(options).toMatchObject({ all: true, order: "ipv4first", signal: expect.any(AbortSignal) });
      return [{ address: "93.184.216.34", family: 4 }];
    };
    let server: Server | undefined;
    try {
      const repository = new KnowledgeRepository(db!);
      const audit = new PromotionAuditRepository(db!);
      const promote = (promotedQuestion: string, signal: AbortSignal) => promoteQuestionSources({
        question: promotedQuestion,
        registry,
        search,
        signal,
        promote: (link, promotionSignal, deadlineAt) => promoteDiscoveredLink({
          link,
          registry,
          repository,
          embedder,
          embeddingModel,
          signal: promotionSignal,
          deadlineAt,
          lookup,
          request: fixtureRequest(responseBody),
        }),
      });
      server = createKnowledgePromotionServer({ identity, audit, promote });
      const origin = await listenForTest(server);
      const client = new KnowledgePromotionClient({ origin, identity });

      const before = await retrieveEvidence(
        { query: question, language: "en", embeddingModel },
        { db: db!, embedder },
      );
      expect(before).toEqual([]);

      await client.promote({ question, language: "en" });

      expect(searchQueries).toEqual([`${question} (site:docs.cardano.org)`]);
      const first = await retrieveEvidence(
        { query: question, language: "en", embeddingModel },
        { db: db!, embedder },
      );
      expect(first).toHaveLength(1);
      expect(first[0]).toMatchObject({
        sourceId,
        title: question,
        url: sourceUrl,
        trustTier: "official",
        stale: false,
        versionHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      const second = await retrieveEvidence(
        { query: question, language: "en", embeddingModel },
        { db: db!, embedder },
      );
      expect(second[0]?.sourceId).toBe(sourceId);
      expect(second[0]?.versionHash).toBe(first[0]?.versionHash);
      expect(second[0]?.stale).toBe(false);

      const auditRows = await db!.query<{
        request_id: string;
        state: string;
        outcome: string | null;
        promoted_count: number;
      }>(
        `SELECT request_id::text, state, outcome, promoted_count
         FROM knowledge_promotion_requests
         WHERE caller_id = $1`,
        [callerId],
      );
      expect(auditRows.rows).toHaveLength(1);
      expect(auditRows.rows[0]).toMatchObject({
        state: "succeeded",
        outcome: "promoted",
        promoted_count: 1,
      });

      const columns = await db!.query<{ column_name: string }>(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = 'knowledge_promotion_requests'
         ORDER BY ordinal_position`,
      );
      expect(columns.rows.map((row) => row.column_name)).toEqual([
        "request_id", "caller_id", "nonce_digest", "state", "outcome", "promoted_count",
        "latency_ms", "received_at", "completed_at",
      ]);
      expect(columns.rows.map((row) => row.column_name)).not.toEqual(expect.arrayContaining([
        "question", "body", "url", "content", "error",
      ]));
    } finally {
      await closeForTest(server);
      await db!.query("DELETE FROM source_versions WHERE source_id = $1", [sourceId]).catch(() => undefined);
      await db!.query("DELETE FROM knowledge_sources WHERE id = $1", [sourceId]).catch(() => undefined);
      await db!.query("DELETE FROM knowledge_promotion_requests WHERE caller_id = $1", [callerId]).catch(() => undefined);
    }
  }, 30_000);
});

afterAll(async () => {
  await db?.end();
});
