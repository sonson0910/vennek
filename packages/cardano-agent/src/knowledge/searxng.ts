import { readResponseBytesLimited } from "@vennek/cardano-governance-skills";

const SEARCH_TIMEOUT_MS = 5_000;
export const SEARXNG_MAX_QUERY_CODE_POINTS = 8_192;
export const SEARXNG_MAX_QUERY_BYTES = 32 * 1_024;
const MAX_QUERY_UTF16_UNITS = SEARXNG_MAX_QUERY_CODE_POINTS * 2;
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_RESULTS = 10;
const MAX_TITLE_CHARS = 300;
const MAX_CONTENT_CHARS = 1_000;
const MAX_URL_CHARS = 2_048;

export type SearxngFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;
export type SearxngResult = {
  title: string;
  content: string;
  url: string;
};

export class SearxngClient {
  private readonly baseUrl: URL;
  private readonly fetchImpl: SearxngFetch;
  private readonly timeoutMs: number;

  constructor(baseUrl: URL, fetchImpl: SearxngFetch = (input, init) => fetch(input, init), timeoutMs = SEARCH_TIMEOUT_MS) {
    if (!(baseUrl instanceof URL) || !["http:", "https:"].includes(baseUrl.protocol)) {
      throw new Error("SearXNG base URL must use http or https");
    }
    if (
      baseUrl.username ||
      baseUrl.password ||
      baseUrl.pathname !== "/" ||
      baseUrl.search ||
      baseUrl.hash
    ) {
      throw new Error("SearXNG base URL must be an origin without credentials or path");
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > SEARCH_TIMEOUT_MS) {
      throw new Error("SearXNG timeout must be an integer from 1 to 5,000 milliseconds");
    }
    this.baseUrl = new URL(baseUrl.toString());
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async search(query: string, callerSignal?: AbortSignal): Promise<SearxngResult[]> {
    const normalizedQuery = normalizeQuery(query);
    callerSignal?.throwIfAborted();
    const endpoint = new URL("/search", this.baseUrl);
    endpoint.searchParams.set("q", normalizedQuery);
    endpoint.searchParams.set("format", "json");
    endpoint.searchParams.set("safesearch", "1");
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, AbortSignal.timeout(this.timeoutMs)])
      : AbortSignal.timeout(this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(endpoint.toString(), {
        method: "GET",
        headers: { accept: "application/json", "accept-encoding": "identity" },
        redirect: "error",
        signal,
      });
    } catch {
      throw new Error("SearXNG request failed");
    }
    if (!response.ok) {
      await cancelResponse(response);
      throw new Error("SearXNG request failed");
    }
    try {
      const { bytes } = await readResponseBytesLimited(response, MAX_RESPONSE_BYTES, ["application/json"], signal);
      signal.throwIfAborted();
      return parseResults(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      await cancelResponse(response);
      throw new Error(signal.aborted ? "SearXNG request failed" : "SearXNG response invalid");
    }
  }
}

function normalizeQuery(value: string): string {
  if (typeof value !== "string") throw new Error("SearXNG query is required");
  const query = value.normalize("NFC").trim();
  if (
    !query ||
    query.length > MAX_QUERY_UTF16_UNITS ||
    Array.from(query).length > SEARXNG_MAX_QUERY_CODE_POINTS ||
    Buffer.byteLength(query, "utf8") > SEARXNG_MAX_QUERY_BYTES ||
    /[\u0000-\u001f\u007f]/.test(query)
  ) {
    throw new Error("SearXNG query is invalid");
  }
  return query;
}

function parseResults(body: string): SearxngResult[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("SearXNG response invalid");
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.results)) {
    throw new Error("SearXNG response invalid");
  }
  return parsed.results.slice(0, MAX_RESULTS).flatMap((candidate) => {
    if (!isRecord(candidate)) return [];
    const title = boundedText(candidate.title, MAX_TITLE_CHARS);
    const content = candidate.content === undefined || candidate.content === null
      ? ""
      : boundedContent(candidate.content, MAX_CONTENT_CHARS);
    const url = boundedUrl(candidate.url);
    return title && content !== undefined && url ? [{ title, content, url }] : [];
  });
}

function boundedText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  const normalized = value.normalize("NFC").trim();
  return normalized ? Array.from(normalized).slice(0, maxChars).join("") : undefined;
}

function boundedContent(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string" || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) return undefined;
  const normalized = value.normalize("NFC").replace(/\s+/gu, " ").trim();
  return normalized ? Array.from(normalized).slice(0, maxChars).join("") : "";
}

function boundedUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_URL_CHARS || /[\u0000-\u001f\u007f]/.test(value)) {
    return undefined;
  }
  return value.trim() || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function cancelResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Preserve the sanitized validation error.
  }
}
