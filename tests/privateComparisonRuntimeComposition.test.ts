import { describe, expect, it, vi } from "vitest";
import { encryptText } from "@vennek/cardano-agent";
import { PrivateComparisonProviderError, PrivateDocumentClientError } from "@vennek/cardano-agent";
import {
  PRIVATE_COMPARISON_AAD_PREFIX,
  type EncryptedPrivateComparisonJob,
} from "../apps/telegram-bot/src/privateComparisonQueue.js";
import { processPrivateComparisonJob } from "../apps/telegram-bot/src/privateComparisonRuntime.js";

const key = Buffer.alloc(32, 7);
const owner = { updateId: 7, telegramUserId: "42", telegramChatId: "42" } as const;
const metadata = {
  caption: "Compare Cardano governance",
  fileId: "file-1",
  fileUniqueId: "unique-1",
  fileName: "claims.md",
  mime: "text/markdown",
  fileSize: 3,
} as const;

function job(): EncryptedPrivateComparisonJob {
  const encrypted = encryptText(JSON.stringify(metadata), key, `${PRIVATE_COMPARISON_AAD_PREFIX}:7:42:42`);
  return { kind: "private-compare", ...owner, encrypted };
}

function evidence(stale = false) {
  return [{
    id: "E1",
    sourceId: "docs",
    owner: "Cardano Foundation",
    trustTier: "official" as const,
    title: "Governance",
    url: "https://docs.cardano.org/governance",
    excerpt: "Cardano governance uses a constitution.",
    retrievedAt: "2026-08-26T00:00:00.000Z",
    versionHash: "a".repeat(64),
    score: 1,
    stale,
  }];
}

function dependencies(overrides: Record<string, unknown> = {}) {
  const events: string[] = [];
  const complete = vi.fn().mockResolvedValue({
    text: JSON.stringify({ language: "en", claims: [{ text: "A claim", privateCitationIds: ["U1"], cardanoCitationIds: ["E1"], kind: "fact" }] }),
    model: "provider-model",
    promptTokens: 1,
    completionTokens: 1,
  });
  const retrieve = vi.fn(async () => {
    events.push("retrieve");
    return evidence();
  });
  const extract = vi.fn(async () => {
    events.push("extract");
    return { type: "markdown" as const, title: "claims.md", text: "Cardano governance claim" };
  });
  const send = vi.fn(async () => {
    events.push("send");
    return { delivered: true, attempts: 1 };
  });
  return {
    events,
    extractor: { extract },
    api: {
      getFile: vi.fn(async () => {
        events.push("getFile");
        return { file_id: "file-1", file_unique_id: "unique-1", file_size: 3, file_path: "documents/file-1.md" };
      }),
      withDownloadedFile: vi.fn(async (_path: string, _size: number | undefined, _signal: AbortSignal | undefined, consumer: (bytes: Buffer) => void | Promise<void>) => {
        events.push("download");
        await consumer(Buffer.from("abc"));
      }),
    },
    db: {} as never,
    embedder: { embed: vi.fn() },
    retrieve,
    complete,
    generationModel: "cardano-private-quality",
    verifierModel: "cardano-private-verifier",
    embeddingModel: "cardano-embedding",
    send,
    ...overrides,
  };
}

