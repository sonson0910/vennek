import { describe, expect, it } from "vitest";
import { parseAgentConfig } from "@vennek/cardano-agent";

const validEnvironment = {
  DATABASE_URL: "postgres://vennek:secret@localhost:5432/vennek",
  VENNEK_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  LITELLM_BASE_URL: "http://localhost:4000",
  LITELLM_API_KEY: "test-key",
  VENNEK_MODEL_FAST: "cardano-fast",
  VENNEK_MODEL_QUALITY: "cardano-quality",
  VENNEK_MODEL_VERIFIER: "cardano-verifier",
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
      },
    });
    expect(config.encryptionKey.length).toBe(32);
  });

  it("rejects an encryption key that is not exactly 32 bytes", () => {
    expect(() =>
      parseAgentConfig({
        ...validEnvironment,
        VENNEK_ENCRYPTION_KEY: Buffer.alloc(16, 7).toString("base64"),
      }),
    ).toThrow(/VENNEK_ENCRYPTION_KEY/);
  });

  it("rejects non-http(s) LiteLLM URLs", () => {
    expect(() =>
      parseAgentConfig({ ...validEnvironment, LITELLM_BASE_URL: "file:///tmp/model" }),
    ).toThrow(/LITELLM_BASE_URL/);
  });
});
