import { describe, expect, it, vi } from "vitest";
import { sha256Hex } from "@vennek/shared";
import {
  indexCrawlResult,
  indexDocument,
  type IndexDocumentDependencies,
} from "../packages/cardano-agent/src/knowledge/indexDocument.js";

const now = new Date("2026-08-24T00:00:00.000Z");
const model = "cardano-embedding";

function vector(value = 0): number[] {
  return Array.from({ length: 1_536 }, () => value);
}

function document(text = "# Heading\n\nCardano body.") {
  return {
    sourceId: "cardano-docs",
    canonicalUrl: "https://docs.cardano.org/about",
    trustTier: "official" as const,
    title: "About Cardano",
    text,
    retrievedAt: now,
  };
}

function dependencies(overrides: Partial<IndexDocumentDependencies> = {}): IndexDocumentDependencies & {
  stored: Array<Record<string, unknown>>;
  replacements: Array<unknown[]>;
} {
  const stored: Array<Record<string, unknown>> = [];
  const replacements: Array<unknown[]> = [];
  return {
    repository: {
      storeVersion: vi.fn(async (input) => {
        stored.push(input as Record<string, unknown>);
        return { id: "42" };
      }),
      hasCompleteChunks: vi.fn(async () => false),
      replaceChunks: vi.fn(async (_versionId, chunks) => { replacements.push(chunks); }),
    },
    embedder: {
      embed: vi.fn(async (inputs: string[]) => inputs.map((_, index) => ({ index, embedding: vector(index) }))),
    },
    embeddingModel: model,
    stored,
    replacements,
    ...overrides,
  } as unknown as IndexDocumentDependencies & { stored: Array<Record<string, unknown>>; replacements: Array<unknown[]> };
}

describe("indexDocument", () => {
  it("rejects documents over the bounded source size before storing", async () => {
    const deps = dependencies();

    await expect(indexDocument({ ...document("x".repeat(2_000_001)), ...deps })).rejects.toThrow(/large|size/i);
    expect(deps.repository.storeVersion).not.toHaveBeenCalled();
    expect(deps.embedder.embed).not.toHaveBeenCalled();
  });

  it("rejects a non-finite public deadline safely", async () => {
    const deps = dependencies();

    await expect(indexDocument({ ...document(), ...deps, deadlineAt: Number.POSITIVE_INFINITY })).rejects.toThrow(/deadline/i);
    expect(deps.repository.storeVersion).not.toHaveBeenCalled();
  });

  it("caps a far-future public deadline to the fixed job window", async () => {
    const deps = dependencies();
    const deadlineAt = Date.now() + 10 ** 15;

    await expect(indexDocument({ ...document(), ...deps, deadlineAt })).resolves.toMatchObject({ indexed: true });
    const options = vi.mocked(deps.repository.replaceChunks).mock.calls[0]?.[2] as { deadlineAt?: number } | undefined;
    expect(options?.deadlineAt).toBeLessThanOrEqual(Date.now() + 120_000);
  });

  it("rejects aggregate chunk amplification before embedding or replacement", async () => {
    const deps = dependencies();
    const text = Array.from({ length: 2_501 }, (_, index) => [
      `# H${index}`,
      "",
      "```",
      "x",
      "```",
    ].join("\n")).join("\n\n");

    await expect(indexDocument({ ...document(text), ...deps })).rejects.toThrow(/chunk|embedding|budget/i);
    expect(deps.embedder.embed).not.toHaveBeenCalled();
    expect(deps.repository.replaceChunks).not.toHaveBeenCalled();
  });

  it("rejects an already-aborted caller before storing or embedding", async () => {
    const deps = dependencies();
    const controller = new AbortController();
    controller.abort();

    await expect(indexDocument({ ...document(), ...deps, signal: controller.signal })).rejects.toThrow(/abort/i);
    expect(deps.repository.storeVersion).not.toHaveBeenCalled();
    expect(deps.embedder.embed).not.toHaveBeenCalled();
  });

  it("rejects an empty embedding model before storing or embedding", async () => {
    const deps = dependencies({ embeddingModel: " " });

    await expect(indexDocument({ ...document(), ...deps })).rejects.toThrow(/embedding model/i);
    expect(deps.repository.storeVersion).not.toHaveBeenCalled();
    expect(deps.embedder.embed).not.toHaveBeenCalled();
  });

  it("normalizes text, stores the version first, and atomically indexes ordered chunks", async () => {
    const deps = dependencies();
    const result = await indexDocument({ ...document("\r\n# Heading\r\n\r\nCardano body.\r\n"), ...deps });

    expect(deps.stored[0]).toMatchObject({
      content: "# Heading\n\nCardano body.",
      contentHash: sha256Hex("# Heading\n\nCardano body."),
    });
    expect(deps.repository.storeVersion).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ signal: expect.any(AbortSignal), deadlineAt: expect.any(Number) }));
    expect(deps.repository.hasCompleteChunks).toHaveBeenCalledWith("42", model, [expect.stringMatching(/^[0-9a-f]{64}$/)], expect.objectContaining({ signal: expect.any(AbortSignal), deadlineAt: expect.any(Number) }));
    expect(deps.embedder.embed).toHaveBeenCalledWith(["Heading\nCardano body."], expect.any(AbortSignal));
    expect(deps.replacements[0]).toHaveLength(1);
    expect(result).toMatchObject({ versionId: "42", contentHash: sha256Hex("# Heading\n\nCardano body."), chunkCount: 1, indexed: true });
  });

  it("skips embedding when the stored version already has exact complete chunks", async () => {
    const deps = dependencies();
    vi.mocked(deps.repository.hasCompleteChunks).mockResolvedValue(true);

    await expect(indexDocument({ ...document(), ...deps })).resolves.toMatchObject({ versionId: "42", indexed: false });
    expect(deps.embedder.embed).not.toHaveBeenCalled();
    expect(deps.repository.replaceChunks).not.toHaveBeenCalled();
  });

  it("does not report success when the caller aborts during completeness lookup", async () => {
    const deps = dependencies();
    const controller = new AbortController();
    vi.mocked(deps.repository.hasCompleteChunks).mockImplementation(async () => {
      controller.abort();
      return true;
    });

    await expect(indexDocument({ ...document(), ...deps, signal: controller.signal })).rejects.toThrow(/abort/i);
    expect(deps.embedder.embed).not.toHaveBeenCalled();
  });

  it("rejects an embedder response whose global indexes are not contiguous", async () => {
    const deps = dependencies();
    vi.mocked(deps.embedder.embed).mockResolvedValue([{ index: 1, embedding: vector() }]);

    await expect(indexDocument({ ...document(), ...deps })).rejects.toThrow(/index/i);
    expect(deps.repository.replaceChunks).not.toHaveBeenCalled();
  });
});

