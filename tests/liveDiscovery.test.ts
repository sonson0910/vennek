import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  buildOfficialSearchQuery,
  discoverLiveSources,
  promoteQuestionSources,
  promoteDiscoveredLink,
  type DiscoveredLink,
} from "../packages/cardano-agent/src/knowledge/liveDiscovery.js";
import { SearxngClient, type SearxngFetch } from "../packages/cardano-agent/src/knowledge/searxng.js";
import type { PublicHttpsRequest } from "@vennek/cardano-governance-skills";
import type { KnowledgeRepository, SourceRegistryEntry } from "@vennek/cardano-agent";

const entry: SourceRegistryEntry = {
  id: "official-docs",
  owner: "Cardano",
  trustTier: "official",
  kind: "page",
  url: "https://docs.cardano.org/",
  allowedDomains: ["docs.cardano.org"],
  topics: ["developer"],
  networks: ["mainnet"],
  refresh: "daily",
};

const communityEntry: SourceRegistryEntry = {
  ...entry,
  id: "community-docs",
  owner: "Community",
  trustTier: "community",
  url: "https://community.example.org/",
  allowedDomains: ["community.example.org"],
};

function result(url: string, title = "Result"): { title: string; content: string; url: string } {
  return { title, content: "Cardano documentation", url };
}

function jsonResponse(value: unknown, headers: Record<string, string> = { "content-type": "application/json" }): Response {
  return new Response(JSON.stringify(value), { status: 200, headers });
}

function fakeRequest(body: string, statusCode = 200): PublicHttpsRequest {
  return ((_, callback) => {
    const response = Object.assign(Readable.from([Buffer.from(body)]), {
      statusCode,
      headers: { "content-type": "text/html", "content-length": String(Buffer.byteLength(body)) },
    });
    callback(response as never);
    return { end() {} } as never;
  }) as PublicHttpsRequest;
}

