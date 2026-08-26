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
const stackExchangeEntry: SourceRegistryEntry = {
  id: "cardano-stackexchange",
  owner: "Cardano",
  trustTier: "official",
  kind: "stackexchange",
  url: "https://api.stackexchange.com/2.3/questions",
  allowedDomains: ["api.stackexchange.com", "cardano.stackexchange.com"],
  topics: ["questions"],
  networks: ["mainnet"],
  refresh: "daily",
  stackExchange: { site: "cardano" },
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
      expect.objectContaining({ canonicalUrl: "https://docs.example.com/next", title: "Next page" }),
      expect.objectContaining<CrawledDocument>({
        sourceId: "docs-source",
        canonicalUrl: "https://docs.example.com/start",
        trustTier: "official",
        title: "Start page",
        text: "# Start page\n\nCardano source.",
        retrievedAt: now
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

    const pdfCanceled: { value: boolean } = { value: false };
    const pdf = fakeRequest({ "/start": { body: "%PDF-1.7", contentType: "application/pdf" } }, { canceled: pdfCanceled });
    await expect(crawlSource({ entry: pageEntry, repository: fakeRepository(), signal: new AbortController().signal, now, lookup: publicLookup, request: pdf.request })).rejects.toThrow(/Unsupported content-type/);
    expect(pdfCanceled.value).toBe(true);
  });

  it("advertises the same allowed MIME list used for response validation", async () => {
    const htmlRequest = fakeRequest({ "/start": html("<h1>HTML</h1><p>Cardano page.</p>") });
    await expect(fetchCrawlResponse({
      url: pageEntry.url,
      entry: pageEntry,
      signal: new AbortController().signal,
      lookup: publicLookup,
      request: htmlRequest.request
    })).resolves.toEqual(expect.objectContaining({ mime: "text/html" }));
    expect(htmlRequest.accepts[0]).not.toContain("application/pdf");

    const pdfRequest = fakeRequest({ "/start": { body: "%PDF-1.7", contentType: "application/pdf" } });
    await expect(fetchCrawlResponse({
      url: pageEntry.url,
      entry: pageEntry,
      signal: new AbortController().signal,
      lookup: publicLookup,
      request: pdfRequest.request,
      allowPdf: true
    })).resolves.toEqual(expect.objectContaining({ mime: "application/pdf" }));
    expect(pdfRequest.accepts[0]).toContain("application/pdf");
  });

  it("admits PDF only with an explicit remote extractor", async () => {
    const { request } = fakeRequest({ "/start": { body: "%PDF-1.7", contentType: "application/pdf" } });
    const extractor = {
      extract: vi.fn(async (bytes: Uint8Array) => ({ title: "Remote PDF", text: `bytes:${bytes.byteLength}` }))
    };
    const result = await crawlSource({
      entry: pageEntry,
      repository: fakeRepository(),
      signal: new AbortController().signal,
      now,
      lookup: publicLookup,
      request,
      pdfExtractor: extractor
    });
    expect(result.documents).toEqual([expect.objectContaining({ title: "Remote PDF", text: "bytes:8" })]);
    expect(extractor.extract).toHaveBeenCalledOnce();
  });

  it("serializes PDF extraction while keeping page fetches concurrent", async () => {
    const active = { value: 0, max: 0 };
    const { request } = fakeRequest({
      "/start": html('<h1>Index</h1><p>Cardano PDFs.</p><a href="/a.pdf">A</a><a href="/b.pdf">B</a>'),
      "/a.pdf": { body: "%PDF-1.4 A", contentType: "application/pdf" },
      "/b.pdf": { body: "%PDF-1.4 B", contentType: "application/pdf" }
    });
    const extractor = {
      extract: vi.fn(async (bytes: Uint8Array) => {
        active.value += 1;
        active.max = Math.max(active.max, active.value);
        try {
          await new Promise((resolve) => setTimeout(resolve, 10));
          if (active.value > 1) throw new Error("PDF extractor overlap");
          return { title: `PDF ${bytes.at(-1)}`, text: "PDF text" };
        } finally {
          active.value -= 1;
        }
      })
    };

    const result = await crawlSource({
      entry: pageEntry,
      repository: fakeRepository(),
      signal: new AbortController().signal,
      now,
      lookup: publicLookup,
      request,
      pdfExtractor: extractor
    });

    expect(result.documents).toHaveLength(3);
    expect(result.documents.filter((document) => document.canonicalUrl.endsWith(".pdf"))).toHaveLength(2);
    expect(active.max).toBe(1);
  });

  it("serializes PDF extraction across concurrent crawls", async () => {
    const active = { value: 0, max: 0 };
    const extractor = {
      extract: vi.fn(async () => {
        active.value += 1;
        active.max = Math.max(active.max, active.value);
        try {
          await new Promise((resolve) => setTimeout(resolve, 10));
          if (active.value > 1) throw new Error("PDF extractor overlap");
          return { title: "Remote PDF", text: "PDF text" };
        } finally {
          active.value -= 1;
        }
      })
    };
    const crawl = (id: string) => {
      const entry = { ...pageEntry, id, url: `https://docs.example.com/${id}.pdf` };
      return crawlSource({
        entry,
        repository: fakeRepository(),
        signal: new AbortController().signal,
        now,
        lookup: publicLookup,
        request: fakeRequest({ [`/${id}.pdf`]: { body: "%PDF-1.4", contentType: "application/pdf" } }).request,
        pdfExtractor: extractor
      });
    };

    const results = await Promise.all([crawl("first"), crawl("second")]);
    expect(results.flatMap((result) => result.documents)).toHaveLength(2);
    expect(active.max).toBe(1);
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

  it("sorts documents deterministically when concurrent responses finish out of order", async () => {
    const request = fakeRequest({
      "/start": html('<h1>Start</h1><p>Cardano source.</p><a href="/b">B</a><a href="/a">A</a>'),
      "/a": html("<h1>A</h1><p>Cardano A.</p>"),
      "/b": html("<h1>B</h1><p>Cardano B.</p>")
    }, { delayMs: (path) => path === "/a" ? 30 : path === "/b" ? 1 : 0 }).request;
    const result = await crawlSource({ entry: pageEntry, repository: fakeRepository(), signal: new AbortController().signal, now, lookup: publicLookup, request });

    expect(result.documents.map((document) => document.canonicalUrl)).toEqual([
      "https://docs.example.com/a",
      "https://docs.example.com/b",
      "https://docs.example.com/start"
    ]);
  });

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

    const repository = fakeRepository();
    const result = await crawlSource({ entry, repository, signal: new AbortController().signal, now, lookup: publicLookup, request });

    expect(result.documents.map((document) => document.title)).toEqual([
      "test-org GitHub repository",
      "Readme",
      "test-org GitHub releases",
      "test-org GitHub tags"
    ]);
    expect(result.documents.every((document) => document.sourceId === "github-source" && document.retrievedAt.getTime() === now.getTime())).toBe(true);
    expect(result.commitState).toBeTypeOf("function");
    expect(repository.compareAndSetGithubEndpointStates).not.toHaveBeenCalled();
    await expect(result.commitState?.()).resolves.toBe(true);
    expect(repository.compareAndSetGithubEndpointStates).toHaveBeenCalledTimes(1);
  });

  it("dispatches Stack Exchange through its API adapter instead of BasicCrawler", async () => {
    const { request, calls } = fakeRequest({
      "/2.3/questions?order=desc&sort=activity&pagesize=100&page=1&filter=withbody&site=cardano": json({
        items: [{
          question_id: 11,
          title: "Question",
          body: "<p>Body.</p>",
          creation_date: 1_700_000_000,
          last_activity_date: 1_700_000_001,
          content_license: "CC BY-SA 4.0",
          owner: null,
        }],
        has_more: false,
        quota_remaining: 99,
      }),
      "/2.3/questions/11/answers?order=desc&sort=activity&pagesize=100&page=1&filter=withbody&site=cardano": json({
        items: [],
        has_more: false,
        quota_remaining: 98,
      }),
    });
    const repository = fakeRepository();

    const result = await crawlSource({ entry: stackExchangeEntry, repository, signal: new AbortController().signal, now, lookup: publicLookup, request });

    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]).toMatchObject({ sourceId: stackExchangeEntry.id, trustTier: "official" });
    expect(calls).toEqual([
      "/2.3/questions?order=desc&sort=activity&pagesize=100&page=1&filter=withbody&site=cardano",
      "/2.3/questions/11/answers?order=desc&sort=activity&pagesize=100&page=1&filter=withbody&site=cardano",
    ]);
    expect(result.commitState).toBeTypeOf("function");
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
  options: { statusCode?: number; canceled?: { value: boolean }; delayMs?: number | ((path: string) => number); concurrency?: { active: number; max: number } } = {}
): { request: PublicHttpsRequest; calls: string[]; accepts: string[] } {
  const calls: string[] = [];
  const accepts: string[] = [];
  const request = ((requestOptions, callback) => {
    const path = `${requestOptions.path}`;
    calls.push(path);
    const headers = requestOptions.headers;
    const accept = typeof headers === "object" && headers !== null && !Array.isArray(headers)
      ? (headers as Record<string, string | undefined>).accept
      : undefined;
    accepts.push(`${accept ?? ""}`);
    const spec = responses[path] ?? html("<h1>Not found</h1><p>Missing.</p>");
    const statusCode = options.statusCode ?? spec.statusCode ?? 200;
    const source = typeof spec.body === "string" ? Buffer.from(spec.body) : Buffer.from(spec.body);
    const body = Readable.from((async function* () {
      options.concurrency && (options.concurrency.active += 1, options.concurrency.max = Math.max(options.concurrency.max, options.concurrency.active));
      try {
        const delayMs = typeof options.delayMs === "function" ? options.delayMs(path) : options.delayMs;
        if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
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
  return { request, calls, accepts };
}

function fakeRepository(): KnowledgeRepository {
  return {
    ensureSource: vi.fn(async () => undefined),
    getGithubEndpointState: vi.fn(async () => null),
    compareAndSetGithubEndpointState: vi.fn(async () => true),
    compareAndSetGithubEndpointStates: vi.fn(async () => true),
    getStackExchangeFetchState: vi.fn(async () => null),
    compareAndSetStackExchangeFetchState: vi.fn(async () => true),
  } as unknown as KnowledgeRepository;
}

const publicLookup = async (_hostname?: string) => [{ address: "93.184.216.34", family: 4 as const }];
