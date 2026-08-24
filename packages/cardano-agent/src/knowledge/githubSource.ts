import {
  readResponseBytesLimited,
  requestPublicHttps,
  type PublicHttpsLookup,
  type PublicHttpsRequest
} from "@vennek/cardano-governance-skills";
import {
  KnowledgeRepository,
  type GithubEndpoint,
  type GithubEndpointState,
  type GithubEndpointStateUpdate,
  type RepositoryOperationOptions
} from "./knowledgeRepository.js";
import { extractContent } from "./extractContent.js";
import { urlMatchesSourceScope, validateSourceRegistry, type SourceRegistryEntry } from "./sourceRegistry.js";

const MAX_GITHUB_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_GITHUB_README_BYTES = 4 * 1024 * 1024;
const MAX_TOKEN_LENGTH = 1_024;
const MAX_DEFER_MS = 24 * 60 * 60 * 1_000;
const GITHUB_STATE_OPERATION_TIMEOUT_MS = 5_000;

type GithubEndpointPlan = {
  endpoint: GithubEndpoint;
  requestUrl: string;
  canonicalUrl: string;
};

export type GithubSourceInput = {
  entry: SourceRegistryEntry;
  repository: KnowledgeRepository;
  signal: AbortSignal;
  now?: Date;
  lookup?: PublicHttpsLookup;
  request?: PublicHttpsRequest;
  token?: string;
};

export type GithubSourceDocument = {
  endpoint: GithubEndpoint;
  canonicalUrl: string;
  title: string;
  text: string;
  publishedAt?: Date;
};

export type GithubSourceResult = {
  documents: GithubSourceDocument[];
  unchanged: number;
  deferredUntil?: Date;
  commitState?: (options?: RepositoryOperationOptions) => Promise<boolean>;
};

type GithubResponseHeaders = Record<string, string | string[] | undefined>;

export async function fetchGithubSource(input: GithubSourceInput): Promise<GithubSourceResult> {
  input.signal.throwIfAborted();
  const [validated] = validateSourceRegistry([input.entry]);
  if (validated.kind !== "github") {
    throw new Error("GitHub retrieval requires a github source registry entry.");
  }
  if (input.token !== undefined && (
    typeof input.token !== "string" ||
    input.token.length === 0 ||
    input.token.length > MAX_TOKEN_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(input.token)
  )) {
    throw new Error("GitHub token is invalid.");
  }
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("Retrieval time must be a valid date.");
  const plans = buildEndpointPlan(validated);
  await input.repository.ensureSource(validated);

  const states = new Map<GithubEndpoint, GithubEndpointState | null>();
  for (const plan of plans) {
    states.set(plan.endpoint, await input.repository.getGithubEndpointState(validated.id, plan.endpoint));
  }
  const storedDeferral = plans
    .map((plan) => states.get(plan.endpoint)?.retryAt)
    .filter((value): value is string => value !== undefined)
    .map((value) => clampDate(new Date(value), now))
    .filter((value) => value.getTime() > now.getTime())
    .sort((left, right) => right.getTime() - left.getTime())[0];
  if (storedDeferral) {
    return { documents: [], unchanged: 0, deferredUntil: storedDeferral };
  }

  const documents: GithubSourceDocument[] = [];
  const stateUpdates: GithubEndpointStateUpdate[] = [];
  let unchanged = 0;
  for (const plan of plans) {
    const state = states.get(plan.endpoint) ?? null;
    if (!urlMatchesSourceScope(plan.requestUrl, validated)) {
      throw new Error("GitHub endpoint is outside the validated source scope.");
    }
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "user-agent": "vennek-cardano-agent/1"
    };
    if (input.token !== undefined) headers.authorization = `Bearer ${input.token}`;
    if (state?.etag !== undefined) headers["if-none-match"] = state.etag;
    const endpointSignal = AbortSignal.any([input.signal, AbortSignal.timeout(8_000)]);
    const response = await requestPublicHttps({
      url: plan.requestUrl,
      allowedDomains: validated.allowedDomains,
      signal: endpointSignal,
      method: "GET",
      headers,
      lookup: input.lookup,
      request: input.request
    });
    const rate = rateLimitInfo(response.headers, now);
    const retryAfter = parseRetryAfter(responseHeader(response.headers, "retry-after"), now);
    if (isRateLimited(response.statusCode, rate.remaining, retryAfter)) {
      response.cancel();
      const deferred = await deferEndpoint(
        input.repository,
        validated.id,
        plan.endpoint,
        state,
        response.headers,
        now,
        { signal: input.signal, timeoutMs: GITHUB_STATE_OPERATION_TIMEOUT_MS },
      );
      return {
        documents: [],
        unchanged: 0,
        deferredUntil: deferred
      };
    }
    if (response.statusCode === 304) {
      response.cancel();
      unchanged += 1;
      stateUpdates.push({
        sourceId: validated.id,
        endpoint: plan.endpoint,
        expectedState: state,
        nextState: successState(state, response.headers, now)
      });
      continue;
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      response.cancel();
      throw new Error(`GitHub endpoint returned HTTP ${response.statusCode}.`);
    }

    const { bytes } = await readResponseBytesLimited(
      response,
      MAX_GITHUB_RESPONSE_BYTES,
      ["application/json"],
      endpointSignal,
    );
    const extracted = plan.endpoint === "readme"
      ? await extractContent({ mime: "text/markdown", bytes: decodeReadme(bytes) })
      : await extractContent({ mime: "application/json", bytes });
    documents.push({
      endpoint: plan.endpoint,
      canonicalUrl: plan.canonicalUrl,
      title: plan.endpoint === "readme" ? extracted.title : `${validated.github.owner} GitHub ${plan.endpoint}`,
      text: extracted.text,
      ...(extracted.publishedAt ? { publishedAt: extracted.publishedAt } : {})
    });
    stateUpdates.push({
      sourceId: validated.id,
      endpoint: plan.endpoint,
      expectedState: state,
      nextState: successState(state, response.headers, now)
    });
  }
  const commitState = stateUpdates.length === 0
    ? undefined
    : async (options?: RepositoryOperationOptions) => input.repository.compareAndSetGithubEndpointStates(stateUpdates, options);
  return { documents, unchanged, ...(commitState ? { commitState } : {}) };
}

