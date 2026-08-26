import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  requestPublicHttps,
  type PublicHttpsResponse
} from "@vennek/cardano-governance-skills";
import {
  REQUIRED_OFFICIAL_SOURCE_IDS,
  validateSourceRegistryEnvelope,
  urlMatchesSourceScope,
  validateSourceRegistry,
  type SourceRegistryEntry
} from "@vennek/cardano-agent";

const CONFIG_URL = new URL("../config/cardano-sources.json", import.meta.url);
export const LIVE_SOURCE_TIMEOUT_MS = 8_000;
export const LIVE_OVERALL_TIMEOUT_MS = 45_000;
const LIVE_WORKERS = 4;
const REQUIRED_REFRESH_POLICIES: Record<(typeof REQUIRED_OFFICIAL_SOURCE_IDS)[number], "hourly" | "daily"> = {
  "cardano-docs": "daily",
  "cardano-org": "daily",
  "cardano-developer-portal": "daily",
  "iog-research": "daily",
  "iog-github": "daily",
  "cardano-foundation": "daily",
  "cardano-foundation-github": "daily",
  emurgo: "daily",
  intersect: "hourly",
  "intersect-github": "hourly",
  "cardano-cips": "hourly",
  "project-catalyst": "hourly",
  govtool: "hourly",
  "cardano-node-releases": "hourly",
  "cardano-ledger": "daily",
  "ouroboros-consensus": "daily",
  plutus: "daily",
  aiken: "daily"
};
const SUPPORTED_CONTENT_TYPES = new Set([
  "application/atom+xml",
  "application/json",
  "application/pdf",
  "application/rss+xml",
  "application/xhtml+xml",
  "application/xml",
  "text/html",
  "text/markdown",
  "text/plain",
  "text/xml"
]);

type SourceConfig = { official: unknown[]; community: unknown[] };

export type LiveSourceStatus = "healthy" | "degraded-with-fallback" | "failed";

export type LiveCheckResult = {
  id: string;
  status: LiveSourceStatus;
  blocking: boolean;
  reason?: string;
  fallbackId?: string;
};
type LiveRequest = typeof requestPublicHttps;

