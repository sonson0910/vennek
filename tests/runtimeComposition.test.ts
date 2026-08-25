import { describe, expect, it, vi } from "vitest";
import type {
  AgentConfig,
  AnswerCompletionInput,
  CompletionOutput,
  EmbeddingProvider,
} from "@vennek/cardano-agent";
import { createRuntimeAgentDependencies, parseAgentWorkerConfig } from "../apps/telegram-bot/src/main.js";

function config(): AgentConfig {
  return {
    databaseUrl: "postgresql://vennek.test/vennek",
    encryptionKey: Buffer.alloc(32),
    liteLlmBaseUrl: new URL("https://litellm.example.test"),
    liteLlmApiKey: "test-key",
    models: {
      fast: "cardano-fast",
      quality: "cardano-quality",
      verifier: "cardano-verifier",
      embedding: "cardano-embedding",
    },
  };
}

describe("runtime agent composition", () => {
  it("maps retrieval, freezes configured aliases, canonicalizes provider models, and records only usage metadata", async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const embedder: EmbeddingProvider = { embed: vi.fn().mockResolvedValue([]) };
    const retrieve = vi.fn().mockResolvedValue([]);
    const completionInputs: AnswerCompletionInput[] = [];
    const complete = vi.fn(async (input: AnswerCompletionInput): Promise<CompletionOutput> => {
      completionInputs.push(input);
      try { input.model = "mutated-model"; } catch { /* frozen request */ }
      try { input.messages[0]!.content = "mutated-message"; } catch { /* frozen message */ }
      return {
        text: "provider response",
        model: "physical-provider-model",
        promptTokens: 11,
        completionTokens: 3,
      };
    });
    const dependencies = createRuntimeAgentDependencies(db as never, config(), { embedder, complete, retrieve });

    await dependencies.retrieve({ question: "Cardano?", language: "vi" });
    expect(retrieve).toHaveBeenCalledWith(
      { query: "Cardano?", language: "vi", embeddingModel: "cardano-embedding", cachePolicy: "stable" },
      { db, embedder },
    );
    expect(dependencies.models).toEqual({ fast: "cardano-fast", quality: "cardano-quality", verifier: "cardano-verifier" });
    expect(Object.isFrozen(dependencies.models)).toBe(true);
    expect(dependencies.discover).toBeUndefined();

    const quality = await dependencies.complete({ model: "cardano-quality", messages: [], temperature: 0 });
    const verifier = await dependencies.complete({ model: "cardano-verifier", messages: [], temperature: 0 });
    expect(complete.mock.calls.map(([input]) => input.model)).toEqual(["cardano-quality", "cardano-verifier"]);
    expect(completionInputs.map((input) => input.model)).toEqual(["cardano-quality", "cardano-verifier"]);
    expect(completionInputs.every((input) => Object.isFrozen(input) && Object.isFrozen(input.messages))).toBe(true);
    expect(quality).toEqual({ text: "provider response", model: "cardano-quality", promptTokens: 11, completionTokens: 3 });
    expect(verifier.model).toBe("cardano-verifier");

    await dependencies.recordUsage("123", { model: "cardano-quality", promptTokens: 11, completionTokens: 3, latencyMs: 7 });
    expect(db.query).toHaveBeenCalledOnce();
    const [sql, values] = db.query.mock.calls[0]!;
    expect(sql).toMatch(/INSERT INTO usage_ledger/i);
    expect(sql).toMatch(/telegram_user_id.*model.*prompt_tokens.*completion_tokens.*latency_ms/is);
    expect(values).toEqual(["123", "cardano-quality", 11, 3, 7]);
    expect(values).toHaveLength(5);
  });

  it("passes only question and language to optional discovery", async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const embedder: EmbeddingProvider = { embed: vi.fn().mockResolvedValue([]) };
    const discover = vi.fn().mockResolvedValue(undefined);
    const dependencies = createRuntimeAgentDependencies(db as never, config(), { embedder, discover });

    await dependencies.discover?.({ question: "What is Cardano?", language: "en" });

    expect(discover).toHaveBeenCalledOnce();
    expect(discover).toHaveBeenCalledWith({ question: "What is Cardano?", language: "en" });
  });

  it("requires private extractor and dedicated model aliases only for the agent worker", () => {
    const key = Buffer.alloc(32, 7).toString("base64");
    const environment = {
      DATABASE_URL: "postgresql://vennek.test/vennek",
      VENNEK_ENCRYPTION_KEY: key,
      LITELLM_BASE_URL: "http://litellm.test/",
      LITELLM_API_KEY: "test-key",
      VENNEK_MODEL_FAST: "cardano-fast",
      VENNEK_MODEL_QUALITY: "cardano-quality",
      VENNEK_MODEL_VERIFIER: "cardano-verifier",
      VENNEK_EMBEDDING_MODEL: "cardano-embedding",
      PRIVATE_DOCUMENT_EXTRACTOR_URL: "http://private-document-extractor:8083/",
      PRIVATE_DOCUMENT_EXTRACTOR_TOKEN: Buffer.alloc(32, 8).toString("base64url"),
      VENNEK_PRIVATE_MODEL_QUALITY: "cardano-private-quality",
      VENNEK_PRIVATE_MODEL_VERIFIER: "cardano-private-verifier",
    };

    expect(parseAgentWorkerConfig(environment)).toMatchObject({
      privateDocumentExtractorUrl: new URL(environment.PRIVATE_DOCUMENT_EXTRACTOR_URL),
      privateDocumentExtractorToken: environment.PRIVATE_DOCUMENT_EXTRACTOR_TOKEN,
      privateModels: { quality: environment.VENNEK_PRIVATE_MODEL_QUALITY, verifier: environment.VENNEK_PRIVATE_MODEL_VERIFIER },
    });
    for (const url of [
      "http://PRIVATE-DOCUMENT-EXTRACTOR:8083/",
      "http://127.0.0.1:8083/",
      "http://169.254.169.254:8083/",
      "https://private-document-extractor/",
      "http://user:secret@private-document-extractor/",
      "http://private-document-extractor/path",
      "http://private-document-extractor/?query=secret",
      "http://private-document-extractor/#fragment",
    ]) {
      expect(() => parseAgentWorkerConfig({ ...environment, PRIVATE_DOCUMENT_EXTRACTOR_URL: url })).toThrow();
    }
    expect(() => parseAgentWorkerConfig({ ...environment, PRIVATE_DOCUMENT_EXTRACTOR_TOKEN: `${environment.PRIVATE_DOCUMENT_EXTRACTOR_TOKEN}=`, })).toThrow();
    expect(() => parseAgentWorkerConfig({ ...environment, VENNEK_PRIVATE_MODEL_QUALITY: "cardano-quality" })).toThrow();
    expect(() => parseAgentWorkerConfig({ ...environment, VENNEK_PRIVATE_MODEL_VERIFIER: environment.VENNEK_PRIVATE_MODEL_QUALITY })).toThrow();
    expect(() => parseAgentWorkerConfig({ ...environment, VENNEK_PRIVATE_MODEL_VERIFIER: `cardano-private-${"a".repeat(128)}` })).toThrow();
  });
});