function buildEndpointPlan(entry: Extract<SourceRegistryEntry, { kind: "github" }>): GithubEndpointPlan[] {
  const owner = entry.github.owner;
  if (entry.github.repository === undefined) {
    const requestUrl = `https://api.github.com/orgs/${owner}`;
    return [{ endpoint: "organization", requestUrl, canonicalUrl: `https://github.com/${owner}` }];
  }
  const repository = entry.github.repository;
  const base = `https://api.github.com/repos/${owner}/${repository}`;
  return [
    { endpoint: "repository", requestUrl: base, canonicalUrl: `https://github.com/${owner}/${repository}` },
    { endpoint: "readme", requestUrl: `${base}/readme`, canonicalUrl: `https://github.com/${owner}/${repository}#readme` },
    { endpoint: "releases", requestUrl: `${base}/releases?per_page=100&page=1`, canonicalUrl: `https://github.com/${owner}/${repository}/releases` },
    { endpoint: "tags", requestUrl: `${base}/tags?per_page=100&page=1`, canonicalUrl: `https://github.com/${owner}/${repository}/tags` }
  ];
}

function responseHeader(headers: GithubResponseHeaders, name: string): string | undefined {
  const value = headers[name.toLowerCase()] ?? Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
  return Array.isArray(value) ? value[0] : value;
}

function safeEtag(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 && value.length <= 256 && /^[\x20-\x7e]+$/.test(value) ? value : undefined;
}

function nonNegativeInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value.trim())) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function rateLimitInfo(headers: GithubResponseHeaders, now: Date): { remaining?: number; resetAt?: Date } {
  const remaining = nonNegativeInteger(responseHeader(headers, "x-ratelimit-remaining"));
  const resetSeconds = nonNegativeInteger(responseHeader(headers, "x-ratelimit-reset"));
  return {
    remaining,
    resetAt: resetSeconds === undefined
      ? undefined
      : new Date(Math.min(resetSeconds, (now.getTime() + MAX_DEFER_MS) / 1_000) * 1_000)
  };
}

function isRateLimited(statusCode: number, remaining: number | undefined, retryAfter: Date | undefined): boolean {
  return statusCode === 429 || (
    statusCode === 403 &&
    (remaining === 0 || retryAfter !== undefined)
  );
}

