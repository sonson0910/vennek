import { describe, expect, it, vi } from "vitest";
import { syncSource } from "../packages/cardano-agent/src/knowledge/syncSource.js";
import type { SourceRegistryEntry } from "@vennek/cardano-agent";

const entry: SourceRegistryEntry = {
  id: "cardano-docs",
  owner: "Cardano",
  trustTier: "official",
  kind: "page",
  url: "https://docs.cardano.org/",
  allowedDomains: ["docs.cardano.org"],
  topics: ["developer"],
  networks: ["mainnet"],
  refresh: "daily",
};

describe("syncSource", () => {
  it("composes crawl then index with the same repository, signal, and embedding settings", async () => {
    const repository = {} as never;
    const signal = new AbortController().signal;
    const crawl = vi.fn(async () => ({ documents: [], unchanged: 2 }));
    const index = vi.fn(async () => ({ documents: [], indexed: 0, skipped: 0, unchanged: 2, committed: false }));
    const embedder = { embed: vi.fn() };

    await expect(syncSource({ entry, repository, signal, embedder, embeddingModel: "cardano-embedding" }, { crawl, index })).resolves.toMatchObject({ unchanged: 2 });
    expect(crawl).toHaveBeenCalledWith(expect.objectContaining({ entry, repository, signal }));
    expect(index).toHaveBeenCalledWith(expect.objectContaining({ repository, embedder, embeddingModel: "cardano-embedding", signal, crawlResult: { documents: [], unchanged: 2 } }));
  });

  it("does not invoke the indexer when crawling fails", async () => {
    const index = vi.fn();
    await expect(syncSource({
      entry,
      repository: {} as never,
      signal: new AbortController().signal,
      embedder: { embed: vi.fn() },
      embeddingModel: "cardano-embedding",
    }, {
      crawl: vi.fn(async () => { throw new Error("crawl failed"); }),
      index,
    })).rejects.toThrow("crawl failed");
    expect(index).not.toHaveBeenCalled();
  });
});