function fakeRepository(overrides: Partial<KnowledgeRepository> = {}): KnowledgeRepository {
  return {
    ensureSource: vi.fn(async () => undefined),
    storeVersion: vi.fn(async () => ({ id: "91", contentHash: "a".repeat(64) })),
    hasCompleteChunks: vi.fn(async () => false),
    replaceChunks: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as KnowledgeRepository;
}

describe("SearXNG live discovery", () => {
  it("builds the exact official site-restricted query", () => {
    expect(buildOfficialSearchQuery("latest Cardano node", ["docs.cardano.org", "github.com"]))
      .toBe("latest Cardano node (site:docs.cardano.org OR site:github.com)");
  });

  it("uses only the configured search origin and bounded search parameters", async () => {
    const fetch = vi.fn<SearxngFetch>(async (url, init) => {
      expect(String(url)).toBe("https://search.example.test/search?q=Cardano+node&format=json&safesearch=1");
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("error");
      expect((init?.headers as Record<string, string>)["accept-encoding"]).toBe("identity");
      return jsonResponse({ results: [result("https://docs.cardano.org/node")] });
    });
    const client = new SearxngClient(new URL("https://search.example.test/"), fetch);

    await expect(client.search("Cardano node")).resolves.toEqual([result("https://docs.cardano.org/node")]);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("rejects malformed, wrong MIME, non-success, oversized, and aborted responses", async () => {
    const fetch = vi.fn<SearxngFetch>();
    const client = new SearxngClient(new URL("https://search.example.test/"), fetch);
    fetch.mockResolvedValueOnce(new Response("not-json", { headers: { "content-type": "application/json" } }));
    await expect(client.search("Cardano")).rejects.toThrow(/response/i);
    fetch.mockResolvedValueOnce(new Response("{}", { headers: { "content-type": "text/plain" } }));
    await expect(client.search("Cardano")).rejects.toThrow(/response/i);
    fetch.mockResolvedValueOnce(new Response("error", { status: 503, headers: { "content-type": "application/json" } }));
    await expect(client.search("Cardano")).rejects.toThrow(/request/i);
    fetch.mockResolvedValueOnce(new Response("x", {
      headers: { "content-type": "application/json", "content-length": String(1_048_577) },
    }));
    await expect(client.search("Cardano")).rejects.toThrow(/response/i);

    const controller = new AbortController();
    fetch.mockImplementationOnce(async (_url, init) => {
      await new Promise<void>((resolve) => init?.signal?.addEventListener("abort", () => resolve(), { once: true }));
      throw new DOMException("aborted", "AbortError");
    });
    const pending = client.search("Cardano", controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow(/request/i);
  });

  it("accepts at most ten valid first results and fails closed on a malformed root", async () => {
    const fetch = vi.fn<SearxngFetch>(async () => jsonResponse({
      results: Array.from({ length: 12 }, (_, index) => result(`https://docs.cardano.org/${index}`)),
    }));
    const client = new SearxngClient(new URL("https://search.example.test/"), fetch);
    await expect(client.search("Cardano")).resolves.toHaveLength(10);
    fetch.mockResolvedValueOnce(jsonResponse({ results: "bad" }));
    await expect(client.search("Cardano")).rejects.toThrow(/response/i);
  });

  it("enforces a bounded search deadline", async () => {
    const fetch = vi.fn<SearxngFetch>(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    const client = new SearxngClient(new URL("https://search.example.test/"), fetch, 5);
    await expect(client.search("Cardano timeout")).rejects.toThrow(/request/i);
  });

  it("rejects invalid search timeout overrides", () => {
    expect(() => new SearxngClient(new URL("https://search.example.test/"), undefined, 0)).toThrow(/timeout/i);
    expect(() => new SearxngClient(new URL("https://search.example.test/"), undefined, 5_001)).toThrow(/timeout/i);
    expect(() => new SearxngClient(new URL("https://search.example.test/"), undefined, 1.5)).toThrow(/timeout/i);
  });

  it("keeps valid results whose optional snippet is absent", async () => {
    const fetch = vi.fn<SearxngFetch>(async () => jsonResponse({ results: [{ title: "Cardano", url: "https://docs.cardano.org/" }] }));
    const client = new SearxngClient(new URL("https://search.example.test/"), fetch);
    await expect(client.search("Cardano")).resolves.toEqual([{ title: "Cardano", content: "", url: "https://docs.cardano.org/" }]);
  });

  it("bounds result text, discards malformed items, and sanitizes network errors", async () => {
    const fetch = vi.fn<SearxngFetch>(async () => jsonResponse({ results: [
      {},
      result("https://docs.cardano.org/guide", "T".repeat(500)),
    ] }));
    const client = new SearxngClient(new URL("https://search.example.test/"), fetch);
    const results = await client.search("Cardano");
    expect(results).toHaveLength(1);
    expect(results[0]!.title).toHaveLength(300);
    expect(results[0]!.content).toHaveLength(21);

    fetch.mockRejectedValueOnce(new Error("network provider-secret"));
    const error = await client.search("Cardano").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("SearXNG request failed");
    expect((error as Error).message).not.toContain("provider-secret");
  });

  it("discards unsafe URLs and never promotes a discovery result before indexing", async () => {
    const search = vi.fn(async (_query: string) => [
      result("http://docs.cardano.org/insecure"),
      result("https://user:pass@docs.cardano.org/credentials"),
      result("https://127.0.0.1/private"),
      result("https://localhost/private"),
      result("https://evil.example.org/off-domain"),
      result("https://docs.cardano.org/guide#fragment", "Official guide"),
      result("https://community.example.org/community", "Community guide"),
    ]);
    const links = await discoverLiveSources({
      query: "Cardano guide",
      registry: [entry, communityEntry],
      search: { search },
    });
    expect(search.mock.calls[0]?.[0]).toBe("Cardano guide (site:docs.cardano.org)");
    expect(links).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: "https://docs.cardano.org/guide", trustTier: "unverified", matchedSourceId: "official-docs" }),
      expect.objectContaining({ url: "https://community.example.org/community", trustTier: "unverified" }),
      expect.objectContaining({ url: "https://evil.example.org/off-domain", trustTier: "unverified" }),
    ]));
    expect(links.find((link) => link.url === "https://community.example.org/community")).not.toHaveProperty("matchedSourceId");
    expect(links).toHaveLength(3);

    const officialLink = links.find((link) => link.matchedSourceId === entry.id)!;
    const repository = fakeRepository();
    const promoted = await promoteDiscoveredLink({
      link: officialLink,
      registry: [entry, communityEntry],
      repository,
      embedder: { embed: vi.fn(async () => [{ index: 0, embedding: Array.from({ length: 1_536 }, () => 0) }]) },
      embeddingModel: "cardano-embedding",
      request: fakeRequest("<html><body><h1>Official guide</h1><p>Cardano source text.</p></body></html>"),
      lookup: async () => [{ address: "93.184.216.34", family: 4 as const }],
      signal: new AbortController().signal,
    });
    expect(promoted).toMatchObject({
      sourceId: "official-docs",
      trustTier: "official",
      versionId: "91",
      title: "Official guide",
      content: expect.stringContaining("Cardano source text"),
    });
    expect("versionHash" in promoted ? promoted.versionHash : undefined).toMatch(/^[0-9a-f]{64}$/);
    expect(repository.ensureSource).toHaveBeenCalledWith(entry, expect.objectContaining({ signal: expect.any(AbortSignal), deadlineAt: expect.any(Number) }));
  });

  it("rejects wallet recovery phrases before calling live search", async () => {
    const search = vi.fn(async () => [result("https://docs.cardano.org/guide")]);
    const phrase = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    await expect(discoverLiveSources({ query: phrase, registry: [entry], search: { search } })).rejects.toThrow(/wallet|secret/i);
    expect(search).not.toHaveBeenCalled();
    await expect(discoverLiveSources({ query: phrase, registry: [entry], search: { search } })).rejects.not.toThrow(phrase);
  });

  it("fails closed for ambiguous matches and failed promotion", async () => {
    const ambiguous = { ...entry, id: "official-docs-alias" };
    const link: DiscoveredLink = { url: "https://docs.cardano.org/guide", title: "Guide", content: "text", trustTier: "unverified" };
    const search = vi.fn(async () => [result(link.url)]);
    const resultLink = await discoverLiveSources({ query: "Guide", registry: [entry, ambiguous], search: { search } });
    expect(resultLink[0]).not.toHaveProperty("matchedSourceId");
    const request = vi.fn<PublicHttpsRequest>();
    await expect(promoteDiscoveredLink({
      link,
      registry: [entry],
      repository: fakeRepository({ storeVersion: vi.fn(async () => { throw new Error("index failed"); }) }),
      embedder: { embed: vi.fn(async () => []) },
      embeddingModel: "cardano-embedding",
      request,
      lookup: async () => [{ address: "93.184.216.34", family: 4 as const }],
      signal: new AbortController().signal,
    })).rejects.toThrow(/index|failed/i);
    expect(request).toHaveBeenCalledOnce();
  });

  it("selects one tier for domains and returns no matches without searching empty tiers", async () => {
    const search = vi.fn(async (_query: string) => [result("https://community.example.org/community")]);
    await expect(discoverLiveSources({
      query: "Community guide",
      registry: [entry, communityEntry],
      search: { search },
      trustTier: "community",
    })).resolves.toEqual([
      expect.objectContaining({ matchedSourceId: "community-docs" }),
    ]);
    expect(search.mock.calls[0]?.[0]).toBe("Community guide (site:community.example.org)");

    const officialOnly = vi.fn(async () => [result("https://community.example.org/community")]);
    await expect(discoverLiveSources({
      query: "Community guide",
      registry: [communityEntry],
      search: { search: officialOnly },
    })).resolves.toEqual([]);
    expect(officialOnly).not.toHaveBeenCalled();
  });

  it("suppresses community fallback after one official match", async () => {
    const search = vi.fn()
      .mockResolvedValueOnce([result("https://docs.cardano.org/guide")])
      .mockResolvedValueOnce([result("https://community.example.org/community")]);
    const promote = vi.fn(async (link: DiscoveredLink) => link);
    await expect(promoteQuestionSources({
      question: "Cardano guide",
      registry: [entry, communityEntry],
      search: { search },
      promote,
      now: () => 10_000,
    })).resolves.toEqual({ outcome: "promoted", promotedCount: 1 });
    expect(search).toHaveBeenCalledOnce();
    expect(promote).toHaveBeenCalledOnce();
  });

  it("runs exactly one community fallback when official has no match", async () => {
    const search = vi.fn()
      .mockResolvedValueOnce([result("https://unregistered.example.org/guide")])
      .mockResolvedValueOnce([result("https://community.example.org/community")]);
    const promote = vi.fn(async (link: DiscoveredLink) => link);
    await expect(promoteQuestionSources({
      question: "Cardano guide",
      registry: [entry, communityEntry],
      search: { search },
      promote,
    })).resolves.toEqual({ outcome: "promoted", promotedCount: 1 });
    expect(search).toHaveBeenCalledTimes(2);
    expect(search.mock.calls[0]?.[0]).toBe("Cardano guide (site:docs.cardano.org)");
    expect(search.mock.calls[1]?.[0]).toBe("Cardano guide (site:community.example.org)");
    expect(promote).toHaveBeenCalledWith(
      expect.objectContaining({ matchedSourceId: "community-docs" }),
      expect.any(AbortSignal),
      expect.any(Number),
    );
  });

  it("deduplicates URLs and source IDs and promotes only the first three in order", async () => {
    const officialEntries = Array.from({ length: 4 }, (_, index) => ({
      ...entry,
      id: `official-${index}`,
      url: `https://docs${index}.cardano.org/`,
      allowedDomains: [`docs${index}.cardano.org`],
    }));
    let searchSignal: AbortSignal | undefined;
    const search = vi.fn(async (_query: string, signal?: AbortSignal) => {
      expect(signal).toBeInstanceOf(AbortSignal);
      searchSignal = signal;
      return [
        result("https://docs0.cardano.org/a"),
        result("https://docs0.cardano.org/a-duplicate"),
        result("https://docs0.cardano.org/a"),
        result("https://docs1.cardano.org/b"),
        result("https://docs2.cardano.org/c"),
        result("https://docs3.cardano.org/d"),
      ];
    });
    const parent = new AbortController();
    const seenSignals: AbortSignal[] = [];
    const seenDeadlines: number[] = [];
    const promote = vi.fn(async (link: DiscoveredLink, signal: AbortSignal, deadlineAt: number) => {
      seenSignals.push(signal);
      seenDeadlines.push(deadlineAt);
      return link;
    });
    await expect(promoteQuestionSources({
      question: "latest Cardano node",
      registry: officialEntries,
      search: { search },
      promote,
      signal: parent.signal,
      now: () => 10_000,
    })).resolves.toEqual({ outcome: "promoted", promotedCount: 3 });
    expect(promote.mock.calls.map(([link]) => link.matchedSourceId)).toEqual([
      "official-0", "official-1", "official-2",
    ]);
    expect(new Set(seenSignals).size).toBe(1);
    expect(seenSignals[0]).toBe(searchSignal);
    expect(new Set(seenDeadlines)).toEqual(new Set([55_000]));
  });

  it("returns no_match without invoking promotion when neither tier matches", async () => {
    const search = vi.fn(async () => [result("https://unregistered.example.org/guide")]);
    const promote = vi.fn(async (link: DiscoveredLink) => link);
    await expect(promoteQuestionSources({
      question: "Cardano guide",
      registry: [entry, communityEntry],
      search: { search },
      promote,
    })).resolves.toEqual({ outcome: "no_match", promotedCount: 0 });
    expect(search).toHaveBeenCalledTimes(2);
    expect(promote).not.toHaveBeenCalled();
  });

  it("propagates parent abort, deadline validation, and injected failures", async () => {
    const parent = new AbortController();
    parent.abort();
    const abortedSearch = vi.fn(async () => [result("https://docs.cardano.org/guide")]);
    await expect(promoteQuestionSources({
      question: "Cardano guide",
      registry: [entry],
      search: { search: abortedSearch },
      promote: vi.fn(async (link: DiscoveredLink) => link),
      signal: parent.signal,
    })).rejects.toThrow();
    expect(abortedSearch).not.toHaveBeenCalled();

    await expect(promoteQuestionSources({
      question: "Cardano guide",
      registry: [entry],
      search: { search: vi.fn(async () => []) },
      promote: vi.fn(async (link: DiscoveredLink) => link),
      now: () => Number.NaN,
    })).rejects.toThrow(/time|deadline/i);

    const searchFailure = new Error("search failure");
    await expect(promoteQuestionSources({
      question: "Cardano guide",
      registry: [entry],
      search: { search: vi.fn(async () => { throw searchFailure; }) },
      promote: vi.fn(async (link: DiscoveredLink) => link),
    })).rejects.toBe(searchFailure);

    const promoteFailure = new Error("promote failure");
    await expect(promoteQuestionSources({
      question: "Cardano guide",
      registry: [entry],
      search: { search: vi.fn(async () => [result("https://docs.cardano.org/guide")]) },
      promote: vi.fn(async () => { throw promoteFailure; }),
    })).rejects.toBe(promoteFailure);
  });
});