function parseRetryAfter(value: string | undefined, now: Date): Date | undefined {
  if (value === undefined) return undefined;
  const seconds = nonNegativeInteger(value);
  if (seconds !== undefined) {
    const boundedSeconds = Math.min(seconds, MAX_DEFER_MS / 1_000);
    return new Date(now.getTime() + boundedSeconds * 1_000);
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? clampDate(parsed, now) : undefined;
}

function clampDate(value: Date, now: Date): Date {
  const timestamp = value.getTime();
  return new Date(Number.isFinite(timestamp)
    ? Math.min(now.getTime() + MAX_DEFER_MS, Math.max(now.getTime(), timestamp))
    : now.getTime() + MAX_DEFER_MS);
}

async function deferEndpoint(
  repository: KnowledgeRepository,
  sourceId: string,
  endpoint: GithubEndpoint,
  expected: GithubEndpointState | null,
  headers: GithubResponseHeaders,
  now: Date,
  options: RepositoryOperationOptions,
): Promise<Date> {
  const rate = rateLimitInfo(headers, now);
  const retryAt = parseRetryAfter(responseHeader(headers, "retry-after"), now);
  const resetAt = rate.resetAt && Number.isFinite(rate.resetAt.getTime()) ? clampDate(rate.resetAt, now) : undefined;
  const candidates = [retryAt?.getTime(), resetAt?.getTime()].filter((value): value is number => value !== undefined);
  const deferred = new Date(candidates.length > 0 ? Math.max(...candidates) : now.getTime() + MAX_DEFER_MS);
  const next: GithubEndpointState = {
    ...expected,
    checkedAt: now.toISOString(),
    retryAt: deferred.toISOString()
  };
  if (resetAt) next.rateLimitResetAt = resetAt.toISOString();
  else delete next.rateLimitResetAt;
  if (rate.remaining !== undefined) next.rateLimitRemaining = rate.remaining;
  const persisted = await repository.compareAndSetGithubEndpointState(sourceId, endpoint, expected, next, options);
  if (!persisted) {
    const current = await repository.getGithubEndpointState(sourceId, endpoint, options);
    const currentRetryAt = futureRetryAt(current, now);
    if (currentRetryAt) return currentRetryAt;
    throw new Error("GitHub rate-limit state concurrency conflict.");
  }
  return deferred;
}

function futureRetryAt(state: GithubEndpointState | null, now: Date): Date | undefined {
  if (!state?.retryAt) return undefined;
  const retryAt = clampDate(new Date(state.retryAt), now);
  return retryAt.getTime() > now.getTime() ? retryAt : undefined;
}

function successState(state: GithubEndpointState | null, headers: GithubResponseHeaders, now: Date): GithubEndpointState {
  const next: GithubEndpointState = { ...state, checkedAt: now.toISOString() };
  delete next.retryAt;
  delete next.rateLimitResetAt;
  const rawEtag = responseHeader(headers, "etag");
  if (rawEtag !== undefined) {
    const etag = safeEtag(rawEtag);
    if (etag) next.etag = etag;
    else delete next.etag;
  }
  const rate = rateLimitInfo(headers, now);
  if (rate.remaining !== undefined) next.rateLimitRemaining = rate.remaining;
  if (rate.resetAt !== undefined) next.rateLimitResetAt = clampDate(rate.resetAt, now).toISOString();
  return next;
}

function decodeReadme(bytes: Uint8Array): Uint8Array {
  const payload: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("GitHub README response has no base64 content.");
  }
  const content = (payload as Record<string, unknown>).content;
  const encoding = (payload as Record<string, unknown>).encoding;
  if (typeof content !== "string") throw new Error("GitHub README response has no base64 content.");
  if (encoding !== undefined && encoding !== "base64") throw new Error("GitHub README encoding is unsupported.");
  const compact = content.replace(/[\t\n\r ]/g, "");
  if (compact.length === 0 || compact.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    throw new Error("GitHub README content is not valid base64.");
  }
  const padded = compact + "=".repeat((4 - compact.length % 4) % 4);
  const decoded = Buffer.from(padded, "base64");
  if (decoded.toString("base64") !== padded || decoded.byteLength > MAX_GITHUB_README_BYTES) {
    throw new Error("GitHub README content is not valid base64.");
  }
  new TextDecoder("utf-8", { fatal: true }).decode(decoded);
  return decoded;
}
