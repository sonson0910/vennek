import { isIP } from "node:net";
import {
  fetchCrawlResponse,
  type CrawledDocument,
} from "./crawlSource.js";
import { extractContent, type PdfExtractor } from "./extractContent.js";
import type { EmbeddingProvider } from "./indexDocument.js";
import { indexDocument } from "./indexDocument.js";
import type { KnowledgeRepository } from "./knowledgeRepository.js";
import {
  SEARXNG_MAX_QUERY_BYTES,
  SEARXNG_MAX_QUERY_CODE_POINTS,
  SearxngClient,
} from "./searxng.js";
import {
  sourceIsScheduled,
  urlMatchesSourceScope,
  validateSourceRegistry,
  type SourceRegistryEntry,
} from "./sourceRegistry.js";
import type { PublicHttpsLookup, PublicHttpsRequest } from "@vennek/cardano-governance-skills";
import { findWalletSecret } from "../security/walletSecrets.js";
import type { RepositoryOperationOptions } from "./knowledgeRepository.js";

const MAX_QUESTION_CODE_POINTS = 4_096;
const MAX_QUESTION_BYTES = 16 * 1_024;
const MAX_QUESTION_UTF16_UNITS = MAX_QUESTION_CODE_POINTS * 2;
const MAX_DOMAIN_CHARS = 253;
const MAX_URL_CHARS = 2_048;
const MAX_RESULTS = 10;
const MAX_TITLE_CHARS = 300;
const MAX_CONTENT_CHARS = 1_000;
const QUESTION_PROMOTION_DEADLINE_MS = 45_000;
const PROMOTION_DEADLINE_MS = 120_000;

export type DiscoveredLink = {
  url: string;
  title: string;
  content: string;
  trustTier: "unverified";
  matchedSourceId?: string;
};

export type LiveDiscoverySearch = Pick<SearxngClient, "search">;

export type DiscoverLiveSourcesInput = {
  query: string;
  registry: unknown;
  search: LiveDiscoverySearch;
  trustTier?: "official" | "community";
  signal?: AbortSignal;
};

export type PromoteQuestionSourcesInput = {
  question: string;
  registry: unknown;
  search: LiveDiscoverySearch;
  promote: (link: DiscoveredLink, signal: AbortSignal, deadlineAt: number) => Promise<unknown>;
  signal?: AbortSignal;
  now?: () => number;
};

export type PromoteDiscoveredLinkInput = {
  link: DiscoveredLink;
  registry: unknown;
  repository: Pick<KnowledgeRepository, "ensureSource" | "storeVersion" | "hasCompleteChunks" | "replaceChunks">;
  embedder: EmbeddingProvider;
  embeddingModel: string;
  signal?: AbortSignal;
  now?: Date;
  deadlineAt?: number;
  lookup?: PublicHttpsLookup;
  request?: PublicHttpsRequest;
  pdfExtractor?: PdfExtractor;
};

export type PromotedDiscoveredLink = Omit<DiscoveredLink, "trustTier"> & {
  sourceId: string;
  trustTier: SourceRegistryEntry["trustTier"];
  versionId: string;
  versionHash: string;
};

export function buildOfficialSearchQuery(query: string, domains: string[]): string {
  const normalizedQuery = validateQuery(query);
  const normalizedDomains = normalizeSearchDomains(domains);
  if (normalizedDomains.length === 0) throw new Error("Official search domains are required");
  const result = `${normalizedQuery} (${normalizedDomains.map((domain) => `site:${domain}`).join(" OR ")})`;
  if (
    result.length > SEARXNG_MAX_QUERY_CODE_POINTS * 2 ||
    Array.from(result).length > SEARXNG_MAX_QUERY_CODE_POINTS ||
    Buffer.byteLength(result, "utf8") > SEARXNG_MAX_QUERY_BYTES
  ) {
    throw new Error("Official search query is too large");
  }
  return result;
}

export async function discoverLiveSources(input: DiscoverLiveSourcesInput): Promise<DiscoveredLink[]> {
  const entries = validateRegistry(input.registry);
  if (!input.search || typeof input.search.search !== "function") throw new Error("Live discovery search client is required");
  const trustTier = input.trustTier ?? "official";
  if (trustTier !== "official" && trustTier !== "community") throw new Error("Live discovery trust tier is invalid");
  const selectedDomains = normalizeSearchDomains(
    entries
      .filter((entry) => entry.trustTier === trustTier && supportsDirectPromotion(entry))
      .flatMap((entry) => entry.allowedDomains),
  );
  if (selectedDomains.length === 0) return [];
  input.signal?.throwIfAborted();
  const results = await input.search.search(buildOfficialSearchQuery(input.query, selectedDomains), input.signal);
  const links: DiscoveredLink[] = [];
  const seen = new Set<string>();
  for (const result of results.slice(0, MAX_RESULTS)) {
    const url = normalizeDiscoveredUrl(result.url);
    if (!url || seen.has(url)) continue;
    const title = boundedText(result.title, MAX_TITLE_CHARS);
    const content = boundedContent(result.content, MAX_CONTENT_CHARS);
    if (!title || content === undefined) continue;
    seen.add(url);
    const matches = entries.filter((entry) =>
      entry.trustTier === trustTier && supportsDirectPromotionUrl(url, entry));
    links.push({
      url,
      title,
      content,
      trustTier: "unverified",
      ...(matches.length === 1 ? { matchedSourceId: matches[0]!.id } : {}),
    });
  }
  return links;
}

