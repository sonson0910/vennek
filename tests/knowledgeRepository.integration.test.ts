import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { KnowledgeRepository, createDatabase, type SourceRegistryEntry } from "@vennek/cardano-agent";

const databaseUrl = process.env.TEST_DATABASE_URL;
const embedding = () => Array.from({ length: 1_536 }, (_, index) => index / 1_536);
const githubEntry: SourceRegistryEntry = {
  id: "test-github",
  owner: "Test Org",
  trustTier: "official",
  kind: "github",
  url: "https://github.com/test-org/test-repo",
  allowedDomains: ["github.com", "raw.githubusercontent.com", "api.github.com"],
  github: { owner: "test-org", repository: "test-repo" },
  topics: ["developer"],
  networks: ["mainnet"],
  refresh: "daily"
};

describe("knowledge repository validation", () => {
  it("rejects invalid versions before touching the pool", async () => {
    let connectCalls = 0;
    const db = {
      connect: async () => {
        connectCalls += 1;
        throw new Error("pool must not be connected");
      },
    } as unknown as Pool;
    const repository = new KnowledgeRepository(db);

    await expect(repository.storeVersion({
      sourceId: "cardano-docs",
      canonicalUrl: "http://docs.cardano.org/about",
      title: "About Cardano",
      content: "Cardano source body",
      contentHash: "a".repeat(64),
      retrievedAt: new Date("2026-08-24T00:00:00Z"),
    })).rejects.toThrow(/HTTPS/);
    await expect(repository.storeVersion({
      sourceId: "cardano-docs",
      canonicalUrl: "https://user:secret@docs.cardano.org/about",
      title: "About Cardano",
      content: "Cardano source body",
      contentHash: "a".repeat(64),
      retrievedAt: new Date("2026-08-24T00:00:00Z"),
    })).rejects.toThrow(/credentials/i);
    await expect(repository.storeVersion({
      sourceId: "cardano-docs",
      canonicalUrl: "https://docs.cardano.org/about",
      title: "About Cardano",
      content: "   ",
      contentHash: "a".repeat(64),
      retrievedAt: new Date("2026-08-24T00:00:00Z"),
    })).rejects.toThrow(/content/i);
    expect(connectCalls).toBe(0);
  });

  it("rejects invalid chunk vectors and duplicate ordinals before a transaction", async () => {
    let connectCalls = 0;
    const db = {
      connect: async () => {
        connectCalls += 1;
        throw new Error("pool must not be connected");
      },
    } as unknown as Pool;
    const repository = new KnowledgeRepository(db);
    const sparseEmbedding = new Array<number>(1_536);

    await expect(repository.replaceChunks("1", [{
      ordinal: 0,
      heading: "Heading",
      content: "Chunk body",
      contentHash: "b".repeat(64),
      embeddingModel: "test-model",
      embedding: [Number.NaN],
    }])).rejects.toThrow(/1,536 finite/i);
    await expect(repository.replaceChunks("1", [{
      ordinal: 0,
      heading: "Heading",
      content: "Chunk body",
      contentHash: "b".repeat(64),
      embeddingModel: "test-model",
      embedding: sparseEmbedding,
    }])).rejects.toThrow(/1,536 finite/i);
    const overflowingEmbedding = embedding();
    overflowingEmbedding[0] = Number.MAX_VALUE;
    await expect(repository.replaceChunks("1", [{
      ordinal: 0,
      heading: "Heading",
      content: "Chunk body",
      contentHash: "b".repeat(64),
      embeddingModel: "test-model",
      embedding: overflowingEmbedding,
    }])).rejects.toThrow(/float4/i);
    await expect(repository.replaceChunks("1", [
      {
        ordinal: 0,
        heading: "Heading",
        content: "Chunk body",
        contentHash: "b".repeat(64),
        embeddingModel: "test-model",
        embedding: embedding(),
      },
      {
        ordinal: 0,
        heading: "Heading 2",
        content: "Chunk body 2",
        contentHash: "c".repeat(64),
        embeddingModel: "test-model",
        embedding: embedding(),
      },
    ])).rejects.toThrow(/ordinal/i);
    await expect(repository.replaceChunks("9223372036854775808", [{
      ordinal: 0,
      heading: "Heading",
      content: "Chunk body",
      contentHash: "b".repeat(64),
      embeddingModel: "test-model",
      embedding: embedding(),
    }])).rejects.toThrow(/version ID/i);
    await expect(repository.replaceChunks("1", [{
      ordinal: 2_147_483_648,
      heading: "Heading",
      content: "Chunk body",
      contentHash: "b".repeat(64),
      embeddingModel: "test-model",
      embedding: embedding(),
    }])).rejects.toThrow(/ordinal/i);
    expect(connectCalls).toBe(0);
  });

  it("discards the connection when rollback fails and preserves the original error", async () => {
    const insertError = new Error("insert failed");
    const release = vi.fn();
    const query = vi.fn(async (sql: string) => {
      if (sql === "BEGIN" || sql.startsWith("DELETE")) return { rows: [] };
      if (sql === "ROLLBACK") throw new Error("rollback failed");
      throw insertError;
    });
    const db = { connect: async () => ({ query, release }) } as unknown as Pool;
    const repository = new KnowledgeRepository(db);

    await expect(repository.replaceChunks("1", [{
      ordinal: 0,
      heading: "Heading",
      content: "Chunk body",
      contentHash: "b".repeat(64),
      embeddingModel: "test-model",
      embedding: embedding(),
    }])).rejects.toBe(insertError);
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN",
      expect.stringMatching(/^DELETE/),
      expect.stringMatching(/^INSERT/),
      "ROLLBACK",
    ]);
    expect(release).toHaveBeenCalledWith(insertError);
  });

  it("validates endpoint state before issuing CAS queries", async () => {
    const query = vi.fn(async () => ({ rowCount: 1, rows: [] }));
    const repository = new KnowledgeRepository({ query } as unknown as Pool);
    const now = "2026-08-24T00:00:00.000Z";
    const state = { etag: 'W/"safe"', checkedAt: now, rateLimitRemaining: 10 };

    await expect(repository.compareAndSetGithubEndpointState("test-github", "repository", null, state)).resolves.toBe(true);
    expect(query).toHaveBeenCalledWith(expect.stringMatching(/jsonb_set/), [
      "test-github",
      "repository",
      JSON.stringify(state),
      "null"
    ]);
    await expect(repository.compareAndSetGithubEndpointState("test-github", "repository", null, {
      etag: "bad\nvalue"
    })).rejects.toThrow(/etag/i);
    await expect(repository.getGithubEndpointState("test-github", "unknown" as never)).rejects.toThrow(/endpoint/i);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("upserts a validated source without overwriting fetch lifecycle columns", async () => {
    const query = vi.fn(async () => ({ rowCount: 1, rows: [] }));
    const repository = new KnowledgeRepository({ query } as unknown as Pool);

    await repository.ensureSource(githubEntry);
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toMatch(/ON CONFLICT \(id\)/);
    expect(params.slice(0, 3)).toEqual([githubEntry.id, githubEntry.owner, githubEntry.trustTier]);
    expect(JSON.parse(params[3] as string)).toEqual(githubEntry);
    await expect(repository.ensureSource({ ...githubEntry, url: "http://evil.test" } as SourceRegistryEntry)).rejects.toThrow(/https/i);
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe.skipIf(!databaseUrl)("knowledge repository", () => {
  it("preserves source lifecycle fields and rejects a stale endpoint CAS", async () => {
    const db = createDatabase(databaseUrl!);
    const repository = new KnowledgeRepository(db);
    const sourceId = `test-github-${process.pid}-${Date.now()}`;
    const entry = { ...githubEntry, id: sourceId };
    const checkedAt = "2026-08-24T00:00:00.000Z";

    try {
      await db.query(
        `INSERT INTO knowledge_sources (id, owner, trust_tier, registry, fetch_state, last_success_at, last_error_code)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7)`,
        [sourceId, "Old owner", "community", "{}", JSON.stringify({ repository: { etag: '"old"' } }), checkedAt, "old-error"],
      );
      await repository.ensureSource(entry);
      const preserved = await db.query<{ owner: string; trust_tier: string; fetch_state: unknown; last_success_at: Date; last_error_code: string }>(
        `SELECT owner, trust_tier, fetch_state, last_success_at, last_error_code
         FROM knowledge_sources WHERE id = $1`,
        [sourceId],
      );
      expect(preserved.rows[0]).toMatchObject({
        owner: entry.owner,
        trust_tier: entry.trustTier,
        fetch_state: { repository: { etag: '"old"' } },
        last_error_code: "old-error"
      });
      expect(preserved.rows[0]?.last_success_at.toISOString()).toBe(checkedAt);

      const expected = await repository.getGithubEndpointState(sourceId, "repository");
      const next = { ...expected, checkedAt };
      await expect(repository.compareAndSetGithubEndpointState(sourceId, "repository", expected, next)).resolves.toBe(true);
      await expect(repository.compareAndSetGithubEndpointState(sourceId, "repository", expected, { etag: '"stale"' })).resolves.toBe(false);
      await expect(repository.getGithubEndpointState(sourceId, "repository")).resolves.toEqual(next);
    } finally {
      await db.query("DELETE FROM knowledge_sources WHERE id = $1", [sourceId]).catch(() => undefined);
      await db.end();
    }
  });

  it("deduplicates versions and replaces chunks atomically", async () => {
    const db = createDatabase(databaseUrl!);
    const repository = new KnowledgeRepository(db);
    const sourceId = `test-cardano-docs-${process.pid}-${Date.now()}`;
    const canonicalUrl = `https://docs.cardano.org/test/${sourceId}`;

    try {
      await db.query(
        `INSERT INTO knowledge_sources (id, owner, trust_tier, registry)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [sourceId, "Cardano", "official", JSON.stringify({ id: sourceId })],
      );
      const first = await repository.storeVersion({
        sourceId,
        canonicalUrl,
        title: "About Cardano",
        content: "Cardano source body",
        contentHash: "a".repeat(64),
        retrievedAt: new Date("2026-08-24T00:00:00Z"),
      });
      const second = await repository.storeVersion({
        sourceId,
        canonicalUrl,
        title: "About Cardano",
        content: "Cardano source body",
        contentHash: "a".repeat(64),
        retrievedAt: new Date("2026-08-24T01:00:00Z"),
      });
      expect(second.id).toBe(first.id);
      const concurrentCanonicalUrl = `${canonicalUrl}/concurrent`;
      const concurrent = await Promise.all(Array.from({ length: 4 }, () => repository.storeVersion({
        sourceId,
        canonicalUrl: concurrentCanonicalUrl,
        title: "Concurrent Cardano version",
        content: "A fresh Cardano version created concurrently.",
        contentHash: "f".repeat(64),
        retrievedAt: new Date("2026-08-24T02:00:00Z"),
      })));
      expect(new Set(concurrent.map(({ id }) => id)).size).toBe(1);
      const versions = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM source_versions
         WHERE source_id = $1 AND canonical_url = $2 AND content_hash = $3`,
        [sourceId, concurrentCanonicalUrl, "f".repeat(64)],
      );
      expect(versions.rows[0]?.count).toBe("1");

      await repository.replaceChunks(first.id, [{
        ordinal: 0,
        heading: "Ouroboros",
        content: "Proof of stake.",
        contentHash: "b".repeat(64),
        embeddingModel: "test-model",
        embedding: embedding(),
      }, {
        ordinal: 1,
        heading: "Governance",
        content: "Cardano governance.",
        contentHash: "c".repeat(64),
        embeddingModel: "test-model",
        embedding: embedding(),
      }]);
      const constraintName = `knowledge_chunks_r2_${process.pid}_${Date.now()}`;
      await db.query(
        `ALTER TABLE knowledge_chunks ADD CONSTRAINT "${constraintName}"
         CHECK (version_id <> ${first.id} OR ordinal <> 1) NOT VALID`,
      );
      try {
        await expect(repository.replaceChunks(first.id, [{
          ordinal: 0,
          heading: "Attempted update",
          content: "This insert succeeds before the next one fails.",
          contentHash: "d".repeat(64),
          embeddingModel: "test-model",
          embedding: embedding(),
        }, {
          ordinal: 1,
          heading: "Forced failure",
          content: "The test constraint rejects this insert.",
          contentHash: "e".repeat(64),
          embeddingModel: "test-model",
          embedding: embedding(),
        }])).rejects.toThrow();
        const preserved = await db.query<{ ordinal: number; content: string }>(
          `SELECT ordinal, content FROM knowledge_chunks
           WHERE version_id = $1 ORDER BY ordinal`,
          [first.id],
        );
        expect(preserved.rows).toEqual([
          { ordinal: 0, content: "Proof of stake." },
          { ordinal: 1, content: "Cardano governance." },
        ]);
      } finally {
        await db.query(`ALTER TABLE knowledge_chunks DROP CONSTRAINT IF EXISTS "${constraintName}"`);
      }
      await repository.replaceChunks(first.id, [{
        ordinal: 0,
        heading: "Updated",
        content: "Updated Cardano body.",
        contentHash: "d".repeat(64),
        embeddingModel: "test-model",
        embedding: embedding(),
      }]);

      const chunks = await db.query<{ ordinal: number; content: string }>(
        `SELECT ordinal, content FROM knowledge_chunks
         WHERE version_id = $1 ORDER BY ordinal`,
        [first.id],
      );
      expect(chunks.rows).toEqual([{ ordinal: 0, content: "Updated Cardano body." }]);
    } finally {
      await db.query(
        `DELETE FROM knowledge_chunks
         WHERE version_id IN (SELECT id FROM source_versions WHERE source_id = $1)`,
        [sourceId],
      ).catch(() => undefined);
      await db.query("DELETE FROM source_versions WHERE source_id = $1", [sourceId]).catch(() => undefined);
      await db.query("DELETE FROM knowledge_sources WHERE id = $1", [sourceId]).catch(() => undefined);
      await db.end();
    }
  });
});