export function readSourceConfig(): SourceConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(CONFIG_URL, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Unable to parse source registry JSON: ${error instanceof Error ? error.message : "invalid JSON"}`);
  }
  return validateSourceRegistryEnvelope(parsed);
}

export function validateSourceConfig(config: SourceConfig): SourceRegistryEntry[] {
  const entries = validateSourceRegistry([...config.official, ...config.community]);
  validateRequiredRefreshPolicies(entries);
  return entries;
}

export function validateRequiredRefreshPolicies(entries: SourceRegistryEntry[]): void {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  for (const [id, refresh] of Object.entries(REQUIRED_REFRESH_POLICIES)) {
    const entry = byId.get(id);
    if (!entry) {
      throw new Error(`Required source ${id} is missing.`);
    }
    if (entry.trustTier !== "official" || entry.refresh !== refresh) {
      throw new Error(`Required source ${id} must be official and refresh ${refresh}.`);
    }
  }
}

export async function checkLive(
  entry: SourceRegistryEntry,
  signal: AbortSignal = AbortSignal.timeout(LIVE_SOURCE_TIMEOUT_MS),
  requestImpl: LiveRequest = requestPublicHttps
): Promise<string | undefined> {
  if (entry.kind === "stackexchange") {
    return checkStackExchangeLive(entry, signal, requestImpl);
  }
  if (!urlMatchesSourceScope(entry.url, entry)) {
    return "URL rejected (outside the declared source scope).";
  }

  const head = await requestLive(entry, "HEAD", signal, requestImpl);
  const headOk = isAcceptedResponse(head.response);
  head.response?.cancel();
  if (headOk) {
    return undefined;
  }

  const headReason = head.error
    ? `HEAD failed (${safeReason(head.error)})`
    : head.response && !isSuccessful(head.response.statusCode)
      ? `HEAD returned HTTP ${head.response.statusCode}`
      : "HEAD returned an unsupported content type";
  const get = await requestLive(entry, "GET", signal, requestImpl, { Range: "bytes=0-0" });
  const getOk = isAcceptedResponse(get.response);
  get.response?.cancel();
  if (getOk) {
    return undefined;
  }
  const getReason = get.error
    ? safeReason(get.error)
    : get.response && !isSuccessful(get.response.statusCode)
      ? `HTTP ${get.response.statusCode}`
      : "unsupported content type";
  return `${headReason}; GET fallback failed (${getReason}).`;
}

export async function runLiveValidation(
  entries: SourceRegistryEntry[],
  input: { signal?: AbortSignal; sourceTimeoutMs?: number; overallTimeoutMs?: number; request?: LiveRequest } = {}
): Promise<LiveCheckResult[]> {
  const overallTimeout = AbortSignal.timeout(input.overallTimeoutMs ?? LIVE_OVERALL_TIMEOUT_MS);
  const overallSignal = input.signal ? AbortSignal.any([input.signal, overallTimeout]) : overallTimeout;
  const rawResults: Array<{ id: string; reason?: string }> = new Array(entries.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex++;
      if (index >= entries.length) {
        return;
      }
      const entry = entries[index];
      const sourceController = new AbortController();
      const abortSource = () => sourceController.abort(overallSignal.reason);
      const sourceTimeout = setTimeout(
        () => sourceController.abort(new DOMException("Source deadline exceeded", "TimeoutError")),
        input.sourceTimeoutMs ?? LIVE_SOURCE_TIMEOUT_MS
      );
      overallSignal.addEventListener("abort", abortSource, { once: true });
      if (overallSignal.aborted) {
        abortSource();
      }
      try {
        const reason = await checkLive(entry, sourceController.signal, input.request);
        rawResults[index] = { id: entry.id, ...(reason ? { reason } : {}) };
      } catch (error) {
        rawResults[index] = { id: entry.id, reason: safeReason(error) };
      } finally {
        clearTimeout(sourceTimeout);
        overallSignal.removeEventListener("abort", abortSource);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(LIVE_WORKERS, entries.length) }, () => worker()));
  const rawById = new Map(rawResults.map((result) => [result.id, result] as const));
  return entries.map((entry) => resolveLiveResult(entry, rawById));
}

export function liveValidationSucceeded(results: LiveCheckResult[]): boolean {
  return results.length > 0 && results.every((result) => !result.blocking || result.status !== "failed");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function requestLive(
  entry: SourceRegistryEntry,
  method: "HEAD" | "GET",
  signal: AbortSignal,
  requestImpl: LiveRequest,
  headers?: Record<string, string>
): Promise<{ response?: PublicHttpsResponse; error?: unknown }> {
  try {
    return {
      response: await requestImpl({
        url: entry.url,
        allowedDomains: entry.allowedDomains,
        method,
        headers,
        signal
      })
    };
  } catch (error) {
    return { error };
  }
}

async function checkStackExchangeLive(entry: SourceRegistryEntry, signal: AbortSignal, requestImpl: LiveRequest): Promise<string | undefined> {
  const url = new URL("https://api.stackexchange.com/2.3/questions");
  url.search = new URLSearchParams({ filter: "default", pagesize: "1", site: "cardano" }).toString();
  if (!urlMatchesSourceScope(url.toString(), entry)) {
    return "URL rejected (outside the declared source scope).";
  }
  try {
    const response = await requestImpl({
      url: url.toString(),
      allowedDomains: ["api.stackexchange.com"],
      method: "GET",
      signal
    });
    const accepted = isAcceptedResponse(response);
    response.cancel();
    if (accepted) {
      return undefined;
    }
    return isSuccessful(response.statusCode) ? "unsupported content type" : `HTTP ${response.statusCode}`;
  } catch (error) {
    return safeReason(error);
  }
}

function resolveLiveResult(
  entry: SourceRegistryEntry,
  rawById: ReadonlyMap<string, { id: string; reason?: string }>
): LiveCheckResult {
  const raw = rawById.get(entry.id)!;
  const blocking = REQUIRED_OFFICIAL_SOURCE_IDS.includes(entry.id as (typeof REQUIRED_OFFICIAL_SOURCE_IDS)[number]);
  if (!raw.reason) {
    return { id: entry.id, status: "healthy", blocking };
  }
  const fallbackId = entry.liveFallbackIds?.find((id) => !rawById.get(id)?.reason);
  return fallbackId
    ? { id: entry.id, status: "degraded-with-fallback", blocking, fallbackId, reason: raw.reason }
    : { id: entry.id, status: "failed", blocking, reason: raw.reason };
}

function isAcceptedResponse(response?: PublicHttpsResponse): boolean {
  return Boolean(response && isSuccessful(response.statusCode) && contentType(response) !== undefined);
}

function isSuccessful(statusCode: number): boolean {
  return statusCode >= 200 && statusCode < 300;
}

function contentType(response?: PublicHttpsResponse): string | undefined {
  const value = response?.headers["content-type"];
  const text = Array.isArray(value) ? value[0] : value;
  const type = typeof text === "string" ? text.split(";", 1)[0]?.trim().toLowerCase() : undefined;
  return type && SUPPORTED_CONTENT_TYPES.has(type) ? type : undefined;
}

function safeReason(error: unknown): string {
  if (error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return "timeout";
  }
  if (error instanceof Error && error.message.includes("Credentials")) {
    return "credentials are not accepted";
  }
  if (error instanceof Error && error.message.includes("https")) {
    return "HTTPS is required";
  }
  return "network or URL validation error";
}

function printRequiredCoverage(config: SourceConfig): string[] {
  const officialIds = new Set(config.official.map((entry) => isRecord(entry) && typeof entry.id === "string" ? entry.id : ""));
  const missing: string[] = [];
  for (const id of REQUIRED_OFFICIAL_SOURCE_IDS) {
    const covered = officialIds.has(id);
    console.log(`Required source ${id}: ${covered ? "covered" : "MISSING"}`);
    if (!covered) {
      missing.push(id);
    }
  }
  return missing;
}

async function main(): Promise<void> {
  try {
    const config = readSourceConfig();
    const missing = printRequiredCoverage(config);
    const entries = validateSourceConfig(config);
    console.log(`Official source coverage: ${REQUIRED_OFFICIAL_SOURCE_IDS.length - missing.length}/${REQUIRED_OFFICIAL_SOURCE_IDS.length}`);
    console.log(`Community sources: ${config.community.length}`);
    console.log(`Validated registry entries: ${entries.length}`);
    if (missing.length > 0) {
      throw new Error(`Required source coverage is missing: ${missing.join(", ")}.`);
    }

    if (process.argv.includes("--live")) {
      const results = await runLiveValidation(entries);
      for (const result of results) {
        const status = result.status === "healthy"
          ? "healthy"
          : result.status === "degraded-with-fallback"
            ? `degraded-with-fallback (${result.fallbackId}): ${result.reason ?? "failed"}`
            : `failed: ${result.reason ?? "unknown failure"}`;
        console.log(`${result.id}: ${status}`);
      }
      if (!liveValidationSucceeded(results)) {
        process.exitCode = 1;
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Source registry validation failed.");
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main();
}
