import type { QuestionRetrievalInput } from "@vennek/cardano-agent";
import {
  KNOWLEDGE_PROMOTION_PATH,
  parsePromotionIdentity,
  parsePromotionOrigin,
  signPromotionQuestion,
  type PromotionIdentity,
} from "./knowledgePromotionProtocol.js";

export type KnowledgePromotionClientConfig = Readonly<{
  origin: URL;
  identity: PromotionIdentity;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}>;

const DEFAULT_TIMEOUT_MS = 50_000;

export class KnowledgePromotionClient {
  #origin: URL;
  #identity: PromotionIdentity;
  #requestFetch: typeof globalThis.fetch;
  #timeoutMs: number;

  constructor(config: KnowledgePromotionClientConfig) {
    this.#origin = parsePromotionOrigin(config.origin);
    this.#identity = parsePromotionIdentity(
      config.identity.keyId,
      Buffer.from(config.identity.key).toString("base64"),
    );
    const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > DEFAULT_TIMEOUT_MS) {
      throw new Error("Knowledge promotion timeout is invalid.");
    }
    this.#timeoutMs = timeoutMs;
    this.#requestFetch = config.fetch ?? globalThis.fetch;
  }

  async promote(input: QuestionRetrievalInput): Promise<void> {
    const signed = signPromotionQuestion(input.question, this.#identity);
    let response: Response;
    try {
      response = await this.#requestFetch(new URL(KNOWLEDGE_PROMOTION_PATH, this.#origin), {
        method: "POST",
        headers: signed.headers,
        body: signed.body,
        redirect: "error",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      throw new Error("Knowledge promotion request failed.");
    }
    if (response.status !== 204) {
      try {
        await response.body?.cancel();
      } catch {
        // The response status is already a failed request; keep the public error generic.
      }
      throw new Error("Knowledge promotion request failed.");
    }
  }
}
