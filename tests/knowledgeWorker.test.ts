import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createKnowledgePromotionHandler } from "../apps/telegram-bot/src/main.js";
import {
  KNOWLEDGE_DAILY_CRON,
  KNOWLEDGE_DEAD_QUEUE,
  KNOWLEDGE_HOURLY_CRON,
  KNOWLEDGE_QUEUE,
  KNOWLEDGE_QUEUE_OPTIONS,
  KNOWLEDGE_SCHEDULE_PREFIX,
  enqueueKnowledgeSource,
  loadKnowledgeSourceMap,
  reconcileKnowledgeSchedules,
  registerKnowledgeWorker,
  scheduleKnowledgeSources,
  validateKnowledgeJob,
  type KnowledgeJob,
  type KnowledgeBoss,
} from "../apps/telegram-bot/src/knowledgeWorker.js";
import type { JobWithMetadata } from "pg-boss";

function fakeBoss() {
  let handler: ((jobs: Array<{ data: unknown; signal: AbortSignal }>) => Promise<unknown>) | undefined;
  return {
    createQueue: vi.fn(async () => undefined),
    schedule: vi.fn(async () => undefined),
    unschedule: vi.fn(async () => undefined),
    getSchedules: vi.fn(async () => [] as Array<{ name: string; key: string; cron: string; timezone: string }>),
    findJobs: vi.fn(async () => [] as JobWithMetadata<KnowledgeJob>[]),
    send: vi.fn(async (): Promise<string | null> => "job-1"),
    work: vi.fn(async (_name: string, callback: (jobs: Array<{ data: unknown; signal: AbortSignal }>) => Promise<unknown>) => {
      handler = callback;
      return "worker-1";
    }),
    invoke: async (data: unknown, signal = new AbortController().signal) => handler?.([{ data, signal }]),
  };
}

