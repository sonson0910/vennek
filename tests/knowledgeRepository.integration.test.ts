import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { KnowledgeRepository, createDatabase } from "@vennek/cardano-agent";

const databaseUrl = process.env.TEST_DATABASE_URL;
const embedding = () => Array.from({ length: 1_536 }, (_, index) => index / 1_536);

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

    await expect(repository.replaceChunks("1", [{
      ordinal: 0,
      heading: "Heading",
      content: "Chunk body",
      contentHash: "b".repeat(64),
      embeddingModel: "test-model",
      embedding: [Number.NaN],
    }])).rejects.toThrow(/1,536 finite/i);
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
    expect(connectCalls).toBe(0);
  });
});

describe.skipIf(!databaseUrl)("knowledge repository", () => {
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
