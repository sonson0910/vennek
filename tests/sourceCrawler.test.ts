import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  crawlSource,
  fetchCrawlResponse,
  type CrawledDocument,
  type KnowledgeRepository,
  type SourceRegistryEntry
} from "@vennek/cardano-agent";
import type { PublicHttpsRequest } from "@vennek/cardano-governance-skills";
import { createCrawlByteBudget } from "../packages/cardano-agent/src/knowledge/crawlSource.js";

const now = new Date("2026-08-24T00:00:00.000Z");
const pageEntry: SourceRegistryEntry = {
  id: "docs-source",
  owner: "Cardano",
  trustTier: "official",
  kind: "page",
  url: "https://docs.example.com/start",
  allowedDomains: ["example.com"],
  topics: ["docs"],
  networks: ["mainnet"],
  refresh: "daily"
};

describe("bounded source crawler", () => {
  it("extracts the required HTML document and follows safe relative links", async () => {
    const { request, calls } = fakeRequest({
      "/start": html(`
        <html><head><title>Fallback</title></head><body>
          <nav>Ignore</nav><h1>Start page</h1><p>Cardano source.</p>
          <a aria-hidden="true" href="/next">Next</a><a aria-hidden="true" href="https://evil.example/out">Cross domain</a>
          <a aria-hidden="true" href="https://docs.example.com:443/next#fragment">Duplicate</a>
        </body></html>`),
      "/next": html("<h1>Next page</h1><p>More Cardano information.</p>")
    });

    const result = await crawlSource({
      entry: pageEntry,
      repository: fakeRepository(),
      signal: new AbortController().signal,
      now,
      lookup: publicLookup,
      request
    });

    expect(result.documents).toEqual([
      expect.objectContaining<CrawledDocument>({
        sourceId: "docs-source",
        canonicalUrl: "https://docs.example.com/start",
        trustTier: "official",
        title: "Start page",
        text: "# Start page\n\nCardano source.",
        retrievedAt: now
      }),
      expect.objectContaining({
        canonicalUrl: "https://docs.example.com/next",
        title: "Next page"
      })
    ]);
    expect(calls).toEqual(["/start", "/next"]);
  });

  it("never requests cross-domain, credential, or private/mixed-DNS links", async () => {
    const { request, calls } = fakeRequest({
      "/start": html(`
        <h1>Safe links</h1><p>Cardano source.</p>
        <a href="https://evil.example/out">cross</a>
        <a href="https://user:pass@docs.example.com/private">credentials</a>
        <a href="https://private.example.com/internal">private</a>
        <a href="https://mixed.example.com/mixed">mixed</a>`),
      "/private": html("<h1>Should not be fetched</h1><p>No.</p>"),
      "/mixed": html("<h1>Should not be fetched</h1><p>No.</p>")
    });
    const lookup = async (hostname: string) => {
      if (hostname === "private.example.com") return [{ address: "127.0.0.1", family: 4 as const }];
      if (hostname === "mixed.example.com") return [
        { address: "93.184.216.34", family: 4 as const },
        { address: "127.0.0.1", family: 4 as const }
      ];
      return publicLookup(hostname);
    };

    await expect(crawlSource({
      entry: pageEntry,
      repository: fakeRepository(),
      signal: new AbortController().signal,
      now,
      lookup,
      request
    })).rejects.toThrow(/Private|mixed|public/i);
    expect(calls).toEqual(["/start"]);
  });

  it("crawls same-scope sitemap links without indexing XML manifests", async () => {
    const entry: SourceRegistryEntry = { ...pageEntry, id: "docs-sitemap", kind: "sitemap", url: "https://docs.example.com/sitemap.xml" };
    const { request, calls } = fakeRequest({
      "/sitemap.xml": xml(`<urlset><url><loc>https://docs.example.com/guide#old</loc></url><url><loc>https://evil.example/out</loc></url><url><loc>https://docs.example.com/nested.xml</loc></url></urlset>`),
      "/guide": html("<h1>Guide</h1><p>Cardano guide.</p>"),
      "/nested.xml": xml(`<sitemapindex><sitemap><loc>https://docs.example.com/nested-page</loc></sitemap></sitemapindex>`),
      "/nested-page": html("<h1>Nested page</h1><p>Cardano details.</p>")
    });

    const result = await crawlSource({ entry, repository: fakeRepository(), signal: new AbortController().signal, now, lookup: publicLookup, request });

    expect(result.documents.map((document) => document.canonicalUrl)).toEqual([
      "https://docs.example.com/guide",
      "https://docs.example.com/nested-page"
    ]);
    expect(result.documents.every((document) => !document.canonicalUrl.endsWith(".xml"))).toBe(true);
    expect(calls).toContain("/nested.xml");
  });

  it("cancels redirects and rejects unsupported or oversized bodies", async () => {
    const redirectCanceled: { value: boolean } = { value: false };
    const redirect = fakeRequest({ "/start": html("redirect") }, { statusCode: 302, canceled: redirectCanceled });
    await expect(crawlSource({ entry: pageEntry, repository: fakeRepository(), signal: new AbortController().signal, now, lookup: publicLookup, request: redirect.request })).rejects.toThrow(/HTTP 302/);
    expect(redirectCanceled.value).toBe(true);

    const unsupportedCanceled: { value: boolean } = { value: false };
    const unsupported = fakeRequest({ "/start": { body: "bad", contentType: "application/zip" } }, { canceled: unsupportedCanceled });
    await expect(crawlSource({ entry: pageEntry, repository: fakeRepository(), signal: new AbortController().signal, now, lookup: publicLookup, request: unsupported.request })).rejects.toThrow(/Unsupported content-type/);
    expect(unsupportedCanceled.value).toBe(true);

    const oversizedCanceled: { value: boolean } = { value: false };
    const oversized = fakeRequest({ "/start": { body: "small", contentType: "text/html", contentLength: String(8 * 1024 * 1024 + 1) } }, { canceled: oversizedCanceled });
    await expect(crawlSource({ entry: pageEntry, repository: fakeRepository(), signal: new AbortController().signal, now, lookup: publicLookup, request: oversized.request })).rejects.toThrow(/too large/);
    expect(oversizedCanceled.value).toBe(true);
  });

  it("caps concurrency at four and stops at 500 requests", async () => {
    const concurrency: { active: number; max: number } = { active: 0, max: 0 };
    const responses: Record<string, ResponseSpec> = {};
    for (let index = 0; index < 501; index += 1) {
      responses[`/${index}`] = html(`<h1>Page ${index}</h1><p>Cardano page.</p><a href="/${index + 1}">next</a>`);
    }
    const request = fakeRequest(responses, { delayMs: 2, concurrency }).request;
    const result = await crawlSource({
      entry: { ...pageEntry, url: "https://docs.example.com/0" },
      repository: fakeRepository(),
      signal: new AbortController().signal,
      now,
      lookup: publicLookup,
      request
    });

    expect(result.documents).toHaveLength(500);
    expect(concurrency.max).toBeLessThanOrEqual(4);
  }, 15_000);

  it("combines the caller abort signal with the pinned request and cancels the body", async () => {
    const controller = new AbortController();
    const canceled: { value: boolean } = { value: false };
    const { request, calls } = fakeRequest({ "/start": html("<h1>Slow page</h1><p>Cardano page.</p>") }, { delayMs: 500, canceled });
    const crawl = crawlSource({ entry: pageEntry, repository: fakeRepository(), signal: controller.signal, now, lookup: publicLookup, request });
    setTimeout(() => controller.abort(), 200);

    await expect(crawl).rejects.toThrow();
    expect(calls).toEqual(["/start"]);
    expect(canceled.value).toBe(true);
  });

  it("fails closed before the 17th full response when the aggregate budget is exhausted", async () => {
    const fullResponse = Buffer.alloc(8 * 1024 * 1024, 97);
    let calls = 0;
    const request = ((options, callback) => {
      calls += 1;
      const body = Object.assign(Readable.from([fullResponse]), {
        statusCode: 200,
        headers: { "content-type": "text/plain", "content-length": String(fullResponse.byteLength) }
      });
      callback(body as never);
      return Object.assign(new EventEmitter(), { end() {} }) as never;
    }) as PublicHttpsRequest;
    const budget = createCrawlByteBudget();
    const requestInput = { url: pageEntry.url, entry: pageEntry, signal: new AbortController().signal, lookup: publicLookup, request, budget };

    for (let index = 0; index < 16; index += 1) {
      await expect(fetchCrawlResponse(requestInput)).resolves.toBeDefined();
    }
    await expect(fetchCrawlResponse(requestInput)).rejects.toThrow(/aggregate.*budget/i);
    expect(calls).toBe(16);
  });

  it("delegates GitHub retrieval into the crawler result shape", async () => {
    const entry: SourceRegistryEntry = {
      id: "github-source",
      owner: "Cardano",
      trustTier: "official",
      kind: "github",
      url: "https://github.com/test-org/test-repo",
      allowedDomains: ["github.com", "api.github.com", "raw.githubusercontent.com"],
      github: { owner: "test-org", repository: "test-repo" },
      topics: ["code"],
      networks: ["mainnet"],
      refresh: "daily"
    };
    const request = fakeRequest({
      "/repos/test-org/test-repo": json({ name: "test-repo" }),
      "/repos/test-org/test-repo/readme": json({ encoding: "base64", content: "IyBSZWFkbWU=" }),
      "/repos/test-org/test-repo/releases?per_page=100&page=1": json([]),
      "/repos/test-org/test-repo/tags?per_page=100&page=1": json([])
    }).request;

    const result = await crawlSource({ entry, repository: fakeRepository(), signal: new AbortController().signal, now, lookup: publicLookup, request });

    expect(result.documents.map((document) => document.title)).toEqual([
      "test-org GitHub repository",
      "Readme",
      "test-org GitHub releases",
      "test-org GitHub tags"
    ]);
    expect(result.documents.every((document) => document.sourceId === "github-source" && document.retrievedAt.getTime() === now.getTime())).toBe(true);
  });
});

