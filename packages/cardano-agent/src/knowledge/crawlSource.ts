import * as cheerio from "cheerio";
import { BasicCrawler, Configuration } from "crawlee";
import {
  readResponseBytesLimited,
  requestPublicHttps,
  type PublicHttpsLookup,
  type PublicHttpsRequest
} from "@vennek/cardano-governance-skills";
import { extractContent } from "./extractContent.js";
import type { PdfExtractor } from "./extractContent.js";
import { fetchGithubSource } from "./githubSource.js";
import { KnowledgeRepository } from "./knowledgeRepository.js";
import { urlMatchesSourceScope, validateSourceRegistry, type SourceRegistryEntry, type TrustTier } from "./sourceRegistry.js";

const MAX_REQUESTS = 500;
const MAX_CONCURRENCY = 4;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_RESPONSE_BYTES = 128 * 1024 * 1024;
const REQUEST_DEADLINE_MS = 8_000;
const CRAWL_DEADLINE_MS = 120_000;
const ALLOWED_CRAWL_MIME_TYPES = [
  "text/html",
  "text/markdown",
  "text/plain",
  "application/json",
  "application/xml",
  "text/xml"
] as const;

export type CrawlSourceInput = {
  entry: SourceRegistryEntry;
  repository: KnowledgeRepository;
  signal: AbortSignal;
  now?: Date;
  lookup?: PublicHttpsLookup;
  request?: PublicHttpsRequest;
  githubToken?: string;
  pdfExtractor?: PdfExtractor;
};

export type CrawledDocument = {
  sourceId: string;
  canonicalUrl: string;
  trustTier: TrustTier;
  title: string;
  text: string;
  publishedAt?: Date;
  retrievedAt: Date;
};

export type CrawlSourceResult = {
  documents: CrawledDocument[];
  unchanged: number;
  deferredUntil?: Date;
};

export type CrawlResponse = {
  url: string;
  mime: string;
  bytes: Uint8Array;
};

export type CrawlByteBudget = {
  reserve(): void;
  release(bytesRead: number): void;
};

class SharedByteBudget implements CrawlByteBudget {
  private reserved = 0;
  private consumed = 0;

  reserve(): void {
    if (this.consumed + this.reserved + MAX_RESPONSE_BYTES > MAX_TOTAL_RESPONSE_BYTES) {
      throw new Error("Aggregate crawl response byte budget is exhausted.");
    }
    this.reserved += MAX_RESPONSE_BYTES;
  }

  release(bytesRead: number): void {
    this.reserved -= MAX_RESPONSE_BYTES;
    this.consumed += bytesRead;
  }
}

// Kept off the package root; direct-path tests use the production reservation accounting.
export function createCrawlByteBudget(): CrawlByteBudget {
  return new SharedByteBudget();
}

export async function crawlSource(input: CrawlSourceInput): Promise<CrawlSourceResult> {
  input.signal.throwIfAborted();
  const [entry] = validateSourceRegistry([input.entry]);
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("Retrieval time must be a valid date.");
  const retrievedAt = new Date(now.getTime());
  const crawlSignal = AbortSignal.any([input.signal, AbortSignal.timeout(CRAWL_DEADLINE_MS)]);

  if (entry.kind === "github") {
    const github = await fetchGithubSource({
      entry,
      repository: input.repository,
      signal: crawlSignal,
      now: retrievedAt,
      lookup: input.lookup,
      request: input.request,
      token: input.githubToken
    });
    const documents = github.documents.map((document) => {
      return {
        sourceId: entry.id,
        canonicalUrl: document.canonicalUrl,
        trustTier: entry.trustTier,
        title: document.title,
        text: document.text,
        ...(document.publishedAt ? { publishedAt: document.publishedAt } : {}),
        retrievedAt
      } satisfies CrawledDocument;
    });
    return { documents, unchanged: github.unchanged, ...(github.deferredUntil ? { deferredUntil: github.deferredUntil } : {}) };
  }

  await input.repository.ensureSource(entry);
  const seedUrl = normalizeCrawlUrl(entry.url, entry);
  if (!seedUrl) throw new Error("Source entry URL is outside its validated scope.");

  const budget = new SharedByteBudget();
  const documents: CrawledDocument[] = [];
  const enqueued = new Set<string>();
  let firstFailure: unknown;
  let crawler: BasicCrawler | undefined;
  const rememberFailure = (error: unknown) => {
    if (firstFailure === undefined) firstFailure = error;
    crawler?.stop("Source crawl failed");
  };
  const addUrls = async (urls: string[]) => {
    const fresh = urls
      .map((url) => normalizeCrawlUrl(url, entry))
      .filter((url): url is string => url !== undefined && !enqueued.has(url));
    if (fresh.length === 0) return;
    fresh.forEach((url) => enqueued.add(url));
    await crawler!.addRequests(fresh);
  };

  crawler = new BasicCrawler({
    maxRequestsPerCrawl: MAX_REQUESTS,
    maxConcurrency: MAX_CONCURRENCY,
    maxRequestRetries: 0,
    useSessionPool: false,
    requestHandlerTimeoutSecs: CRAWL_DEADLINE_MS / 1_000,
    requestHandler: async ({ request }) => {
      try {
        crawlSignal.throwIfAborted();
        const requestedUrl = normalizeCrawlUrl(request.url, entry);
        if (!requestedUrl) throw new Error("Crawl URL is outside the validated source scope.");
        const response = await fetchCrawlResponse({
          url: requestedUrl,
          entry,
          signal: crawlSignal,
          lookup: input.lookup,
          request: input.request,
          budget,
          allowPdf: input.pdfExtractor !== undefined
        });
        if (isXmlMime(response.mime)) {
          await addUrls(discoverSitemapUrls(response.bytes, entry));
          return;
        }
        const extracted = await extractContent({
          mime: response.mime,
          bytes: response.bytes,
          signal: crawlSignal,
          pdfExtractor: input.pdfExtractor
        });
        documents.push({
          sourceId: entry.id,
          canonicalUrl: requestedUrl,
          trustTier: entry.trustTier,
          title: extracted.title,
          text: extracted.text,
          ...(extracted.publishedAt ? { publishedAt: extracted.publishedAt } : {}),
          retrievedAt
        });
        if (response.mime === "text/html") {
          await addUrls(discoverHtmlUrls(response.bytes, requestedUrl, entry));
        }
      } catch (error) {
        rememberFailure(error);
        throw error;
      }
    },
    failedRequestHandler: async (_context, error) => {
      rememberFailure(error);
    }
  }, new Configuration({ persistStorage: false, purgeOnStart: true }));

  const stop = () => crawler?.stop("Source crawl aborted");
  crawlSignal.addEventListener("abort", stop, { once: true });
  try {
    await addUrls([seedUrl]);
    await crawler.run();
  } catch (error) {
    rememberFailure(error);
  } finally {
    crawlSignal.removeEventListener("abort", stop);
  }
  if (crawlSignal.aborted && firstFailure === undefined) {
    firstFailure = crawlSignal.reason ?? new DOMException("The operation was aborted", "AbortError");
  }
  if (firstFailure !== undefined) throw firstFailure;
  documents.sort(compareDocuments);
  return { documents, unchanged: 0 };
}