export async function promoteQuestionSources(input: PromoteQuestionSourcesInput): Promise<{
  outcome: "promoted" | "no_match";
  promotedCount: number;
}> {
  const startedAt = (input.now ?? Date.now)();
  if (!Number.isFinite(startedAt)) throw new Error("Live discovery time is invalid");
  const deadlineAt = startedAt + QUESTION_PROMOTION_DEADLINE_MS;
  if (!Number.isFinite(deadlineAt)) throw new Error("Live discovery deadline is invalid");
  const timeoutSignal = AbortSignal.timeout(QUESTION_PROMOTION_DEADLINE_MS);
  const signal = input.signal ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal;

  signal.throwIfAborted();
  let links = await discoverLiveSources({
    query: input.question,
    registry: input.registry,
    search: input.search,
    trustTier: "official",
    signal,
  });
  if (!links.some((link) => link.matchedSourceId)) {
    signal.throwIfAborted();
    links = await discoverLiveSources({
      query: input.question,
      registry: input.registry,
      search: input.search,
      trustTier: "community",
      signal,
    });
  }

  const selected = uniqueMatchedSources(links).slice(0, 3);
  let promotedCount = 0;
  for (const link of selected) {
    signal.throwIfAborted();
    await input.promote(link, signal, deadlineAt);
    promotedCount += 1;
  }
  return { outcome: promotedCount > 0 ? "promoted" : "no_match", promotedCount };
}

function uniqueMatchedSources(links: DiscoveredLink[]): DiscoveredLink[] {
  const sourceIds = new Set<string>();
  return links.filter((link) => {
    const sourceId = link.matchedSourceId;
    if (!sourceId || sourceIds.has(sourceId)) return false;
    sourceIds.add(sourceId);
    return true;
  });
}

export async function promoteDiscoveredLink(input: PromoteDiscoveredLinkInput): Promise<DiscoveredLink | PromotedDiscoveredLink> {
  const entries = validateRegistry(input.registry);
  if (!isRecord(input.link)) throw new Error("Discovery link is invalid");
  const url = normalizeDiscoveredUrl(input.link.url);
  if (!url) throw new Error("Discovery link is invalid");
  const matches = entries.filter((entry) => supportsDirectPromotionUrl(url, entry));
  const title = boundedText(input.link.title, 300);
  const content = boundedContent(input.link.content, 1_000);
  if (!title || content === undefined) throw new Error("Discovery link is invalid");
  const unverified: DiscoveredLink = {
    url,
    title,
    content,
    trustTier: "unverified",
  };
  if (matches.length !== 1) return unverified;

  const entry = matches[0]!;
  if (!supportsDirectPromotionUrl(url, entry)) return unverified;
  const deadline = createPromotionDeadline(input.signal, input.deadlineAt);
  const signal = deadline.signal;
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("Live discovery time is invalid");
  try {
    signal.throwIfAborted();
    const response = await fetchCrawlResponse({
      url,
      entry,
      signal,
      lookup: input.lookup,
      request: input.request,
      allowPdf: input.pdfExtractor !== undefined,
    });
    const extracted = await extractContent({
      mime: response.mime,
      bytes: response.bytes,
      signal,
      pdfExtractor: input.pdfExtractor,
    });
    signal.throwIfAborted();
    const repositoryOptions: RepositoryOperationOptions = { signal, deadlineAt: deadline.deadlineAt };
    await input.repository.ensureSource(entry, repositoryOptions);
    const document: CrawledDocument = {
      sourceId: entry.id,
      canonicalUrl: response.url,
      trustTier: entry.trustTier,
      title: extracted.title,
      text: extracted.text,
      ...(extracted.publishedAt ? { publishedAt: extracted.publishedAt } : {}),
      retrievedAt: now,
    };
    const indexed = await indexDocument({
      ...document,
      repository: input.repository,
      embedder: input.embedder,
      embeddingModel: input.embeddingModel,
      signal,
      deadlineAt: deadline.deadlineAt,
    });
    const promotedTitle = boundedText(extracted.title, MAX_TITLE_CHARS);
    const promotedContent = boundedContent(extracted.text, MAX_CONTENT_CHARS);
    if (!promotedTitle || !promotedContent) throw new Error("Live source promotion failed");
    return {
      url: response.url,
      title: promotedTitle,
      content: promotedContent,
      matchedSourceId: entry.id,
      sourceId: entry.id,
      trustTier: entry.trustTier,
      versionId: indexed.versionId,
      versionHash: indexed.contentHash,
    };
  } catch {
    throw new Error("Live source promotion failed");
  }
}

