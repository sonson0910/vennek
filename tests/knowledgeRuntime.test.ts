import { describe, expect, it } from "vitest";
import { parseKnowledgeDatabaseConfig, parseKnowledgeMode, parseKnowledgeRuntimeConfig } from "../apps/telegram-bot/src/main.js";

const promotionKey = Buffer.alloc(32).toString("base64");

function workerEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    DATABASE_KNOWLEDGE_URL: "postgresql://knowledge:password@postgres/vennek",
    LITELLM_BASE_URL: "http://litellm:4000",
    LITELLM_API_KEY: "key",
    VENNEK_EMBEDDING_MODEL: "cardano-embedding",
    SEARXNG_BASE_URL: "https://search.example.test/",
    KNOWLEDGE_PROMOTION_PORT: "8081",
    KNOWLEDGE_PROMOTION_KEY_ID: "knowledge-worker",
    KNOWLEDGE_PROMOTION_KEY: promotionKey,
    ...overrides,
  };
}

describe("knowledge runtime boundary", () => {
  it("accepts only the exact knowledge modes", () => {
    expect(parseKnowledgeMode(["--knowledge-worker"])).toBe("worker");
    expect(parseKnowledgeMode(["--sync-source", "cardano-org"])).toBe("sync:cardano-org");
    expect(() => parseKnowledgeMode(["--knowledge-worker", "--poll"])).toThrow(/additional|exclusive/i);
    expect(() => parseKnowledgeMode(["--sync-source", "cardano-org", "extra"])).toThrow(/exactly/i);
    expect(parseKnowledgeMode(["--poll"])).toBeUndefined();
  });

  it("requires only knowledge ingestion credentials", () => {
    const config = parseKnowledgeRuntimeConfig(workerEnv());
    expect(config.databaseUrl).toContain("knowledge");
    expect(config.embeddingModel).toBe("cardano-embedding");
    expect(config.searxngBaseUrl).toEqual(new URL("https://search.example.test/"));
    expect(config.promotionPort).toBe(8081);
    expect(config.promotionIdentity.keyId).toBe("knowledge-worker");
    expect(() => parseKnowledgeRuntimeConfig({
      LITELLM_BASE_URL: "http://litellm:4000",
      LITELLM_API_KEY: "key",
      VENNEK_EMBEDDING_MODEL: "cardano-embedding",
    })).toThrow(/DATABASE_KNOWLEDGE_URL/);
  });

  it("requires safe promotion server configuration", () => {
    for (const name of ["SEARXNG_BASE_URL", "KNOWLEDGE_PROMOTION_PORT", "KNOWLEDGE_PROMOTION_KEY_ID", "KNOWLEDGE_PROMOTION_KEY"]) {
      const env = workerEnv();
      delete env[name];
      expect(() => parseKnowledgeRuntimeConfig(env)).toThrow(new RegExp(name));
    }
    for (const value of ["ftp://search.example.test/", "https://user:pass@search.example.test/", "https://search.example.test/path", "https://search.example.test/?q=x", "https://search.example.test/#fragment"]) {
      expect(() => parseKnowledgeRuntimeConfig(workerEnv({ SEARXNG_BASE_URL: value }))).toThrow(/SEARXNG_BASE_URL/);
    }
    for (const value of ["0", "01", "1.0", "65536", "not-a-port"]) {
      expect(() => parseKnowledgeRuntimeConfig(workerEnv({ KNOWLEDGE_PROMOTION_PORT: value }))).toThrow(/KNOWLEDGE_PROMOTION_PORT/);
    }
  });

  it("rejects client-only promotion URL configuration", () => {
    expect(() => parseKnowledgeRuntimeConfig(workerEnv({ KNOWLEDGE_PROMOTION_URL: "https://client.example.test/" }))).toThrow(/KNOWLEDGE_PROMOTION_URL/);
  });

  it("keeps admin enqueue configuration database-only", () => {
    expect(parseKnowledgeDatabaseConfig({ DATABASE_KNOWLEDGE_URL: "postgresql://knowledge:password@postgres/vennek" })).toEqual({
      databaseUrl: "postgresql://knowledge:password@postgres/vennek",
    });
    expect(() => parseKnowledgeDatabaseConfig({})).toThrow(/DATABASE_KNOWLEDGE_URL/);
  });
});