describe("indexCrawlResult", () => {
  it("commits staged GitHub state once after every document is durably indexed", async () => {
    const deps = dependencies();
    const commitState = vi.fn(async () => true);
    const result = await indexCrawlResult({
      crawlResult: { documents: [document(), document("# Other\n\nOther body.")], unchanged: 2, commitState },
      ...deps,
    });

    expect(result.indexed).toBe(2);
    expect(commitState).toHaveBeenCalledTimes(1);
    expect(commitState).toHaveBeenCalledWith(expect.objectContaining({ signal: expect.any(AbortSignal), deadlineAt: expect.any(Number) }));
    expect(deps.repository.replaceChunks).toHaveBeenCalledWith("42", expect.any(Array), expect.objectContaining({ signal: expect.any(AbortSignal), deadlineAt: expect.any(Number) }));
  });

  it("shares one caller signal across documents and stops before later documents", async () => {
    const deps = dependencies();
    const controller = new AbortController();
    vi.mocked(deps.repository.replaceChunks).mockImplementation(async () => {
      controller.abort();
    });

    await expect(indexCrawlResult({
      crawlResult: { documents: [document(), document("# Other\n\nOther body.")], unchanged: 0 },
      ...deps,
      signal: controller.signal,
    })).rejects.toThrow(/abort/i);
    expect(deps.repository.storeVersion).toHaveBeenCalledTimes(1);
  });

  it("does not commit staged state when indexing fails", async () => {
    const deps = dependencies();
    vi.mocked(deps.embedder.embed).mockRejectedValue(new Error("provider failed"));
    const commitState = vi.fn(async () => true);

    await expect(indexCrawlResult({ crawlResult: { documents: [document()], unchanged: 0, commitState }, ...deps })).rejects.toThrow(/provider failed/);
    expect(commitState).not.toHaveBeenCalled();
  });

  it("treats a failed staged CAS as an error after durable indexing", async () => {
    const deps = dependencies();
    const commitState = vi.fn(async () => false);

    await expect(indexCrawlResult({ crawlResult: { documents: [document()], unchanged: 0, commitState }, ...deps })).rejects.toThrow(/commit/i);
    expect(deps.repository.replaceChunks).toHaveBeenCalledTimes(1);
  });
});
