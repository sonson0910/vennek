import { describe, expect, it } from "vitest";
import { parseAgentConfig } from "@vennek/cardano-agent";
import { parseKnowledgePromotionClientConfig } from "../apps/telegram-bot/src/main.js";

const validEnvironment = {
  DATABASE_URL: "postgres://vennek:secret@localhost:5432/vennek",
  VENNEK_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  LITELLM_BASE_URL: "http://localhost:4000",
  LITELLM_API_KEY: "test-key",
  VENNEK_MODEL_FAST: "cardano-fast",
  VENNEK_MODEL_QUALITY: "cardano-quality",
  VENNEK_MODEL_VERIFIER: "cardano-verifier",
  VENNEK_EMBEDDING_MODEL: "cardano-embedding",
};

describe("parseAgentConfig", () => {
  it("parses a valid runtime environment", () => {
    const config = parseAgentConfig(validEnvironment);

    expect(config).toEqual({
      databaseUrl: validEnvironment.DATABASE_URL,
      encryptionKey: expect.any(Buffer),
      liteLlmBaseUrl: new URL(validEnvironment.LITELLM_BASE_URL),
      liteLlmApiKey: validEnvironment.LITELLM_API_KEY,
      models: {
        fast: validEnvironment.VENNEK_MODEL_FAST,
        quality: validEnvironment.VENNEK_MODEL_QUALITY,
        verifier: validEnvironment.VENNEK_MODEL_VERIFIER,
        embedding: validEnvironment.VENNEK_EMBEDDING_MODEL,
      },
    });
    expect(config.encryptionKey.length).toBe(32);
    expect(config.searxngBaseUrl).toBeUndefined();
  });

  it("parses an optional SearXNG origin and rejects unsafe forms", () => {
    const config = parseAgentConfig({ ...validEnvironment, SEARXNG_BASE_URL: "https://search.example.test/" });
    expect(config.searxngBaseUrl).toEqual(new URL("https://search.example.test/"));
    for (const value of [
      "ftp://search.example.test/",
      "https://user:secret@search.example.test/",
      "https://search.example.test/search",
      "https://search.example.test/?q=secret",
      "https://search.example.test/#fragment",
    ]) {
      expect(() => parseAgentConfig({ ...validEnvironment, SEARXNG_BASE_URL: value })).toThrow(/SEARXNG_BASE_URL/);
    }
  });

  it("rejects an encryption key that is not exactly 32 bytes", () => {
    expect(() =>
      parseAgentConfig({
        ...validEnvironment,
        VENNEK_ENCRYPTION_KEY: Buffer.alloc(16, 7).toString("base64"),
      }),
    ).toThrow(/VENNEK_ENCRYPTION_KEY/);
  });

  it("rejects encryption keys with invalid base64 characters", () => {
    expect(() =>
      parseAgentConfig({
        ...validEnvironment,
        VENNEK_ENCRYPTION_KEY: `!${validEnvironment.VENNEK_ENCRYPTION_KEY.slice(1)}`,
      }),
    ).toThrow(/valid base64/);
  });

  it("rejects noncanonical base64 that decodes to 32 bytes", () => {
    expect(() =>
      parseAgentConfig({
        ...validEnvironment,
        VENNEK_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB=",
      }),
    ).toThrow(/VENNEK_ENCRYPTION_KEY/);
  });

  it("trims required values and rejects whitespace-only values", () => {
    const config = parseAgentConfig({
      ...validEnvironment,
      DATABASE_URL: `  ${validEnvironment.DATABASE_URL}  `,
    });
    expect(config.databaseUrl).toBe(validEnvironment.DATABASE_URL);

    expect(() =>
      parseAgentConfig({ ...validEnvironment, LITELLM_API_KEY: " \t" }),
    ).toThrow(/LITELLM_API_KEY is required/);
  });

  it("requires an embedding model", () => {
    const { VENNEK_EMBEDDING_MODEL: _embeddingModel, ...withoutEmbeddingModel } = validEnvironment;
    expect(() => parseAgentConfig(withoutEmbeddingModel)).toThrow(/VENNEK_EMBEDDING_MODEL is required/);
  });

  it("rejects non-http(s) LiteLLM URLs", () => {
    expect(() =>
      parseAgentConfig({ ...validEnvironment, LITELLM_BASE_URL: "file:///tmp/model" }),
    ).toThrow(/LITELLM_BASE_URL/);
  });

  it("rejects malformed LiteLLM URLs", () => {
    expect(() =>
      parseAgentConfig({ ...validEnvironment, LITELLM_BASE_URL: "http://[::1" }),
    ).toThrow(/LITELLM_BASE_URL must be a valid URL/);
  });

  it("rejects LiteLLM URLs containing credentials", () => {
    let thrown: unknown;
    try {
      parseAgentConfig({
        ...validEnvironment,
        LITELLM_BASE_URL: "https://agent:secret@localhost:4000",
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = thrown instanceof Error ? thrown.message : "";
    expect(message).toMatch(/credentials/);
    expect(message).not.toContain("agent");
    expect(message).not.toContain("secret");
  });
});

describe("parseKnowledgePromotionClientConfig", () => {
  const key = Buffer.alloc(32, 7).toString("base64");

  it("trims and parses the promotion origin and identity", () => {
    const config = parseKnowledgePromotionClientConfig({
      KNOWLEDGE_PROMOTION_URL: " https://knowledge.example.test/ ",
      KNOWLEDGE_PROMOTION_KEY_ID: " agent-worker-v1 ",
      KNOWLEDGE_PROMOTION_KEY: ` ${key} `,
    });

    expect(config.origin).toEqual(new URL("https://knowledge.example.test/"));
    expect(config.identity.keyId).toBe("agent-worker-v1");
    expect(config.identity.key).toEqual(Buffer.alloc(32, 7));
  });

  it("requires all promotion settings", () => {
    const valid = {
      KNOWLEDGE_PROMOTION_URL: "https://knowledge.example.test/",
      KNOWLEDGE_PROMOTION_KEY_ID: "agent-worker-v1",
      KNOWLEDGE_PROMOTION_KEY: key,
    };
    for (const name of Object.keys(valid)) {
      const environment = { ...valid, [name]: "  " };
      expect(() => parseKnowledgePromotionClientConfig(environment)).toThrow(new RegExp(`${name} is required`));
    }
  });

  it("delegates promotion URL and identity validation", () => {
    expect(() => parseKnowledgePromotionClientConfig({
      KNOWLEDGE_PROMOTION_URL: "https://knowledge.example.test/path",
      KNOWLEDGE_PROMOTION_KEY_ID: "agent-worker-v1",
      KNOWLEDGE_PROMOTION_KEY: key,
    })).toThrow(/promotion origin/i);
    expect(() => parseKnowledgePromotionClientConfig({
      KNOWLEDGE_PROMOTION_URL: "https://knowledge.example.test/",
      KNOWLEDGE_PROMOTION_KEY_ID: "Agent Worker",
      KNOWLEDGE_PROMOTION_KEY: key,
    })).toThrow(/key ID/i);
  });
});