export async function fetchCrawlResponse(input: {
  url: string;
  entry: SourceRegistryEntry;
  signal: AbortSignal;
  lookup?: PublicHttpsLookup;
  request?: PublicHttpsRequest;
  budget?: CrawlByteBudget;
  allowPdf?: boolean;
}): Promise<CrawlResponse> {
  input.signal.throwIfAborted();
  const [entry] = validateSourceRegistry([input.entry]);
  const url = normalizeCrawlUrl(input.url, entry);
  if (!url) throw new Error("Crawl URL is outside the validated source scope.");
  const budget = input.budget ?? new SharedByteBudget();
  const allowedMimeTypes = input.allowPdf
    ? [...ALLOWED_CRAWL_MIME_TYPES, "application/pdf"]
    : ALLOWED_CRAWL_MIME_TYPES;
  budget.reserve();
  let released = false;
  try {
    const requestSignal = AbortSignal.any([input.signal, AbortSignal.timeout(REQUEST_DEADLINE_MS)]);
    const response = await requestPublicHttps({
      url,
      allowedDomains: entry.allowedDomains,
      signal: requestSignal,
      method: "GET",
      headers: { accept: allowedMimeTypes.join(",") },
      lookup: input.lookup,
      request: input.request
    });
    if (response.statusCode < 200 || response.statusCode >= 300) {
      response.cancel();
      throw new Error(`HTTP ${response.statusCode}`);
    }
    const result = await readResponseBytesLimited(response, MAX_RESPONSE_BYTES, allowedMimeTypes, requestSignal);
    budget.release(result.bytes.byteLength);
    released = true;
    return { url, mime: result.mime, bytes: result.bytes };
  } finally {
    if (!released) budget.release(0);
  }
}

function normalizeCrawlUrl(value: string, entry: SourceRegistryEntry): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  url.hash = "";
  const normalized = url.toString();
  return url.username || url.password || !urlMatchesSourceScope(normalized, entry) ? undefined : normalized;
}

function discoverHtmlUrls(bytes: Uint8Array, baseUrl: string, entry: SourceRegistryEntry): string[] {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const $ = cheerio.load(source);
  const urls: string[] = [];
  $("a[href]").each((_, element) => {
    const href = $(element).attr("href");
    if (!href) return;
    try {
      const url = normalizeCrawlUrl(new URL(href, baseUrl).toString(), entry);
      if (url) urls.push(url);
    } catch {
      // Ignore malformed links in otherwise valid static documents.
    }
  });
  return urls;
}

function discoverSitemapUrls(bytes: Uint8Array, entry: SourceRegistryEntry): string[] {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const $ = cheerio.load(source, { xmlMode: true });
  const urls: string[] = [];
  $("loc").each((_, element) => {
    const value = $(element).text().trim();
    const url = normalizeCrawlUrl(value, entry);
    if (url) urls.push(url);
  });
  return urls;
}

function isXmlMime(mime: string): boolean {
  return mime === "application/xml" || mime === "text/xml";
}

function compareDocuments(left: CrawledDocument, right: CrawledDocument): number {
  if (left.canonicalUrl < right.canonicalUrl) return -1;
  if (left.canonicalUrl > right.canonicalUrl) return 1;
  if (left.title < right.title) return -1;
  if (left.title > right.title) return 1;
  return 0;
}
