import { findWalletSecret } from "../security/walletSecrets.js";

const REQUEST_TIMEOUT_MS = 45_000;
const MAX_INPUTS_PER_REQUEST = 64;
const MAX_INPUT_CHARS_PER_REQUEST = 100_000;
const MAX_INPUT_CHARS = 100_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const VECTOR_SIZE = 1_536;
const MAX_EMPTY_READS = 32;

export type EmbeddingResult = { index: number; embedding: number[] };

class EmbeddingFailure extends Error {}

function malformed(): EmbeddingFailure {
  return new EmbeddingFailure("Embedding response malformed");
}

export class EmbeddingClient {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly model: string;

  constructor(baseUrl: URL, apiKey: string, model: string) {
    if (!(baseUrl instanceof URL) || !["http:", "https:"].includes(baseUrl.protocol)) {
      throw new Error("Embedding base URL must use http or https");
    }
    if (baseUrl.username || baseUrl.password) {
      throw new Error("Embedding base URL must not include credentials");
    }
    if (typeof apiKey !== "string" || !apiKey.trim()) throw new Error("Embedding API key is required");
    if (
      typeof model !== "string" ||
      !model ||
      model.trim() !== model ||
      Array.from(model).length > 128 ||
      Buffer.byteLength(model, "utf8") > 128 ||
      /[\p{Cc}\p{Cf}]/u.test(model) ||
      findWalletSecret(model)
    ) throw new Error("Embedding model is invalid");
    const normalizedBaseUrl = new URL(baseUrl.toString());
    if (!normalizedBaseUrl.pathname.endsWith("/")) normalizedBaseUrl.pathname += "/";
    this.endpoint = new URL("v1/embeddings", normalizedBaseUrl).toString();
    this.apiKey = apiKey.trim();
    this.model = model;
  }

  async embed(input: string[], signal?: AbortSignal): Promise<EmbeddingResult[]> {
    ensureActive(signal);
    validateInput(input);
    const output: EmbeddingResult[] = [];
    let start = 0;
    while (start < input.length) {
      ensureActive(signal);
      const batch: string[] = [];
      let characters = 0;
      while (
        start + batch.length < input.length &&
        batch.length < MAX_INPUTS_PER_REQUEST
      ) {
        const value = input[start + batch.length]!;
        if (batch.length > 0 && characters + value.length > MAX_INPUT_CHARS_PER_REQUEST) break;
        batch.push(value);
        characters += value.length;
      }
      const embeddings = await this.embedBatch(batch, signal);
      output.push(...embeddings.map((item, index) => ({
        index: start + index,
        embedding: item.embedding,
      })));
      start += batch.length;
    }
    return output;
  }

  private async embedBatch(input: string[], callerSignal?: AbortSignal): Promise<EmbeddingResult[]> {
    let response: Response;
    ensureActive(callerSignal);
    try {
      const requestSignal = callerSignal
        ? AbortSignal.any([callerSignal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
        : AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: this.model, input }),
        redirect: "error",
        signal: requestSignal,
      });
    } catch {
      throw new Error("Embedding request failed");
    }
    if (!response.ok) {
      await cancelResponseBody(response);
      throw new Error("Embedding request failed");
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
    if (contentType !== "application/json") {
      await cancelResponseBody(response);
      throw new Error("Embedding response content-type invalid");
    }

    let body: string;
    try {
      body = await readBoundedBody(response);
    } catch (error) {
      await cancelResponseBody(response);
      if (error instanceof EmbeddingFailure) throw error;
      throw malformed();
    }
    ensureActive(callerSignal);
    return parseResponse(body, input.length);
  }
}

function ensureActive(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("Embedding request aborted.");
}

function validateInput(input: string[]): void {
  if (!Array.isArray(input) || input.length === 0) throw new Error("Embedding input must not be empty");
  for (const value of input) {
    if (typeof value !== "string" || !value.trim()) throw new Error("Embedding input items must not be empty");
    if (value.length > MAX_INPUT_CHARS) throw new Error("Embedding input is too large");
  }
}

async function readBoundedBody(response: Response): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength.trim())) throw malformed();
    const length = Number(contentLength);
    if (!Number.isSafeInteger(length)) throw malformed();
    if (length > MAX_RESPONSE_BYTES) throw new EmbeddingFailure("Embedding response too large");
  }
  if (!response.body) throw malformed();
  const reader = response.body.getReader();
  const bytes = new Uint8Array(MAX_RESPONSE_BYTES);
  let total = 0;
  let emptyReads = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw malformed();
      if (value.byteLength === 0) {
        emptyReads += 1;
        if (emptyReads >= MAX_EMPTY_READS) throw malformed();
        continue;
      }
      emptyReads = 0;
      if (total + value.byteLength > MAX_RESPONSE_BYTES) {
        throw new EmbeddingFailure("Embedding response too large");
      }
      bytes.set(value, total);
      total += value.byteLength;
    }
  } catch (error) {
    try { await reader.cancel(); } catch { /* preserve the safe error */ }
    throw error;
  } finally {
    reader.releaseLock();
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, total));
  } catch {
    throw malformed();
  }
}

async function cancelResponseBody(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch { /* best effort */ }
}

function parseResponse(body: string, expectedCount: number): EmbeddingResult[] {
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { throw malformed(); }
  if (!isRecord(parsed) || !Array.isArray(parsed.data) || parsed.data.length !== expectedCount) throw malformed();
  return parsed.data.map((candidate, index) => {
    if (!isRecord(candidate) || candidate.index !== index || !Array.isArray(candidate.embedding)) throw malformed();
    if (candidate.embedding.length !== VECTOR_SIZE) throw malformed();
    for (let vectorIndex = 0; vectorIndex < VECTOR_SIZE; vectorIndex += 1) {
      if (!(vectorIndex in candidate.embedding)) throw malformed();
    }
    const embedding = candidate.embedding.map((value) => {
      if (typeof value !== "number" || !Number.isFinite(value) || !Number.isFinite(Math.fround(value))) throw malformed();
      return value;
    });
    return { index, embedding };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