describe("private comparison worker composition", () => {
  it("downloads, extracts, retrieves caption-only evidence, compares, and delivers to the bound chat", async () => {
    const input = dependencies();

    const result = await processPrivateComparisonJob(job(), {
      ...input,
      encryptionKey: key,
      compare: vi.fn(async (comparison) => {
        input.events.push("compare");
        expect(comparison.caption).toBe(metadata.caption);
        expect(comparison.privateDocument.text).not.toContain(metadata.caption);
        expect(comparison.generationModel).toBe("cardano-private-quality");
        expect(comparison.verifierModel).toBe("cardano-private-verifier");
        return "comparison answer";
      }),
    });

    expect(result).toEqual({ delivered: true, attempts: 1 });
    expect(input.events).toEqual(["getFile", "download", "extract", "retrieve", "compare", "send"]);
    expect(input.retrieve).toHaveBeenCalledWith(
      expect.objectContaining({ query: metadata.caption, personalized: true }),
      expect.objectContaining({ db: input.db, embedder: input.embedder }),
    );
    expect((input.retrieve as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).not.toHaveProperty("cachePolicy");
    expect(input.send).toHaveBeenCalledWith(owner.telegramChatId, "comparison answer");
  });

  it("fails before extractor or provider when extracted text contains a wallet secret", async () => {
    const input = dependencies({
      extractor: { extract: vi.fn(async () => ({ type: "text" as const, title: "claims.txt", text: `${Array.from({ length: 11 }, () => "abandon").join(" ")} about` })) },
    });
    const retrieve = input.retrieve as ReturnType<typeof vi.fn>;
    const send = input.send as ReturnType<typeof vi.fn>;

    await expect(processPrivateComparisonJob(job(), { ...input, encryptionKey: key })).resolves.toMatchObject({ delivered: true });
    expect(retrieve).not.toHaveBeenCalled();
    expect(input.complete).not.toHaveBeenCalled();
    expect(send.mock.calls[0]?.[1]).not.toContain("abandon");
  });

  it("does not invoke private models when Cardano evidence is empty or stale", async () => {
    for (const result of [[], evidence(true)]) {
      const input = dependencies({ retrieve: vi.fn(async () => result) });
      const compare = vi.fn(async () => "insufficient evidence");

      await expect(processPrivateComparisonJob(job(), { ...input, encryptionKey: key, compare })).resolves.toMatchObject({ delivered: true });
      expect(compare).toHaveBeenCalledOnce();
      expect(input.complete).not.toHaveBeenCalled();
    }
  });

  it("marks a failed delivery as not delivered without binding it to another chat", async () => {
    const markStatus = vi.fn(async () => undefined);
    const input = dependencies({ markStatus, send: vi.fn(async (chatId: string) => {
      expect(chatId).toBe(owner.telegramChatId);
      return { delivered: false, attempts: 3 };
    }) });

    await expect(processPrivateComparisonJob(job(), { ...input, encryptionKey: key })).resolves.toEqual({ delivered: false, attempts: 3 });
    expect(markStatus).toHaveBeenCalledWith(owner.updateId, "failed");
  });

  it("does not expose private input when a stage fails", async () => {
    const markStatus = vi.fn(async () => undefined);
    const log = vi.fn();
    const input = dependencies({ markStatus, log, retrieve: vi.fn(async () => { throw new Error(`${metadata.caption} ${metadata.fileName}`); }) });

    await expect(processPrivateComparisonJob(job(), { ...input, encryptionKey: key })).rejects.toThrow(/retrieval/i);
    expect(markStatus).toHaveBeenCalledWith(owner.updateId, "failed");
    expect(log).toHaveBeenCalledWith("retrieval");
    expect(JSON.stringify(log.mock.calls)).not.toContain(metadata.caption);
  });

  it("does not mutate status from an unauthenticated outer update id", async () => {
    const markStatus = vi.fn(async () => undefined);
    await expect(processPrivateComparisonJob({ updateId: owner.updateId, encrypted: "invalid" }, {
      ...dependencies(),
      encryptionKey: key,
      markStatus,
    })).rejects.toThrow(/validation/i);
    expect(markStatus).not.toHaveBeenCalled();
  });

  it("does not redeliver when the processed status write fails", async () => {
    const markStatus = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("database unavailable"));
    const input = dependencies({ markStatus });
    const result = await processPrivateComparisonJob(job(), { ...input, encryptionKey: key });

    expect(result.delivered).toBe(true);
    expect(input.send).toHaveBeenCalledOnce();
    expect(markStatus.mock.calls).toEqual([[owner.updateId, "failed"], [owner.updateId, "processed"]]);
  });

  it("rethrows provider outages without delivery", async () => {
    const input = dependencies({ compare: vi.fn(async () => { throw new PrivateComparisonProviderError("generation"); }) });
    const markStatus = vi.fn(async () => undefined);
    await expect(processPrivateComparisonJob(job(), { ...input, encryptionKey: key, markStatus })).rejects.toBeInstanceOf(PrivateComparisonProviderError);
    expect(input.send).not.toHaveBeenCalled();
    expect(markStatus).toHaveBeenCalledWith(owner.updateId, "failed");
  });

  it("reuses the shared language detector for Vietnamese captions", async () => {
    const input = dependencies();
    const compare = vi.fn(async (comparison) => {
      expect(comparison.language).toBe("vi");
      return "câu trả lời";
    });
    await expect(processPrivateComparisonJob(jobWithCaption("So sánh tuyên bố staking của Cardano"), {
      ...input,
      encryptionKey: key,
      compare,
    })).resolves.toMatchObject({ delivered: true });
    expect((input.retrieve as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.language).toBe("vi");
  });

  it("sends one localized terminal message for permanent extractor failures", async () => {
    const markStatus = vi.fn(async () => undefined);
    const send = vi.fn(async (_chatId: string, text: string) => ({ delivered: true, attempts: 1, text }));
    const input = dependencies({
      markStatus,
      send,
      extractor: { extract: vi.fn(async () => { throw new PrivateDocumentClientError("rejected", false, 422); }) },
    });
    const result = await processPrivateComparisonJob(jobWithCaption("So sánh tài liệu Cardano"), { ...input, encryptionKey: key });

    expect(result).toMatchObject({ delivered: true, terminal: true });
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[1]).toMatch(/Xin lỗi/);
    expect(markStatus.mock.calls).toEqual([[owner.updateId, "failed"], [owner.updateId, "processed"]]);
  });

  it("retries transient extractor failures without disclosure", async () => {
    const markStatus = vi.fn(async () => undefined);
    const send = vi.fn(async () => ({ delivered: true, attempts: 1 }));
    const input = dependencies({
      markStatus,
      send,
      extractor: { extract: vi.fn(async () => { throw new PrivateDocumentClientError("busy", true, 503); }) },
    });
    await expect(processPrivateComparisonJob(job(), { ...input, encryptionKey: key })).rejects.toThrow(/extraction/i);
    expect(send).not.toHaveBeenCalled();
    expect(markStatus.mock.calls).toEqual([[owner.updateId, "failed"], [owner.updateId, "failed"]]);
  });

  it("terminates unsupported evidence without retrying the private comparison", async () => {
    const markStatus = vi.fn(async () => undefined);
    const compare = vi.fn(async () => "comparison answer");
    const input = dependencies({
      markStatus,
      compare,
      retrieve: vi.fn(async () => ({ unsupported: true })),
    });

    await expect(processPrivateComparisonJob(job(), { ...input, encryptionKey: key })).resolves.toMatchObject({
      delivered: true,
      terminal: true,
    });
    expect(compare).not.toHaveBeenCalled();
    expect(input.send).toHaveBeenCalledOnce();
  });

  it("stops without delivery when the worker signal aborts during comparison", async () => {
    const controller = new AbortController();
    const input = dependencies({
      signal: controller.signal,
      compare: vi.fn(async () => {
        controller.abort();
        return "late answer";
      }),
    });
    await expect(processPrivateComparisonJob(job(), { ...input, encryptionKey: key })).resolves.toMatchObject({ aborted: true, delivered: false });
    expect(input.send).not.toHaveBeenCalled();
  });

  it("completes a permanent Telegram delivery failure without rerunning comparison", async () => {
    const markStatus = vi.fn(async () => undefined);
    const compare = vi.fn(async () => "comparison answer");
    const input = dependencies({
      markStatus,
      compare,
      send: vi.fn(async () => ({ delivered: false, attempts: 1, status: 400 })),
    });

    await expect(processPrivateComparisonJob(job(), { ...input, encryptionKey: key })).resolves.toMatchObject({
      delivered: false,
      terminal: true,
      status: 400,
    });
    expect(compare).toHaveBeenCalledOnce();
    expect(markStatus.mock.calls).toEqual([[owner.updateId, "failed"], [owner.updateId, "failed"]]);
  });

  it("stops delivery when cancellation arrives while Telegram send is in flight", async () => {
    const controller = new AbortController();
    const markStatus = vi.fn(async () => undefined);
    const send = vi.fn(async () => {
      controller.abort();
      return { delivered: true, attempts: 1 };
    });
    const input = dependencies({ signal: controller.signal, markStatus, send });

    await expect(processPrivateComparisonJob(job(), { ...input, encryptionKey: key })).resolves.toMatchObject({
      delivered: false,
      aborted: true,
    });
    expect(markStatus.mock.calls).toEqual([[owner.updateId, "failed"], [owner.updateId, "failed"]]);
  });
});

function jobWithCaption(caption: string): EncryptedPrivateComparisonJob {
  const encrypted = encryptText(JSON.stringify({ ...metadata, caption }), key, `${PRIVATE_COMPARISON_AAD_PREFIX}:7:42:42`);
  return { kind: "private-compare", ...owner, encrypted };
}