describe("knowledge worker contract", () => {
  it("uses one registry snapshot for search promotion and revalidation", async () => {
    const registry = [{
      id: "official-docs",
      owner: "Cardano",
      trustTier: "official" as const,
      kind: "page" as const,
      url: "https://docs.cardano.org/",
      allowedDomains: ["docs.cardano.org"],
      topics: ["developer"],
      networks: ["mainnet" as const],
      refresh: "daily" as const,
    }];
    const loadRegistry = vi.fn(() => registry);
    const search = vi.fn(async () => [{ title: "Guide", content: "Cardano docs", url: "https://docs.cardano.org/guide" }]);
    const promoteLink = vi.fn(async (input: { registry: unknown; link: unknown }) => ({ ...input.link as object, sourceId: "official-docs" }));
    const promote = createKnowledgePromotionHandler({
      loadRegistry,
      search: { search },
      promoteLink: promoteLink as never,
      repository: {} as never,
      embedder: {} as never,
      embeddingModel: "cardano-embedding",
    });

    await expect(promote("Cardano guide", new AbortController().signal)).resolves.toEqual({ outcome: "promoted", promotedCount: 1 });
    expect(loadRegistry).toHaveBeenCalledOnce();
    expect(promoteLink).toHaveBeenCalledWith(expect.objectContaining({ registry }));
    expect((promoteLink.mock.calls[0]?.[0] as { registry: unknown }).registry).toBe(registry);
  });

  it("rejects a promotion result without a source id generically", async () => {
    const promote = createKnowledgePromotionHandler({
      loadRegistry: () => [{
        id: "official-docs",
        owner: "Cardano",
        trustTier: "official" as const,
        kind: "page" as const,
        url: "https://docs.cardano.org/",
        allowedDomains: ["docs.cardano.org"],
        topics: ["developer"],
        networks: ["mainnet" as const],
        refresh: "daily" as const,
      }],
      search: { search: async () => [{ title: "Guide", content: "Cardano docs", url: "https://docs.cardano.org/guide" }] },
      promoteLink: (async (input: { link: unknown }) => input.link) as never,
      repository: {} as never,
      embedder: {} as never,
      embeddingModel: "cardano-embedding",
    });

    await expect(promote("Cardano guide", new AbortController().signal)).rejects.toThrow("Live source promotion failed");
  });

  it("uses a native pg-boss-safe schedule key prefix", () => {
    expect(KNOWLEDGE_SCHEDULE_PREFIX).toBe("source/");
  });

  it("rejects non-plain or extra-field jobs", () => {
    expect(() => validateKnowledgeJob({ sourceId: "cardano-org", extra: true })).toThrow(/exactly/i);
    expect(() => validateKnowledgeJob(Object.assign(Object.create(null), { sourceId: "cardano-org" }))).not.toThrow();
    expect(() => validateKnowledgeJob({ sourceId: "Cardano Org" })).toThrow(/invalid/i);
  });

  it("schedules each source in UTC with the declared refresh cadence", async () => {
    const boss = fakeBoss();
    const entries = loadKnowledgeSourceMap();
    await scheduleKnowledgeSources(boss, entries);
    expect(boss.schedule).not.toHaveBeenCalledWith(
      KNOWLEDGE_QUEUE,
      expect.any(String),
      { sourceId: "cardano-foundation" },
      expect.any(Object),
    );
    expect(boss.schedule).toHaveBeenCalledWith(
      KNOWLEDGE_QUEUE,
      KNOWLEDGE_DAILY_CRON,
      { sourceId: "cardano-foundation-github" },
      expect.objectContaining({ key: "source/cardano-foundation-github", singletonKey: "cardano-foundation-github" }),
    );
    expect(boss.schedule).toHaveBeenCalledWith(KNOWLEDGE_QUEUE, KNOWLEDGE_DAILY_CRON, expect.any(Object), expect.objectContaining({ tz: "UTC", key: "source/cardano-docs", singletonKey: "cardano-docs", policy: "exclusive" }));
    expect(boss.schedule).toHaveBeenCalledWith(KNOWLEDGE_QUEUE, KNOWLEDGE_HOURLY_CRON, expect.any(Object), expect.objectContaining({ tz: "UTC", key: "source/intersect", singletonKey: "intersect", policy: "exclusive" }));
  });

  it("loads the tiered file into an exact source-id Map", () => {
    const entries = loadKnowledgeSourceMap();
    expect(entries).toBeInstanceOf(Map);
    expect(entries.get("cardano-org")).toMatchObject({ id: "cardano-org", trustTier: "official" });
    expect(entries.get("https://cardano.org/")).toBeUndefined();
  });

  it("reconciles removed source schedules without touching unrelated keys", async () => {
    const boss = fakeBoss();
    boss.getSchedules.mockResolvedValue([
      { name: KNOWLEDGE_QUEUE, key: "source/removed", cron: "0 * * * *", timezone: "UTC" },
      { name: KNOWLEDGE_QUEUE, key: "source/cardano-foundation", cron: "0 * * * *", timezone: "UTC" },
      { name: KNOWLEDGE_QUEUE, key: "operator", cron: "0 * * * *", timezone: "UTC" },
    ]);
    await reconcileKnowledgeSchedules(boss, loadKnowledgeSourceMap());
    expect(boss.unschedule).toHaveBeenCalledWith(KNOWLEDGE_QUEUE, "source/removed");
    expect(boss.unschedule).toHaveBeenCalledWith(KNOWLEDGE_QUEUE, "source/cardano-foundation");
    expect(boss.unschedule).toHaveBeenCalledTimes(2);
  });

  it("creates the queue policy and reloads the registry for each job", async () => {
    const boss = fakeBoss();
    const sync = vi.fn(async (_entry: unknown, _signal: AbortSignal) => undefined);
    await registerKnowledgeWorker({ boss: boss as unknown as KnowledgeBoss, sync });
    expect(boss.createQueue).toHaveBeenCalledWith(KNOWLEDGE_DEAD_QUEUE, expect.objectContaining({ policy: "standard" }));
    expect(boss.createQueue).toHaveBeenCalledWith(KNOWLEDGE_QUEUE, expect.objectContaining(KNOWLEDGE_QUEUE_OPTIONS));
    await boss.invoke({ sourceId: "cardano-org" });
    await boss.invoke({ sourceId: "cardano-org" });
    expect(sync).toHaveBeenCalledTimes(2);
    expect(sync).toHaveBeenCalledWith(expect.objectContaining({ id: "cardano-org" }), expect.any(AbortSignal));
  });

  it("rejects stale monitor-only jobs before synchronization", async () => {
    const boss = fakeBoss();
    const sync = vi.fn(async () => undefined);
    const directory = mkdtempSync(join(tmpdir(), "vennek-knowledge-worker-"));
    const registryPath = join(directory, "cardano-sources.json");
    const registry = JSON.parse(readFileSync(new URL("../config/cardano-sources.json", import.meta.url), "utf8")) as {
      official: Array<Record<string, unknown>>;
      community: Array<Record<string, unknown>>;
    };
    const foundation = registry.official.find((entry) => entry.id === "cardano-foundation")!;
    foundation.ingestionMode = "scheduled";
    delete foundation.liveFallbackIds;
    writeFileSync(registryPath, JSON.stringify(registry));

    try {
      await registerKnowledgeWorker({ boss: boss as unknown as KnowledgeBoss, sync, registryPath });
      foundation.ingestionMode = "monitor-only";
      foundation.liveFallbackIds = ["cardano-foundation-github"];
      writeFileSync(registryPath, JSON.stringify(registry));

      const error = await boss.invoke({ sourceId: "cardano-foundation" }).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("Source is monitor-only and cannot be synchronized.");
      expect(sync).not.toHaveBeenCalled();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("passes pg-boss job cancellation to source synchronization", async () => {
    const boss = fakeBoss();
    const sync = vi.fn(async () => undefined);
    await registerKnowledgeWorker({ boss: boss as unknown as KnowledgeBoss, sync });
    const controller = new AbortController();
    await boss.invoke({ sourceId: "cardano-org" }, controller.signal);
    expect(sync).toHaveBeenCalledWith(expect.objectContaining({ id: "cardano-org" }), controller.signal);
  });

  it("combines pg-boss and worker cancellation when both are supplied", async () => {
    const boss = fakeBoss();
    const sync = vi.fn(async (_entry: unknown, _signal: AbortSignal) => undefined);
    const workerController = new AbortController();
    await registerKnowledgeWorker({ boss: boss as unknown as KnowledgeBoss, sync, signal: workerController.signal });
    const jobController = new AbortController();
    await boss.invoke({ sourceId: "cardano-org" }, jobController.signal);
    const combined = vi.mocked(sync).mock.calls[0]?.[1];
    expect(combined).toBeInstanceOf(AbortSignal);
    expect(combined).not.toBe(workerController.signal);
    expect(combined).not.toBe(jobController.signal);
    jobController.abort();
    expect(combined?.aborted).toBe(true);
  });

  it("uses the exclusive queue policy so duplicate source jobs collapse natively", () => {
    expect(KNOWLEDGE_QUEUE_OPTIONS.policy).toBe("exclusive");
  });

  it("does not enqueue an unregistered admin id and sends the exact payload", async () => {
    const boss = fakeBoss();
    await expect(enqueueKnowledgeSource(boss as unknown as Pick<KnowledgeBoss, "send" | "findJobs">, "cardano-org")).resolves.toBe("job-1");
    expect(boss.send).toHaveBeenCalledWith(KNOWLEDGE_QUEUE, { sourceId: "cardano-org" }, expect.objectContaining({ singletonKey: "cardano-org", policy: "exclusive", retryLimit: 2 }));
    await expect(enqueueKnowledgeSource(boss as unknown as Pick<KnowledgeBoss, "send" | "findJobs">, "not-a-source")).rejects.toThrow(/unknown/i);
  });

  it("rejects monitor-only sources before queue lookup or enqueue", async () => {
    const boss = fakeBoss();

    const error = await enqueueKnowledgeSource(boss as unknown as Pick<KnowledgeBoss, "send" | "findJobs">, "cardano-foundation")
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Source is monitor-only and cannot be synchronized.");
    expect(boss.findJobs).not.toHaveBeenCalled();
    expect(boss.send).not.toHaveBeenCalled();
  });

  it("returns the existing pending job id when exclusive enqueue deduplicates", async () => {
    const boss = fakeBoss();
    boss.send.mockResolvedValue(null);
    boss.findJobs.mockResolvedValue([{ id: "existing-job", singletonKey: "cardano-org", state: "active", data: { sourceId: "cardano-org" }, createdOn: new Date("2026-01-01") } as unknown as JobWithMetadata<KnowledgeJob>]);
    await expect(enqueueKnowledgeSource(boss as unknown as Pick<KnowledgeBoss, "send" | "findJobs">, "cardano-org")).resolves.toBe("existing-job");
    expect(boss.findJobs).toHaveBeenCalledWith(KNOWLEDGE_QUEUE, { key: "cardano-org" });
  });

  it("recovers the newest exact job even when the collision target just completed", async () => {
    const boss = fakeBoss();
    boss.send.mockResolvedValue(null);
    boss.findJobs.mockResolvedValue([
      { id: "older", singletonKey: "cardano-org", state: "failed", data: { sourceId: "cardano-org" }, createdOn: new Date("2026-01-01") } as unknown as JobWithMetadata<KnowledgeJob>,
      { id: "newer", singletonKey: "cardano-org", state: "completed", data: { sourceId: "cardano-org" }, createdOn: new Date("2026-01-02") } as unknown as JobWithMetadata<KnowledgeJob>,
      { id: "wrong-payload", singletonKey: "cardano-org", state: "completed", data: { sourceId: "other" }, createdOn: new Date("2026-01-03") } as unknown as JobWithMetadata<KnowledgeJob>,
    ]);
    await expect(enqueueKnowledgeSource(boss as unknown as Pick<KnowledgeBoss, "send" | "findJobs">, "cardano-org")).resolves.toBe("newer");
  });
});
