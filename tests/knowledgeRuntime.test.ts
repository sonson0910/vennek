import { describe, expect, it } from "vitest";
import { parseKnowledgeDatabaseConfig, parseKnowledgeMode, parseKnowledgeRuntimeConfig } from "../apps/telegram-bot/src/main.js";

describe("knowledge runtime boundary", () => {
  it("accepts only the exact knowledge modes", () => {
    expect(parseKnowledgeMode(["--knowledge-worker"])).toBe("worker");
    expect(parseKnowledgeMode(["--sync-source", "cardano-org"])).toBe("sync:cardano-org");
    expect(() => parseKnowledgeMode(["--knowledge-worker", "--poll"])).toThrow(/additional|exclusive/i);
    expect(() => parseKnowledgeMode(["--sync-source", "cardano-org", "extra"])).toThrow(/exactly/i);
    expect(parseKnowledgeMode(["--poll"])).toBeUndefined();
  });

  it("requires only knowledge ingestion credentials", () => {
    const config = parseKnowledgeRuntimeConfig({
      DATABASE_KNOWLEDGE_URL: "postgresql://knowledge:password@postgres/vennek",
      LITELLM_BASE_URL: "http://litellm:4000",
      LITELLM_API_KEY: "key",
      VENNEK_EMBEDDING_MODEL: "cardano-embedding",
    });
    expect(config.databaseUrl).toContain("knowledge");
    expect(config.embeddingModel).toBe("cardano-embedding");
    expect(() => parseKnowledgeRuntimeConfig({
      LITELLM_BASE_URL: "http://litellm:4000",
      LITELLM_API_KEY: "key",
      VENNEK_EMBEDDING_MODEL: "cardano-embedding",
    })).toThrow(/DATABASE_KNOWLEDGE_URL/);
  });

  it("keeps admin enqueue configuration database-only", () => {
    expect(parseKnowledgeDatabaseConfig({ DATABASE_KNOWLEDGE_URL: "postgresql://knowledge:password@postgres/vennek" })).toEqual({
      databaseUrl: "postgresql://knowledge:password@postgres/vennek",
    });
    expect(() => parseKnowledgeDatabaseConfig({})).toThrow(/DATABASE_KNOWLEDGE_URL/);
  });
});