function supportsDirectPromotion(entry: SourceRegistryEntry): boolean {
  return sourceIsScheduled(entry) && entry.kind !== "stackexchange";
}

function supportsDirectPromotionUrl(url: string, entry: SourceRegistryEntry): boolean {
  if (!supportsDirectPromotion(entry) || !urlMatchesSourceScope(url, entry)) return false;
  if (entry.kind !== "github") return true;

  const parsed = new URL(url);
  if (parsed.hostname.toLowerCase() !== "github.com") return false;
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments[0] !== entry.github.owner) return false;
  if (entry.github.repository === undefined) return segments.length === 1;
  if (segments[1] !== entry.github.repository) return false;

  const tail = segments.slice(2);
  return tail.length === 0 ||
    (tail.length === 1 && (tail[0] === "releases" || tail[0] === "tags")) ||
    (tail.length === 3 && tail[0] === "releases" && tail[1] === "tag" && /^[A-Za-z0-9._-]+$/.test(tail[2]!));
}

type PromotionDeadline = { signal: AbortSignal; deadlineAt: number };

function createPromotionDeadline(parent: AbortSignal | undefined, inheritedDeadlineAt: number | undefined): PromotionDeadline {
  const now = Date.now();
  const maximum = now + PROMOTION_DEADLINE_MS;
  const deadlineAt = typeof inheritedDeadlineAt === "number" && Number.isFinite(inheritedDeadlineAt)
    ? Math.min(inheritedDeadlineAt, maximum)
    : maximum;
  let deadlineSignal: AbortSignal;
  if (deadlineAt <= now) {
    const controller = new AbortController();
    controller.abort();
    deadlineSignal = controller.signal;
  } else {
    deadlineSignal = AbortSignal.timeout(deadlineAt - now);
  }
  return { signal: parent ? AbortSignal.any([parent, deadlineSignal]) : deadlineSignal, deadlineAt };
}

function validateRegistry(input: unknown): SourceRegistryEntry[] {
  if (Array.isArray(input)) return validateSourceRegistry(input);
  if (isRecord(input) && Array.isArray(input.official) && Array.isArray(input.community)) {
    return validateSourceRegistry([...input.official, ...input.community]);
  }
  throw new Error("Live discovery registry is invalid");
}

function validateQuery(value: string): string {
  if (typeof value !== "string") throw new Error("Live discovery query is required");
  const query = value.normalize("NFC").trim();
  if (
    !query ||
    query.length > MAX_QUESTION_UTF16_UNITS ||
    Array.from(query).length > MAX_QUESTION_CODE_POINTS ||
    Buffer.byteLength(query, "utf8") > MAX_QUESTION_BYTES ||
    /[\u0000-\u001f\u007f]/.test(query) ||
    /\bsite\s*:/iu.test(query)
  ) {
    throw new Error("Live discovery query is invalid");
  }
  if (findWalletSecret(query)) throw new Error("Live discovery queries must not contain wallet secrets.");
  return query;
}

function normalizeSearchDomains(domains: string[]): string[] {
  if (!Array.isArray(domains)) throw new Error("Live discovery domains are invalid");
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of domains) {
    if (typeof value !== "string") throw new Error("Live discovery domain is invalid");
    const domain = value.trim().toLowerCase();
    if (
      !domain ||
      domain.length > MAX_DOMAIN_CHARS ||
      domain.includes("/") ||
      domain.includes("\\") ||
      isIP(domain) ||
      domain.endsWith(".") ||
      domain.split(".").length < 2 ||
      domain.split(".").some((label) => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))
    ) {
      throw new Error("Live discovery domain is invalid");
    }
    if (!seen.has(domain)) {
      seen.add(domain);
      result.push(domain);
    }
  }
  return result;
}

function normalizeDiscoveredUrl(value: string): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_URL_CHARS || /[\u0000-\u001f\u007f]/.test(value) || value.includes("\\") || /%(?:2f|5c)/i.test(value)) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (
    url.protocol !== "https:" ||
    (url.port !== "" && url.port !== "443") ||
    url.username ||
    url.password ||
    isIP(hostname) ||
    !hostname.includes(".") ||
    hostname.split(".").some((label) => label.length === 0 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))
  ) {
    return undefined;
  }
  url.hostname = hostname;
  url.hash = "";
  const normalized = url.toString();
  return normalized.length <= MAX_URL_CHARS ? normalized : undefined;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