type ResponseSpec = {
  body: string | Uint8Array;
  contentType: string;
  contentLength?: string;
  statusCode?: number;
};

function html(body: string): ResponseSpec {
  return { body, contentType: "text/html" };
}

function xml(body: string): ResponseSpec {
  return { body, contentType: "application/xml" };
}

function json(value: unknown): ResponseSpec {
  return { body: JSON.stringify(value), contentType: "application/json" };
}

function fakeRequest(
  responses: Record<string, ResponseSpec>,
  options: { statusCode?: number; canceled?: { value: boolean }; delayMs?: number; concurrency?: { active: number; max: number } } = {}
): { request: PublicHttpsRequest; calls: string[] } {
  const calls: string[] = [];
  const request = ((requestOptions, callback) => {
    const path = `${requestOptions.path}`;
    calls.push(path);
    const spec = responses[path] ?? html("<h1>Not found</h1><p>Missing.</p>");
    const statusCode = options.statusCode ?? spec.statusCode ?? 200;
    const source = typeof spec.body === "string" ? Buffer.from(spec.body) : Buffer.from(spec.body);
    const body = Readable.from((async function* () {
      options.concurrency && (options.concurrency.active += 1, options.concurrency.max = Math.max(options.concurrency.max, options.concurrency.active));
      try {
        if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
        yield source;
      } finally {
        options.concurrency && (options.concurrency.active -= 1);
      }
    })());
    const originalDestroy = body.destroy.bind(body);
    body.destroy = ((error?: Error) => {
      if (options.canceled) options.canceled.value = true;
      return originalDestroy(error);
    }) as typeof body.destroy;
    Object.assign(body, {
      statusCode,
      headers: {
        "content-type": spec.contentType,
        "content-length": spec.contentLength ?? String(source.byteLength)
      }
    });
    callback(body as never);
    return Object.assign(new EventEmitter(), { end() {} }) as never;
  }) as PublicHttpsRequest;
  return { request, calls };
}

function fakeRepository(): KnowledgeRepository {
  return {
    ensureSource: vi.fn(async () => undefined),
    getGithubEndpointState: vi.fn(async () => null),
    compareAndSetGithubEndpointState: vi.fn(async () => true)
  } as unknown as KnowledgeRepository;
}

const publicLookup = async (_hostname?: string) => [{ address: "93.184.216.34", family: 4 as const }];
