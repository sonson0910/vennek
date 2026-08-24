import { describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import type { Pool as PoolType } from "pg";
import { sha256Hex } from "@vennek/shared";
import { createRetrievalCacheKey, deleteStaleRetrievalCache, writeRetrievalCache } from "../packages/cardano-agent/src/knowledge/retrievalCache.js";
import {
  KnowledgeRepository,
  createDatabase,
  retrieveEvidence,
  type EmbeddingProvider,
  type SourceRegistryEntry,
} from "@vennek/cardano-agent";

const databaseUrl = process.env.TEST_DATABASE_URL;
const embeddingModel = "test-retrieval-model";
const now = new Date("2026-08-25T00:00:00.000Z");

function vector(value = 0): number[] {
  return Array.from({ length: 1_536 }, () => value);
}

function directionalVector(first: boolean): number[] {
  const result = vector(0);
  result[first ? 0 : 1] = 1;
  return result;
}

function source(id: string, trustTier: SourceRegistryEntry["trustTier"], topics: string[], networks: SourceRegistryEntry["networks"] = ["mainnet"], kind: "page" | "sitemap" = "page"): SourceRegistryEntry {
  return {
    id,
    owner: trustTier === "official" ? "Cardano" : "Community",
    trustTier,
    kind,
    url: "https://" + id + ".example.com/docs",
    allowedDomains: [id + ".example.com"],
    topics,
    networks,
    refresh: "daily",
  };
}

async function seedSource(db: PoolType, entry: SourceRegistryEntry): Promise<void> {
  await db.query(
    "INSERT INTO knowledge_sources (id, owner, trust_tier, registry) VALUES ($1, $2, $3, $4::jsonb)",
    [entry.id, entry.owner, entry.trustTier, JSON.stringify(entry)],
  );
}

async function removeSources(db: PoolType, ids: string[]): Promise<void> {
  await db.query("DELETE FROM source_versions WHERE source_id = ANY($1::text[])", [ids]);
  await db.query("DELETE FROM knowledge_sources WHERE id = ANY($1::text[])", [ids]);
}

async function removeCacheForQueries(db: PoolType, queries: string[], language = "en"): Promise<void> {
  await db.query(
    "DELETE FROM retrieval_cache WHERE query_hash = ANY($1::text[]) AND language = $2 AND embedding_model = $3",
    [queries.map((query) => sha256Hex(query.normalize("NFC").trim())), language, embeddingModel],
  );
}

async function seedVersion(repository: KnowledgeRepository, sourceId: string, canonicalUrl: string, title: string, content: string, retrievedAt: Date): Promise<string> {
  const version = await repository.storeVersion({
    sourceId,
    canonicalUrl,
    title,
    content,
    contentHash: sha256Hex(content),
    retrievedAt,
  });
  await repository.replaceChunks(version.id, [{
    ordinal: 0,
    heading: title,
    content,
    contentHash: sha256Hex(title + "\n" + content),
    embeddingModel,
    embedding: directionalVector(true),
  }]);
  return version.id;
}

async function seedChunks(repository: KnowledgeRepository, sourceId: string, canonicalUrl: string, title: string, contents: string[], retrievedAt: Date): Promise<string> {
  const version = await repository.storeVersion({
    sourceId,
    canonicalUrl,
    title,
    content: contents.join("\n"),
    contentHash: sha256Hex(contents.join("\n")),
    retrievedAt,
  });
  await repository.replaceChunks(version.id, contents.map((content, ordinal) => ({
    ordinal,
    heading: title + " " + String(ordinal),
    content,
    contentHash: sha256Hex(title + " " + String(ordinal) + "\n" + content),
    embeddingModel,
    embedding: directionalVector(ordinal < 40),
  })));
  return version.id;
}

function provider(): EmbeddingProvider & { embed: ReturnType<typeof vi.fn> } {
  return {
    embed: vi.fn(async (inputs: string[]) => inputs.map((_, index) => ({ index, embedding: directionalVector(true) }))),
  };
}

function input(query: string, overrides: Record<string, unknown> = {}) {
  return { query, language: "en", embeddingModel, now, ...overrides };
}

describe.skipIf(!databaseUrl)("retrieveEvidence", () => {
  it("ranks official lexical evidence ahead of community vector-only evidence with provenance", async () => {
    const db = createDatabase(databaseUrl!);
    const repository = new KnowledgeRepository(db);
    const suffix = String(process.pid) + "-" + String(Date.now());
    const official = source("retrieve-official-" + suffix, "official", ["developer"]);
    const community = source("retrieve-community-" + suffix, "community", ["developer"]);
    const embedder = provider();
    try {
      await seedSource(db, official);
      await seedSource(db, community);
      await seedVersion(repository, official.id, official.url + "/governance", "Official governance", "Cardano governance is documented here.", new Date(now.getTime() - 60 * 60 * 1_000));
      await seedVersion(repository, community.id, community.url + "/misc", "Community note", "An unrelated community note.", new Date(now.getTime() - 60 * 60 * 1_000));
      const evidence = await retrieveEvidence(input("governance"), { db, embedder });
      expect(evidence.length).toBeGreaterThan(0);
      expect(evidence[0]).toMatchObject({
        sourceId: official.id,
        trustTier: "official",
        title: "Official governance",
        url: official.url + "/governance",
        versionHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        retrievedAt: "2026-08-24T23:00:00.000Z",
        stale: false,
      });
      expect(evidence[0]?.score).toEqual(expect.any(Number));
      expect(evidence.every((item) => item.id && item.excerpt.length <= 1_000)).toBe(true);
    } finally {
      await removeSources(db, [official.id, community.id]).catch(() => undefined);
      await db.end();
    }
  });

  it("applies topic and network overlap filters", async () => {
    const db = createDatabase(databaseUrl!);
    const repository = new KnowledgeRepository(db);
    const suffix = String(process.pid) + "-" + String(Date.now());
    const governance = source("retrieve-topic-" + suffix, "official", ["governance"], ["mainnet"]);
    const release = source("retrieve-release-" + suffix, "official", ["releases"], ["preprod"]);
    const embedder = provider();
    try {
      await seedSource(db, governance);
      await seedSource(db, release);
      await seedVersion(repository, governance.id, governance.url + "/governance", "Governance", "Cardano protocol information.", now);
      await seedVersion(repository, release.id, release.url + "/release", "Release", "Cardano protocol information.", now);
      const topicEvidence = await retrieveEvidence(input("Cardano protocol", { topics: [" GOVERNANCE "] }), { db, embedder });
      expect(topicEvidence.every((item) => item.sourceId === governance.id)).toBe(true);
      const networkEvidence = await retrieveEvidence(input("Cardano protocol", { networks: ["preprod"] }), { db, embedder });
      expect(networkEvidence.every((item) => item.sourceId === release.id)).toBe(true);
    } finally {
      await removeSources(db, [governance.id, release.id]).catch(() => undefined);
      await db.end();
    }
  });

  it("marks exact freshness boundaries stale for stable and volatile sources", async () => {
    const db = createDatabase(databaseUrl!);
    const repository = new KnowledgeRepository(db);
    const suffix = String(process.pid) + "-" + String(Date.now());
    const stable = source("retrieve-stable-" + suffix, "official", ["developer"]);
    const volatile = source("retrieve-volatile-" + suffix, "official", ["governance"]);
    const embedder = provider();
    try {
      await seedSource(db, stable);
      await seedSource(db, volatile);
      await seedVersion(repository, stable.id, stable.url + "/stable", "Stable", "documentation stable", new Date(now.getTime() - 48 * 60 * 60 * 1_000));
      await seedVersion(repository, volatile.id, volatile.url + "/volatile", "Governance", "governance current", new Date(now.getTime() - 2 * 60 * 60 * 1_000));
      const stableEvidence = await retrieveEvidence(input("documentation"), { db, embedder });
      expect(stableEvidence.find((item) => item.sourceId === stable.id)?.stale).toBe(false);
      const volatileEvidence = await retrieveEvidence(input("governance"), { db, embedder });
      expect(volatileEvidence.find((item) => item.sourceId === volatile.id)?.stale).toBe(false);
      await db.query("UPDATE source_versions SET retrieved_at = $1 WHERE canonical_url = $2", [new Date(now.getTime() - 48 * 60 * 60 * 1_000 - 1), stable.url + "/stable"]);
      await db.query("UPDATE source_versions SET retrieved_at = $1 WHERE canonical_url = $2", [new Date(now.getTime() - 2 * 60 * 60 * 1_000 - 1), volatile.url + "/volatile"]);
      const staleStable = await retrieveEvidence(input("documentation"), { db, embedder });
      expect(staleStable.find((item) => item.sourceId === stable.id)?.stale).toBe(true);
      const staleVolatile = await retrieveEvidence(input("governance"), { db, embedder });
      expect(staleVolatile.find((item) => item.sourceId === volatile.id)?.stale).toBe(true);
    } finally {
      await removeSources(db, [stable.id, volatile.id]).catch(() => undefined);
      await db.end();
    }
  });

  it("reuses stable cache and invalidates only indexed versions", async () => {
    const db = createDatabase(databaseUrl!);
    const repository = new KnowledgeRepository(db);
    const suffix = String(process.pid) + "-" + String(Date.now());
    const entry = source("retrieve-cache-" + suffix, "official", ["developer"]);
    const embedder = provider();
    const options = input("stable documentation " + suffix, { cachePolicy: "stable" });
    try {
      await seedSource(db, entry);
      await seedVersion(repository, entry.id, entry.url + "/stable", "Stable", options.query, now);
      const first = await retrieveEvidence(options, { db, embedder });
      const beforeSecond = await db.query<{ revision: string; source_version_fingerprint: string | null }>(
        "SELECT (SELECT revision::text FROM knowledge_revision WHERE id = true) AS revision, (SELECT source_version_fingerprint FROM retrieval_cache WHERE query_hash = $1 AND language = 'en' AND embedding_model = $2) AS source_version_fingerprint",
        [sha256Hex(options.query), embeddingModel],
      );
      const second = await retrieveEvidence(options, { db, embedder });
      const secondCacheValid = beforeSecond.rows[0]?.source_version_fingerprint === sha256Hex(beforeSecond.rows[0]?.revision ?? "");
      expect(embedder.embed).toHaveBeenCalledTimes(secondCacheValid ? 1 : 2);
      expect(second).toEqual(first);
      await repository.storeVersion({
        sourceId: entry.id,
        canonicalUrl: entry.url + "/stable",
        title: "Unindexed",
        content: "new unindexed documentation",
        contentHash: sha256Hex("new unindexed documentation"),
        retrievedAt: new Date(now.getTime() + 1_000),
      });
      const beforeUnindexed = await db.query<{ revision: string; source_version_fingerprint: string | null }>(
        "SELECT (SELECT revision::text FROM knowledge_revision WHERE id = true) AS revision, (SELECT source_version_fingerprint FROM retrieval_cache WHERE query_hash = $1 AND language = 'en' AND embedding_model = $2) AS source_version_fingerprint",
        [sha256Hex(options.query), embeddingModel],
      );
      const callsBeforeUnindexed = embedder.embed.mock.calls.length;
      await expect(retrieveEvidence(options, { db, embedder })).resolves.toEqual(first);
      const unindexedCacheValid = beforeUnindexed.rows[0]?.source_version_fingerprint === sha256Hex(beforeUnindexed.rows[0]?.revision ?? "");
      expect(embedder.embed).toHaveBeenCalledTimes(callsBeforeUnindexed + (unindexedCacheValid ? 0 : 1));
      await seedVersion(repository, entry.id, entry.url + "/stable", "Indexed new", "new indexed documentation", new Date(now.getTime() + 2_000));
      const beforeIndexed = await db.query<{ revision: string; source_version_fingerprint: string | null }>(
        "SELECT (SELECT revision::text FROM knowledge_revision WHERE id = true) AS revision, (SELECT source_version_fingerprint FROM retrieval_cache WHERE query_hash = $1 AND language = 'en' AND embedding_model = $2) AS source_version_fingerprint",
        [sha256Hex(options.query), embeddingModel],
      );
      const callsBeforeIndexed = embedder.embed.mock.calls.length;
      const third = await retrieveEvidence(options, { db, embedder });
      const indexedCacheValid = beforeIndexed.rows[0]?.source_version_fingerprint === sha256Hex(beforeIndexed.rows[0]?.revision ?? "");
      expect(embedder.embed).toHaveBeenCalledTimes(indexedCacheValid ? callsBeforeIndexed : callsBeforeIndexed + 1);
      expect(third[0]?.title).toBe("Indexed new");
    } finally {
      await removeCacheForQueries(db, [options.query]).catch(() => undefined);
      await removeSources(db, [entry.id]).catch(() => undefined);
      await db.end();
    }
  });

  it("invalidates cached evidence when source trust or freshness metadata changes", async () => {
    const db = createDatabase(databaseUrl!);
    const repository = new KnowledgeRepository(db);
    const suffix = String(process.pid) + "-" + String(Date.now());
    const entry = source("retrieve-metadata-cache-" + suffix, "official", ["developer"]);
    const embedder = provider();
    const request = input("metadata stability " + suffix, { cachePolicy: "stable" });
    try {
      await seedSource(db, entry);
      await seedVersion(repository, entry.id, entry.url + "/stable", "Stable", request.query, now);
      const first = await retrieveEvidence(request, { db, embedder });
      expect(first[0]?.trustTier).toBe("official");
      await repository.ensureSource({ ...entry, owner: "Community", trustTier: "community", topics: ["governance"] });
      const second = await retrieveEvidence(request, { db, embedder });
      expect(embedder.embed).toHaveBeenCalledTimes(2);
      expect(second[0]?.trustTier).toBe("community");
      expect(second[0]?.score).toBeLessThan(first[0]?.score ?? Number.POSITIVE_INFINITY);
      await db.query("UPDATE source_versions SET retrieved_at = $1 WHERE source_id = $2", [new Date(now.getTime() - 3 * 60 * 60 * 1_000), entry.id]);
      const third = await retrieveEvidence(request, { db, embedder });
      expect(embedder.embed).toHaveBeenCalledTimes(3);
      expect(third[0]?.stale).toBe(true);
      const cache = await db.query("SELECT count(*)::text AS count FROM retrieval_cache WHERE query_hash = $1", [sha256Hex(request.query)]);
      expect(cache.rows[0]?.count).toBe("0");
    } finally {
      await removeCacheForQueries(db, [request.query]).catch(() => undefined);
      await removeSources(db, [entry.id]).catch(() => undefined);
      await db.end();
    }
  });

  it("skips a cache write when indexing changes the version set after retrieval", async () => {
    const db = createDatabase(databaseUrl!);
    const repository = new KnowledgeRepository(db);
    const suffix = String(process.pid) + "-" + String(Date.now());
    const entry = source("retrieve-write-race-" + suffix, "official", ["developer"]);
    const embedder = provider();
    const request = input("write race " + suffix, { cachePolicy: "stable" });
    const key = createRetrievalCacheKey(request.query, request.language, request.embeddingModel, {});
    try {
      await seedSource(db, entry);
      const canonicalUrl = entry.url + "/stable";
      await seedVersion(repository, entry.id, canonicalUrl, "Old", request.query, now);
      await retrieveEvidence(request, { db, embedder });
      const cached = await db.query<{ source_version_fingerprint: string; chunk_ids: string[]; scores: number[] }>(
        "SELECT source_version_fingerprint, chunk_ids, scores FROM retrieval_cache WHERE query_hash = $1",
        [sha256Hex(request.query)],
      );
      const oldRow = cached.rows[0];
      expect(oldRow).toBeDefined();
      await seedVersion(repository, entry.id, canonicalUrl, "New", request.query + " newer", new Date(now.getTime() + 1_000));
      const wrote = await writeRetrievalCache(db, key, oldRow!.source_version_fingerprint, {
        chunkIds: oldRow!.chunk_ids,
        scores: oldRow!.scores,
      }, now, { timeoutMs: 2_000 });
      expect(wrote).toBe(false);
      const after = await db.query<{ source_version_fingerprint: string }>("SELECT source_version_fingerprint FROM retrieval_cache WHERE query_hash = $1", [sha256Hex(request.query)]);
      expect(after.rows[0]?.source_version_fingerprint).toBe(oldRow!.source_version_fingerprint);
    } finally {
      await removeCacheForQueries(db, [request.query]).catch(() => undefined);
      await removeSources(db, [entry.id]).catch(() => undefined);
      await db.end();
    }
  });

  it("allows concurrent same-key stable cache misses to complete", async () => {
    const db = createDatabase(databaseUrl!);
    const repository = new KnowledgeRepository(db);
    const suffix = String(process.pid) + "-" + String(Date.now());
    const entry = source("retrieve-concurrent-cache-" + suffix, "official", ["developer"]);
    const request = input("reference stable " + suffix, { cachePolicy: "stable" });
    try {
      await seedSource(db, entry);
      await seedVersion(repository, entry.id, entry.url + "/stable", "Stable", request.query, now);
      const results = await Promise.all([
        retrieveEvidence(request, { db, embedder: provider() }),
        retrieveEvidence(request, { db, embedder: provider() }),
      ]);
      expect(results[0]).toEqual(results[1]);
      expect(results[0]).toHaveLength(1);
    } finally {
      await removeCacheForQueries(db, [request.query]).catch(() => undefined);
      await removeSources(db, [entry.id]).catch(() => undefined);
      await db.end();
    }
  });

  it("refreshes one stale cache row safely under concurrent misses", async () => {
    const db = createDatabase(databaseUrl!);
    const repository = new KnowledgeRepository(db);
    const suffix = String(process.pid) + "-" + String(Date.now());
    const entry = source("retrieve-stale-cache-" + suffix, "official", ["developer"]);
    const request = input("stale refresh " + suffix, { cachePolicy: "stable" });
    try {
      await seedSource(db, entry);
      await seedVersion(repository, entry.id, entry.url + "/stable", "Stable", request.query, now);
      await retrieveEvidence(request, { db, embedder: provider() });
      await db.query("UPDATE retrieval_cache SET expires_at = $1 WHERE query_hash = $2", [new Date(now.getTime() - 1), sha256Hex(request.query)]);
      await repository.ensureSource({ ...entry, topics: ["governance"] });
      const refreshed = await Promise.all([
        retrieveEvidence(request, { db, embedder: provider() }),
        retrieveEvidence(request, { db, embedder: provider() }),
      ]);
      expect(refreshed[0]).toEqual(refreshed[1]);
      expect(refreshed[0]).toHaveLength(1);
      const cache = await db.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM retrieval_cache WHERE query_hash = $1 AND language = 'en' AND embedding_model = $2",
        [sha256Hex(request.query), embeddingModel],
      );
      expect(cache.rows[0]?.count).toBe("0");
    } finally {
      await removeCacheForQueries(db, [request.query]).catch(() => undefined);
      await removeSources(db, [entry.id]).catch(() => undefined);
      await db.end();
    }
  });

  it("treats malformed cache rows as misses without mutating the snapshot transaction", async () => {
    const db = createDatabase(databaseUrl!);
    const repository = new KnowledgeRepository(db);
    const suffix = String(process.pid) + "-" + String(Date.now());
    const entry = source("retrieve-malformed-cache-" + suffix, "official", ["developer"]);
    const request = input("malformed cache " + suffix, { cachePolicy: "stable" });
    try {
      await seedSource(db, entry);
      await seedVersion(repository, entry.id, entry.url + "/stable", "Stable", request.query, now);
      await retrieveEvidence(request, { db, embedder: provider() });
      await db.query("UPDATE retrieval_cache SET chunk_ids = '[\"not-a-chunk\"]'::jsonb WHERE query_hash = $1", [sha256Hex(request.query)]);
      const embedder = provider();
      const evidence = await retrieveEvidence(request, { db, embedder });
      expect(evidence).toHaveLength(1);
      expect(embedder.embed).toHaveBeenCalledOnce();
      const malformed = await db.query("SELECT chunk_ids FROM retrieval_cache WHERE query_hash = $1", [sha256Hex(request.query)]);
      expect(malformed.rows[0]?.chunk_ids).not.toEqual(["not-a-chunk"]);
    } finally {
      await removeCacheForQueries(db, [request.query]).catch(() => undefined);
      await removeSources(db, [entry.id]).catch(() => undefined);
      await db.end();
    }
  });

  it("does not delete a cache row refreshed after stale observation", async () => {
    const db = createDatabase(databaseUrl!);
    const repository = new KnowledgeRepository(db);
    const suffix = String(process.pid) + "-" + String(Date.now());
    const entry = source("retrieve-stale-race-" + suffix, "official", ["developer"]);
    const request = input("stale race " + suffix, { cachePolicy: "stable" });
    const key = createRetrievalCacheKey(request.query, request.language, request.embeddingModel, {});
    try {
      await seedSource(db, entry);
      await seedVersion(repository, entry.id, entry.url + "/stable", "Stable", request.query, now);
      await retrieveEvidence(request, { db, embedder: provider() });
      const oldRow = await db.query<{ source_version_fingerprint: string; chunk_ids: string[]; scores: number[] }>(
        "SELECT source_version_fingerprint, chunk_ids, scores FROM retrieval_cache WHERE query_hash = $1",
        [sha256Hex(request.query)],
      );
      const oldFingerprint = oldRow.rows[0]!.source_version_fingerprint;
      await db.query("UPDATE knowledge_revision SET revision = revision + 1 WHERE id = true");
      const revision = await db.query<{ revision: string }>("SELECT revision::text AS revision FROM knowledge_revision WHERE id = true");
      const currentFingerprint = sha256Hex(revision.rows[0]!.revision);
      await expect(writeRetrievalCache(db, key, currentFingerprint, {
        chunkIds: oldRow.rows[0]!.chunk_ids,
        scores: oldRow.rows[0]!.scores,
      }, now, { timeoutMs: 2_000 })).resolves.toBe(true);
      await deleteStaleRetrievalCache(db, key, oldFingerprint, { timeoutMs: 2_000 });
      const current = await db.query<{ source_version_fingerprint: string }>("SELECT source_version_fingerprint FROM retrieval_cache WHERE query_hash = $1", [sha256Hex(request.query)]);
      expect(current.rows[0]?.source_version_fingerprint).toBe(currentFingerprint);
    } finally {
      await removeCacheForQueries(db, [request.query]).catch(() => undefined);
      await removeSources(db, [entry.id]).catch(() => undefined);
      await db.end();
    }
  });

  it("reuses explicitly stable cache for a non-English language", async () => {
    const db = createDatabase(databaseUrl!);
    const repository = new KnowledgeRepository(db);
    const suffix = String(process.pid) + "-" + String(Date.now());
    const entry = source("retrieve-vietnamese-" + suffix, "official", ["developer"]);
    const embedder = provider();
    const request = input("tài liệu ổn định " + suffix, { language: "vi", cachePolicy: "stable" });
    const uncategorized = input("mới nhất tài liệu " + suffix, { language: "vi", cachePolicy: "stable" });
    try {
      await seedSource(db, entry);
      await seedVersion(repository, entry.id, entry.url + "/stable", "Tài liệu", request.query, now);
      await retrieveEvidence(request, { db, embedder });
      await retrieveEvidence(request, { db, embedder });
      expect(embedder.embed).toHaveBeenCalledTimes(1);
      await retrieveEvidence(uncategorized, { db, embedder });
      expect(embedder.embed).toHaveBeenCalledTimes(2);
      const cache = await db.query("SELECT count(*)::text AS count FROM retrieval_cache WHERE query_hash = $1", [sha256Hex(uncategorized.query)]);
      expect(cache.rows[0]?.count).toBe("0");
    } finally {
      await removeCacheForQueries(db, [request.query, uncategorized.query], "vi").catch(() => undefined);
      await removeSources(db, [entry.id]).catch(() => undefined);
      await db.end();
    }
  });

  it("uses English volatility boundaries for stable and on-chain queries", async () => {
    const db = createDatabase(databaseUrl!);
    const repository = new KnowledgeRepository(db);
    const suffix = String(process.pid) + "-" + String(Date.now());
    const entry = source("retrieve-english-boundaries-" + suffix, "official", ["developer"]);
    const stable = input("Cardano knowledge documentation " + suffix, { cachePolicy: "stable" });
    const volatile = [
      input("what is on chain data " + suffix, { cachePolicy: "stable" }),
      input("what is currently supported " + suffix, { cachePolicy: "stable" }),
    ];
    const embedder = provider();
    try {
      await seedSource(db, entry);
      await seedVersion(repository, entry.id, entry.url + "/stable", "Knowledge", stable.query, now);
      await retrieveEvidence(stable, { db, embedder });
      await retrieveEvidence(stable, { db, embedder });
      expect(embedder.embed).toHaveBeenCalledTimes(1);
      for (const request of volatile) await retrieveEvidence(request, { db, embedder });
      expect(embedder.embed).toHaveBeenCalledTimes(3);
      const cache = await db.query("SELECT count(*)::text AS count FROM retrieval_cache WHERE query_hash = ANY($1::text[])", [volatile.map((request) => sha256Hex(request.query))]);
      expect(cache.rows[0]?.count).toBe("0");
    } finally {
      await removeCacheForQueries(db, [stable.query, ...volatile.map((request) => request.query)]).catch(() => undefined);
      await removeSources(db, [entry.id]).catch(() => undefined);
      await db.end();
    }
  });

  it("does not write stable cache entries when returned evidence is volatile", async () => {
    const db = createDatabase(databaseUrl!);
    const repository = new KnowledgeRepository(db);
    const suffix = String(process.pid) + "-" + String(Date.now());
    const entry = source("retrieve-volatile-evidence-" + suffix, "official", ["governance"]);
    const embedder = provider();
    const request = input("protocol explanation " + suffix, { cachePolicy: "stable" });
    try {
      await seedSource(db, entry);
      await seedVersion(repository, entry.id, entry.url + "/governance", "Governance", request.query, now);
      await retrieveEvidence(request, { db, embedder });
      await retrieveEvidence(request, { db, embedder });
      expect(embedder.embed).toHaveBeenCalledTimes(2);
      const cache = await db.query("SELECT count(*)::text AS count FROM retrieval_cache WHERE query_hash = $1", [sha256Hex(request.query)]);
      expect(cache.rows[0]?.count).toBe("0");
    } finally {
      await removeCacheForQueries(db, [request.query]).catch(() => undefined);
      await removeSources(db, [entry.id]).catch(() => undefined);
      await db.end();
    }
  });

  it("returns at most ten deterministic results from separate top-40 candidate sets", async () => {
    const db = createDatabase(databaseUrl!);
    const repository = new KnowledgeRepository(db);
    const suffix = String(process.pid) + "-" + String(Date.now());
    const entry = source("retrieve-top40-" + suffix, "official", ["developer"]);
    const embedder: EmbeddingProvider & { embed: ReturnType<typeof vi.fn> } = {
      embed: vi.fn(async () => [{ index: 0, embedding: directionalVector(true) }]),
    };
    try {
      await seedSource(db, entry);
      await seedChunks(repository, entry.id, entry.url + "/top40", "Candidates", Array.from({ length: 45 }, (_, index) => "vector-only candidate " + String(index)), now);
      const first = await retrieveEvidence(input("needle"), { db, embedder });
      const second = await retrieveEvidence(input("needle"), { db, embedder });
      expect(first).toEqual(second);
      expect(first).toHaveLength(10);
      expect(first.every((item) => /candidate (?:[0-9]|[1-3][0-9])/.test(item.excerpt))).toBe(true);
      expect(first.some((item) => /candidate 4[0-4]/.test(item.excerpt))).toBe(false);
    } finally {
      await removeSources(db, [entry.id]).catch(() => undefined);
      await db.end();
    }
  });

  it("does not fall back to an older indexed version when the newest metadata is oversized", async () => {
    const db = createDatabase(databaseUrl!);
    const repository = new KnowledgeRepository(db);
    const suffix = String(process.pid) + "-" + String(Date.now());
    const entry = source("retrieve-oversized-version-" + suffix, "official", ["developer"]);
    const canonicalUrl = entry.url + "/same";
    const query = "oversized metadata query " + suffix;
    let oldVersionId: string | undefined;
    let newVersionId: string | undefined;
    let constraintsDropped = false;
    try {
      await seedSource(db, entry);
      await db.query("ALTER TABLE source_versions DROP CONSTRAINT IF EXISTS source_versions_title_length, DROP CONSTRAINT IF EXISTS source_versions_canonical_url_length");
      constraintsDropped = true;
      const oldVersion = await repository.storeVersion({
        sourceId: entry.id,
        canonicalUrl,
        title: "Old bounded version",
        content: query,
        contentHash: sha256Hex(query),
        retrievedAt: now,
      });
      oldVersionId = oldVersion.id;
      await repository.replaceChunks(oldVersion.id, [{
        ordinal: 0,
        heading: "Old bounded version",
        content: query,
        contentHash: sha256Hex(`Old bounded version\n${query}`),
        embeddingModel,
        embedding: directionalVector(true),
      }]);
      const newerContent = "newer version body";
      const newer = await db.query<{ id: string }>(
        `INSERT INTO source_versions (source_id, canonical_url, title, content, content_hash, retrieved_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id::text AS id`,
        [entry.id, canonicalUrl, "N".repeat(301), newerContent, sha256Hex(newerContent), new Date(now.getTime() + 1_000)],
      );
      newVersionId = newer.rows[0]!.id;
      await db.query(
        `INSERT INTO knowledge_chunks (version_id, ordinal, heading, content, content_hash, embedding_model, embedding)
         VALUES ($1, 0, $2, $3, $4, $5, $6::vector)`,
        [newVersionId, "Newer version", newerContent, sha256Hex(`Newer version\n${newerContent}`), embeddingModel, `[${directionalVector(true).join(",")}]`],
      );
      await expect(retrieveEvidence(input(query), { db, embedder: provider() })).resolves.toEqual([]);
    } finally {
      await db.query("DELETE FROM knowledge_chunks WHERE version_id = ANY($1::bigint[])", [[oldVersionId, newVersionId].filter((id): id is string => id !== undefined)]).catch(() => undefined);
      await db.query("DELETE FROM source_versions WHERE id = ANY($1::bigint[])", [[oldVersionId, newVersionId].filter((id): id is string => id !== undefined)]).catch(() => undefined);
      if (constraintsDropped) {
        await db.query(
          "ALTER TABLE source_versions ADD CONSTRAINT source_versions_title_length CHECK (char_length(title) <= 300) NOT VALID, ADD CONSTRAINT source_versions_canonical_url_length CHECK (char_length(canonical_url) <= 2048) NOT VALID",
        );
      }
      await removeSources(db, [entry.id]).catch(() => undefined);
      await db.end();
    }
  });

  it("bounds evidence when an indexed heading is unexpectedly huge", async () => {
    const db = createDatabase(databaseUrl!);
    const repository = new KnowledgeRepository(db);
    const suffix = String(process.pid) + "-" + String(Date.now());
    const entry = source("retrieve-huge-heading-" + suffix, "official", ["developer"]);
    const query = "huge heading evidence " + suffix;
    try {
      await seedSource(db, entry);
      const versionId = await seedVersion(repository, entry.id, entry.url + "/huge", "Bounded title", query, now);
      await db.query("UPDATE knowledge_chunks SET heading = repeat('H', 100_000) WHERE version_id = $1", [versionId]);
      const evidence = await retrieveEvidence(input(query), { db, embedder: provider() });
      expect(evidence.length).toBeLessThanOrEqual(10);
      expect(evidence.every((item) => item.title.length <= 300 && item.url.length <= 2_048 && item.excerpt.length <= 1_000)).toBe(true);
    } finally {
      await removeSources(db, [entry.id]).catch(() => undefined);
      await db.end();
    }
  });

  it("excludes a newer unindexed version from normal retrieval", async () => {
    const db = createDatabase(databaseUrl!);
    const repository = new KnowledgeRepository(db);
    const suffix = String(process.pid) + "-" + String(Date.now());
    const entry = source("retrieve-unindexed-" + suffix, "official", ["developer"]);
    const embedder = provider();
    const canonicalUrl = entry.url + "/versioned";
    try {
      await seedSource(db, entry);
      await seedVersion(repository, entry.id, canonicalUrl, "Indexed old", "versioned evidence", now);
      await repository.storeVersion({
        sourceId: entry.id,
        canonicalUrl,
        title: "New unindexed",
        content: "versioned evidence newer",
        contentHash: sha256Hex("versioned evidence newer"),
        retrievedAt: new Date(now.getTime() + 1_000),
      });
      const evidence = await retrieveEvidence(input("versioned evidence"), { db, embedder });
      expect(evidence.length).toBeGreaterThan(0);
      expect(evidence.every((item) => item.title === "Indexed old")).toBe(true);
    } finally {
      await removeSources(db, [entry.id]).catch(() => undefined);
      await db.end();
    }
  });

  it("honors a short retrieval timeout while a table lock is held and keeps the pool usable", async () => {
    const db = createDatabase(databaseUrl!);
    const repository = new KnowledgeRepository(db);
    const suffix = String(process.pid) + "-" + String(Date.now());
    const entry = source("retrieve-timeout-" + suffix, "official", ["developer"]);
    const lockClient = await db.connect();
    try {
      await seedSource(db, entry);
      await seedVersion(repository, entry.id, entry.url + "/locked", "Locked", "locked evidence", now);
      await lockClient.query("BEGIN");
      await lockClient.query("LOCK TABLE knowledge_chunks IN ACCESS EXCLUSIVE MODE");
      const started = Date.now();
      await expect(retrieveEvidence(input("locked evidence", { timeoutMs: 200 }), { db, embedder: provider() })).rejects.toThrow(/timed out|deadline|aborted|cancel/i);
      expect(Date.now() - started).toBeLessThan(2_000);
      await lockClient.query("ROLLBACK");
      await expect(db.query("SELECT 1")).resolves.toBeTruthy();
    } finally {
      await lockClient.query("ROLLBACK").catch(() => undefined);
      lockClient.release();
      await removeSources(db, [entry.id]).catch(() => undefined);
      await db.end();
    }
  });

  it("does not leak a late pool acquisition after retrieval cancellation", async () => {
    const db = new Pool({ connectionString: databaseUrl!, max: 1, connectionTimeoutMillis: 5_000 });
    const holder = await db.connect();
    const started = Date.now();
    try {
      await expect(retrieveEvidence(input("queued acquisition", { timeoutMs: 100 }), { db, embedder: provider() })).rejects.toThrow(/deadline|aborted|timed out/i);
      expect(Date.now() - started).toBeLessThan(1_500);
    } finally {
      holder.release();
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(db.query("SELECT 1")).resolves.toBeDefined();
    await db.end();
  });

  it("does not cache volatile, current, personalized, or wallet queries", async () => {
    const db = createDatabase(databaseUrl!);
    const repository = new KnowledgeRepository(db);
    const suffix = String(process.pid) + "-" + String(Date.now());
    const entry = source("retrieve-volatile-cache-" + suffix, "official", ["developer"]);
    const embedder = provider();
    const requests = [
      input("latest Cardano node " + suffix, { cachePolicy: "stable" }),
      input("Cardano documentation " + suffix, { cachePolicy: "stable", personalized: true }),
      input("wallet balance " + suffix, { cachePolicy: "stable" }),
      input("transactions " + suffix, { cachePolicy: "stable" }),
    ];
    try {
      await removeCacheForQueries(db, requests.map((request) => request.query));
      await seedSource(db, entry);
      await seedVersion(repository, entry.id, entry.url + "/stable", "Stable", "Cardano documentation", now);
      for (const request of requests) await retrieveEvidence(request, { db, embedder });
      const cache = await db.query("SELECT count(*)::text AS count FROM retrieval_cache WHERE query_hash = ANY($1::text[])", [requests.map((request) => sha256Hex(request.query))]);
      expect(cache.rows[0]?.count).toBe("0");
      await expect(retrieveEvidence(input("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"), { db, embedder })).rejects.toThrow(/wallet|secret/i);
    } finally {
      await removeCacheForQueries(db, requests.map((request) => request.query)).catch(() => undefined);
      await removeSources(db, [entry.id]).catch(() => undefined);
      await db.end();
    }
  });

  it("deletes expired stable cache entries before recomputing", async () => {
    const db = createDatabase(databaseUrl!);
    const repository = new KnowledgeRepository(db);
    const suffix = String(process.pid) + "-" + String(Date.now());
    const entry = source("retrieve-expiry-" + suffix, "official", ["developer"]);
    const embedder = provider();
    const request = input("stable expiry " + suffix, { cachePolicy: "stable" });
    try {
      await removeCacheForQueries(db, [request.query]);
      await seedSource(db, entry);
      await seedVersion(repository, entry.id, entry.url + "/stable", "Stable", request.query, now);
      await retrieveEvidence(request, { db, embedder });
      await db.query("UPDATE retrieval_cache SET expires_at = $1 WHERE query_hash = $2", [new Date(now.getTime() - 1), sha256Hex(request.query)]);
      await retrieveEvidence(request, { db, embedder });
      expect(embedder.embed).toHaveBeenCalledTimes(2);
    } finally {
      await removeCacheForQueries(db, [request.query]).catch(() => undefined);
      await removeSources(db, [entry.id]).catch(() => undefined);
      await db.end();
    }
  });

  it("rejects malformed query, language, model, and provider vectors before SQL", async () => {
    const db = createDatabase(databaseUrl!);
    const embedder = provider();
    await expect(retrieveEvidence(input(" "), { db, embedder })).rejects.toThrow(/query/i);
    await expect(retrieveEvidence(input("x", { language: "" }), { db, embedder })).rejects.toThrow(/language/i);
    await expect(retrieveEvidence(input("x", { embeddingModel: "" }), { db, embedder })).rejects.toThrow(/model/i);
    await expect(retrieveEvidence(input("x", { topics: [" Governance "] }), { db, embedder })).resolves.toEqual([]);
    await expect(retrieveEvidence(input("x", { topics: ["governance", "governance"] }), { db, embedder })).rejects.toThrow(/topics/i);
    await expect(retrieveEvidence(input("x", { topics: [""] }), { db, embedder })).rejects.toThrow(/topics/i);
    await expect(retrieveEvidence(input("x", { topics: ["a".repeat(65)] }), { db, embedder })).rejects.toThrow(/topics/i);
    await expect(retrieveEvidence(input("x", { networks: ["testnet"] }), { db, embedder })).rejects.toThrow(/networks/i);
    await expect(retrieveEvidence(input("x", { networks: ["mainnet", "mainnet"] }), { db, embedder })).rejects.toThrow(/networks/i);
    await expect(retrieveEvidence(input("x", { now: new Date(Number.NaN) }), { db, embedder })).rejects.toThrow(/date|now/i);
    const malformed = { embed: vi.fn(async () => [{ index: 0, embedding: [1] }]) };
    await expect(retrieveEvidence(input("x"), { db, embedder: malformed })).rejects.toThrow(/embedding|vector/i);
    await db.end();
  });
});
