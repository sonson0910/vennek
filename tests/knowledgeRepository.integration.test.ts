import { describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
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
      if (sql === "BEGIN" || sql.startsWith("SELECT id FROM") || sql.startsWith("DELETE")) return { rows: [], rowCount: 1 };
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
      expect.stringMatching(/^SELECT id FROM source_versions/),
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

  it("validates complete chunk queries before issuing SQL", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const repository = new KnowledgeRepository({ query } as unknown as Pool);

    await expect(repository.hasCompleteChunks("0", "test-model", ["a".repeat(64)])).rejects.toThrow(/version ID/i);
    await expect(repository.hasCompleteChunks("1", "", ["a".repeat(64)])).rejects.toThrow(/embedding model/i);
    await expect(repository.hasCompleteChunks("1", "test-model", [])).rejects.toThrow(/hash/i);
    await expect(repository.hasCompleteChunks("1", "test-model", ["A".repeat(64)])).rejects.toThrow(/hash/i);
    expect(query).not.toHaveBeenCalled();
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

  it("rolls back every endpoint when one batch CAS is stale", async () => {
    const db = createDatabase(databaseUrl!);
    const repository = new KnowledgeRepository(db);
    const sourceId = `test-github-batch-${process.pid}-${Date.now()}`;
    try {
      await db.query(
        `INSERT INTO knowledge_sources (id, owner, trust_tier, registry, fetch_state)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)`,
        [sourceId, "Cardano", "official", JSON.stringify({ ...githubEntry, id: sourceId }), JSON.stringify({
          repository: { etag: '"repo-old"' },
          readme: { etag: '"readme-old"' }
        })],
      );
      const repositoryState = await repository.getGithubEndpointState(sourceId, "repository");
      const readmeState = await repository.getGithubEndpointState(sourceId, "readme");

      await expect(repository.compareAndSetGithubEndpointStates([
        {
          sourceId,
          endpoint: "repository",
          expectedState: repositoryState,
          nextState: { etag: '"repo-new"' }
        },
        {
          sourceId,
          endpoint: "readme",
          expectedState: { etag: '"stale"' },
          nextState: { etag: '"readme-new"' }
        }
      ])).resolves.toBe(false);
      await expect(repository.getGithubEndpointState(sourceId, "repository")).resolves.toEqual(repositoryState);
      await expect(repository.getGithubEndpointState(sourceId, "readme")).resolves.toEqual(readmeState);
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

  it("reports only an exact ordered chunk set for an embedding model", async () => {
    const db = createDatabase(databaseUrl!);
    const repository = new KnowledgeRepository(db);
    const sourceId = `test-cardano-complete-${process.pid}-${Date.now()}`;
    const canonicalUrl = `https://docs.cardano.org/test/${sourceId}`;
    const firstHash = "b".repeat(64);
    const secondHash = "c".repeat(64);

    try {
      await db.query(
        `INSERT INTO knowledge_sources (id, owner, trust_tier, registry)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [sourceId, "Cardano", "official", JSON.stringify({ id: sourceId })],
      );
      const version = await repository.storeVersion({
        sourceId,
        canonicalUrl,
        title: "About Cardano",
        content: "Cardano source body",
        contentHash: "a".repeat(64),
        retrievedAt: new Date("2026-08-24T00:00:00Z"),
      });
      await repository.replaceChunks(version.id, [{
        ordinal: 0,
        heading: "Ouroboros",
        content: "Proof of stake.",
        contentHash: firstHash,
        embeddingModel: "test-model",
        embedding: embedding(),
      }, {
        ordinal: 1,
        heading: "Governance",
        content: "Cardano governance.",
        contentHash: secondHash,
        embeddingModel: "test-model",
        embedding: embedding(),
      }]);

      await expect(repository.hasCompleteChunks(version.id, "test-model", [firstHash, secondHash])).resolves.toBe(true);
      await expect(repository.hasCompleteChunks(version.id, "test-model", [secondHash, firstHash])).resolves.toBe(false);
      await expect(repository.hasCompleteChunks(version.id, "other-model", [firstHash, secondHash])).resolves.toBe(false);
      await expect(repository.hasCompleteChunks(version.id, "test-model", [firstHash])).resolves.toBe(false);
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

  it("serializes concurrent replacements for one version under a row lock", async () => {
    const db = createDatabase(databaseUrl!);
    const repository = new KnowledgeRepository(db);
    const sourceId = `test-cardano-concurrent-replace-${process.pid}-${Date.now()}`;
    const canonicalUrl = `https://docs.cardano.org/test/${sourceId}`;
    const firstHash = "d".repeat(64);
    const secondHash = "e".repeat(64);

    try {
      await db.query(
        `INSERT INTO knowledge_sources (id, owner, trust_tier, registry)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [sourceId, "Cardano", "official", JSON.stringify({ id: sourceId })],
      );
      const version = await repository.storeVersion({
        sourceId,
        canonicalUrl,
        title: "Concurrent Cardano version",
        content: "Concurrent source body",
        contentHash: "f".repeat(64),
        retrievedAt: new Date("2026-08-24T00:00:00Z"),
      });
      const makeChunk = (contentHash: string, content: string) => [{
        ordinal: 0,
        heading: "Concurrent",
        content,
        contentHash,
        embeddingModel: "test-model",
        embedding: embedding(),
      }];

      await expect(Promise.all([
        repository.replaceChunks(version.id, makeChunk(firstHash, "First complete set.")),
        repository.replaceChunks(version.id, makeChunk(secondHash, "Second complete set.")),
      ])).resolves.toHaveLength(2);
      const rows = await db.query<{ content_hash: string; content: string }>(
        `SELECT content_hash, content FROM knowledge_chunks WHERE version_id = $1 ORDER BY ordinal`,
        [version.id],
      );
      expect(rows.rows).toHaveLength(1);
      expect([firstHash, secondHash]).toContain(rows.rows[0]?.content_hash);
      expect(["First complete set.", "Second complete set."]).toContain(rows.rows[0]?.content);
    } finally {
      await db.query(`DELETE FROM knowledge_chunks WHERE version_id IN (SELECT id FROM source_versions WHERE source_id = $1)`, [sourceId]).catch(() => undefined);
      await db.query("DELETE FROM source_versions WHERE source_id = $1", [sourceId]).catch(() => undefined);
      await db.query("DELETE FROM knowledge_sources WHERE id = $1", [sourceId]).catch(() => undefined);
      await db.end();
    }
  });

  it("bounds replacement while another transaction holds the version lock", async () => {
    const db = createDatabase(databaseUrl!);
    const blockerDb = createDatabase(databaseUrl!);
    const repository = new KnowledgeRepository(db);
    const sourceId = `test-cardano-replace-timeout-${process.pid}-${Date.now()}`;
    const canonicalUrl = `https://docs.cardano.org/test/${sourceId}`;
    const makeChunk = (contentHash: string) => [{
      ordinal: 0,
      heading: "Timeout",
      content: "Bounded replacement.",
      contentHash,
      embeddingModel: "test-model",
      embedding: embedding(),
    }];
    let blocker: PoolClient | undefined;

    try {
      await db.query("INSERT INTO knowledge_sources (id, owner, trust_tier, registry) VALUES ($1, $2, $3, $4::jsonb)", [
        sourceId, "Cardano", "official", JSON.stringify({ id: sourceId }),
      ]);
      const version = await repository.storeVersion({
        sourceId,
        canonicalUrl,
        title: "Replacement timeout",
        content: "A source body.",
        contentHash: "a".repeat(64),
        retrievedAt: new Date("2026-08-24T00:00:00Z"),
      });
      blocker = await blockerDb.connect();
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM source_versions WHERE id = $1 FOR UPDATE", [version.id]);

      await expect(repository.replaceChunks(version.id, makeChunk("b".repeat(64)), { timeoutMs: 100 }))
        .rejects.toThrow(/timed out/i);
      const untouched = await db.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM knowledge_chunks WHERE version_id = $1",
        [version.id],
      );
      expect(untouched.rows[0]?.count).toBe("0");

      await blocker.query("ROLLBACK");
      await expect(repository.replaceChunks(version.id, makeChunk("b".repeat(64)))).resolves.toBeUndefined();
      await expect(db.query("SELECT 1")).resolves.toBeDefined();
    } finally {
      await blocker?.query("ROLLBACK").catch(() => undefined);
      blocker?.release();
      await db.query("DELETE FROM knowledge_chunks WHERE version_id IN (SELECT id FROM source_versions WHERE source_id = $1)", [sourceId]).catch(() => undefined);
      await db.query("DELETE FROM source_versions WHERE source_id = $1", [sourceId]).catch(() => undefined);
      await db.query("DELETE FROM knowledge_sources WHERE id = $1", [sourceId]).catch(() => undefined);
      await blockerDb.end();
      await db.end();
    }
  });

  it("bounds staged endpoint CAS while another transaction holds the source lock", async () => {
    const db = createDatabase(databaseUrl!);
    const blockerDb = createDatabase(databaseUrl!);
    const repository = new KnowledgeRepository(db);
    const sourceId = `test-github-cas-timeout-${process.pid}-${Date.now()}`;
    let blocker: PoolClient | undefined;

    try {
      await db.query("INSERT INTO knowledge_sources (id, owner, trust_tier, registry, fetch_state) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)", [
        sourceId,
        "Cardano",
        "official",
        JSON.stringify({ ...githubEntry, id: sourceId }),
        JSON.stringify({ repository: { etag: '"old"' } }),
      ]);
      const expected = await repository.getGithubEndpointState(sourceId, "repository");
      blocker = await blockerDb.connect();
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM knowledge_sources WHERE id = $1 FOR UPDATE", [sourceId]);

      await expect(repository.compareAndSetGithubEndpointStates([{
        sourceId,
        endpoint: "repository",
        expectedState: expected,
        nextState: { etag: '"new"' },
      }], { timeoutMs: 100 })).rejects.toThrow(/timed out/i);
      await expect(repository.getGithubEndpointState(sourceId, "repository")).resolves.toEqual(expected);

      await blocker.query("ROLLBACK");
      await expect(repository.compareAndSetGithubEndpointStates([{
        sourceId,
        endpoint: "repository",
        expectedState: expected,
        nextState: { etag: '"new"' },
      }])).resolves.toBe(true);
      await expect(db.query("SELECT 1")).resolves.toBeDefined();
    } finally {
      await blocker?.query("ROLLBACK").catch(() => undefined);
      blocker?.release();
      await db.query("DELETE FROM knowledge_sources WHERE id = $1", [sourceId]).catch(() => undefined);
      await blockerDb.end();
      await db.end();
    }
  });

  it("bounds immediate single-endpoint CAS while another transaction holds the source lock", async () => {
    const db = createDatabase(databaseUrl!);
    const blockerDb = createDatabase(databaseUrl!);
    const repository = new KnowledgeRepository(db);
    const sourceId = `test-github-single-cas-timeout-${process.pid}-${Date.now()}`;
    let blocker: PoolClient | undefined;

    try {
      await db.query("INSERT INTO knowledge_sources (id, owner, trust_tier, registry, fetch_state) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)", [
        sourceId,
        "Cardano",
        "official",
        JSON.stringify({ ...githubEntry, id: sourceId }),
        JSON.stringify({ repository: { etag: '"old"' } }),
      ]);
      const expected = await repository.getGithubEndpointState(sourceId, "repository");
      blocker = await blockerDb.connect();
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM knowledge_sources WHERE id = $1 FOR UPDATE", [sourceId]);

      await expect(repository.compareAndSetGithubEndpointState(
        sourceId,
        "repository",
        expected,
        { etag: '"new"' },
        { timeoutMs: 100 },
      )).rejects.toThrow(/timed out/i);
      await expect(repository.getGithubEndpointState(sourceId, "repository")).resolves.toEqual(expected);

      await blocker.query("ROLLBACK");
      await expect(repository.compareAndSetGithubEndpointState(
        sourceId,
        "repository",
        expected,
        { etag: '"new"' },
      )).resolves.toBe(true);
      await expect(db.query("SELECT 1")).resolves.toBeDefined();
    } finally {
      await blocker?.query("ROLLBACK").catch(() => undefined);
      blocker?.release();
      await db.query("DELETE FROM knowledge_sources WHERE id = $1", [sourceId]).catch(() => undefined);
      await blockerDb.end();
      await db.end();
    }
  });

  it("bounds storeVersion while a conflicting source version insert is uncommitted", async () => {
    const db = createDatabase(databaseUrl!);
    const blockerDb = createDatabase(databaseUrl!);
    const repository = new KnowledgeRepository(db);
    const sourceId = `test-cardano-store-timeout-${process.pid}-${Date.now()}`;
    const canonicalUrl = `https://docs.cardano.org/test/${sourceId}`;
    const contentHash = "a".repeat(64);
    let blocker: PoolClient | undefined;

    try {
      await db.query("INSERT INTO knowledge_sources (id, owner, trust_tier, registry) VALUES ($1, $2, $3, $4::jsonb)", [
        sourceId, "Cardano", "official", JSON.stringify({ id: sourceId }),
      ]);
      blocker = await blockerDb.connect();
      await blocker.query("BEGIN");
      await blocker.query(
        "INSERT INTO source_versions (source_id, canonical_url, title, content, content_hash, retrieved_at) VALUES ($1, $2, $3, $4, $5, $6)",
        [sourceId, canonicalUrl, "Blocked version", "Blocked body", contentHash, new Date("2026-08-24T00:00:00Z")],
      );

      await expect(repository.storeVersion({
        sourceId,
        canonicalUrl,
        title: "Blocked version",
        content: "Blocked body",
        contentHash,
        retrievedAt: new Date("2026-08-24T00:00:00Z"),
      }, { timeoutMs: 100 })).rejects.toThrow(/timed out/i);

      await blocker.query("ROLLBACK");
      await expect(repository.storeVersion({
        sourceId,
        canonicalUrl,
        title: "Stored version",
        content: "Stored body",
        contentHash,
        retrievedAt: new Date("2026-08-24T00:00:00Z"),
      })).resolves.toMatchObject({ id: expect.any(String) });
      await expect(db.query("SELECT 1")).resolves.toBeDefined();
    } finally {
      await blocker?.query("ROLLBACK").catch(() => undefined);
      blocker?.release();
      await db.query("DELETE FROM source_versions WHERE source_id = $1", [sourceId]).catch(() => undefined);
      await db.query("DELETE FROM knowledge_sources WHERE id = $1", [sourceId]).catch(() => undefined);
      await blockerDb.end();
      await db.end();
    }
  });

  it("bounds completeness reads while the chunk table is locked", async () => {
    const db = createDatabase(databaseUrl!);
    const blockerDb = createDatabase(databaseUrl!);
    const repository = new KnowledgeRepository(db);
    const sourceId = `test-cardano-read-timeout-${process.pid}-${Date.now()}`;
    const canonicalUrl = `https://docs.cardano.org/test/${sourceId}`;
    let blocker: PoolClient | undefined;

    try {
      await db.query("INSERT INTO knowledge_sources (id, owner, trust_tier, registry) VALUES ($1, $2, $3, $4::jsonb)", [
        sourceId, "Cardano", "official", JSON.stringify({ id: sourceId }),
      ]);
      const version = await repository.storeVersion({
        sourceId,
        canonicalUrl,
        title: "Read timeout",
        content: "Read body",
        contentHash: "b".repeat(64),
        retrievedAt: new Date("2026-08-24T00:00:00Z"),
      });
      blocker = await blockerDb.connect();
      await blocker.query("BEGIN");
      await blocker.query("LOCK TABLE knowledge_chunks IN ACCESS EXCLUSIVE MODE");

      await expect(repository.hasCompleteChunks(version.id, "test-model", ["c".repeat(64)], { timeoutMs: 100 }))
        .rejects.toThrow(/timed out/i);

      await blocker.query("ROLLBACK");
      await expect(repository.hasCompleteChunks(version.id, "test-model", ["c".repeat(64)])).resolves.toBe(false);
      await expect(db.query("SELECT 1")).resolves.toBeDefined();
    } finally {
      await blocker?.query("ROLLBACK").catch(() => undefined);
      blocker?.release();
      await db.query("DELETE FROM source_versions WHERE source_id = $1", [sourceId]).catch(() => undefined);
      await db.query("DELETE FROM knowledge_sources WHERE id = $1", [sourceId]).catch(() => undefined);
      await blockerDb.end();
      await db.end();
    }
  });
});
