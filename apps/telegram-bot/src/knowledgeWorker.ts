import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PgBoss, type JobWithMetadata, type QueueOptions } from "pg-boss";
import {
  validateSourceRegistry,
  validateSourceRegistryEnvelope,
  type SourceRegistryEntry,
} from "@vennek/cardano-agent";

export const KNOWLEDGE_BOSS_SCHEMA = "knowledge_boss";
export const KNOWLEDGE_QUEUE = "sync-cardano-source";
export const KNOWLEDGE_DEAD_QUEUE = "sync-cardano-source-dead";
export const KNOWLEDGE_SCHEDULE_PREFIX = "source/";
export const KNOWLEDGE_HOURLY_CRON = "0 * * * *";
export const KNOWLEDGE_DAILY_CRON = "15 2 * * *";

const DEFAULT_REGISTRY_PATH = resolve(fileURLToPath(new URL("../../../config/cardano-sources.json", import.meta.url)));

export type KnowledgeJob = { sourceId: string };
export type KnowledgeSourceMap = ReadonlyMap<string, SourceRegistryEntry>;
export type KnowledgeSync = (entry: SourceRegistryEntry, signal: AbortSignal) => Promise<unknown>;
export type KnowledgeBoss = Pick<PgBoss,
  "createQueue" | "schedule" | "unschedule" | "getSchedules" | "send" | "findJobs" | "work"
>;

export const KNOWLEDGE_QUEUE_OPTIONS: Readonly<QueueOptions & { policy: "exclusive" }> = Object.freeze({
  policy: "exclusive",
  retryLimit: 2,
  retryDelay: 60,
  retryBackoff: true,
  retryDelayMax: 900,
  expireInSeconds: 300,
  deadLetter: KNOWLEDGE_DEAD_QUEUE,
});

export function loadKnowledgeSourceRegistry(path = DEFAULT_REGISTRY_PATH): SourceRegistryEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Unable to parse source registry JSON: ${error instanceof Error ? error.message : "invalid JSON"}`);
  }
  const envelope = validateSourceRegistryEnvelope(parsed);
  return validateSourceRegistry([...envelope.official, ...envelope.community]);
}

export function loadKnowledgeSourceMap(path = DEFAULT_REGISTRY_PATH): KnowledgeSourceMap {
  const entries = loadKnowledgeSourceRegistry(path);
  return new Map(entries.map((entry) => [entry.id, entry]));
}

export function validateKnowledgeJob(value: unknown): KnowledgeJob {
  if (!isPlainRecord(value) || Object.keys(value).length !== 1 || typeof value.sourceId !== "string") {
    throw new Error("Knowledge job must contain exactly sourceId.");
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.sourceId) || value.sourceId.length > 80) {
    throw new Error("Knowledge job sourceId is invalid.");
  }
  return { sourceId: value.sourceId };
}

export async function configureKnowledgeQueues(boss: KnowledgeBoss): Promise<void> {
  await boss.createQueue(KNOWLEDGE_DEAD_QUEUE, { policy: "standard", expireInSeconds: 300 });
  await boss.createQueue(KNOWLEDGE_QUEUE, { ...KNOWLEDGE_QUEUE_OPTIONS });
}

export async function reconcileKnowledgeSchedules(
  boss: Pick<KnowledgeBoss, "getSchedules" | "unschedule">,
  entries: KnowledgeSourceMap,
): Promise<void> {
  const schedules = await boss.getSchedules(KNOWLEDGE_QUEUE);
  for (const schedule of schedules) {
    if (schedule.key.startsWith(KNOWLEDGE_SCHEDULE_PREFIX) && !entries.has(schedule.key.slice(KNOWLEDGE_SCHEDULE_PREFIX.length))) {
      await boss.unschedule(KNOWLEDGE_QUEUE, schedule.key);
    }
  }
}

export async function scheduleKnowledgeSources(
  boss: Pick<KnowledgeBoss, "schedule">,
  entries: KnowledgeSourceMap,
): Promise<void> {
  for (const entry of entries.values()) {
    await boss.schedule(
      KNOWLEDGE_QUEUE,
      entry.refresh === "hourly" ? KNOWLEDGE_HOURLY_CRON : KNOWLEDGE_DAILY_CRON,
      { sourceId: entry.id },
      {
        key: `${KNOWLEDGE_SCHEDULE_PREFIX}${entry.id}`,
        tz: "UTC",
        ...KNOWLEDGE_QUEUE_OPTIONS,
        singletonKey: entry.id,
      },
    );
  }
}

export async function enqueueKnowledgeSource(
  boss: Pick<KnowledgeBoss, "send" | "findJobs">,
  sourceId: string,
  registryPath?: string,
): Promise<string> {
  const entries = loadKnowledgeSourceMap(registryPath);
  const entry = entries.get(sourceId);
  if (!entry) throw new Error("Unknown Cardano source id.");
  const jobId = await boss.send(KNOWLEDGE_QUEUE, { sourceId: entry.id }, {
    ...KNOWLEDGE_QUEUE_OPTIONS,
    singletonKey: entry.id,
  });
  if (jobId) return jobId;
  const jobs = await boss.findJobs<KnowledgeJob>(KNOWLEDGE_QUEUE, { key: entry.id });
  const matches = jobs
    .filter((job: JobWithMetadata<KnowledgeJob>) =>
      job.singletonKey === entry.id &&
      isMatchingKnowledgeJob(job.data, entry.id) &&
      job.createdOn instanceof Date &&
      Number.isFinite(job.createdOn.getTime()),
    )
    .sort((left, right) => {
      const byDate = right.createdOn.getTime() - left.createdOn.getTime();
      return byDate || right.id.localeCompare(left.id);
    });
  if (matches.length > 0) return matches[0]!.id;
  throw new Error("Knowledge source job was deduplicated but could not be recovered.");
}

export async function registerKnowledgeWorker(input: {
  boss: KnowledgeBoss;
  sync: KnowledgeSync;
  registryPath?: string;
  signal?: AbortSignal;
}): Promise<string> {
  await configureKnowledgeQueues(input.boss);
  const initialEntries = loadKnowledgeSourceMap(input.registryPath);
  await reconcileKnowledgeSchedules(input.boss, initialEntries);
  await scheduleKnowledgeSources(input.boss, initialEntries);
  return input.boss.work<KnowledgeJob>(KNOWLEDGE_QUEUE, async (jobs) => {
    for (const job of jobs) {
      const data = validateKnowledgeJob(job.data);
      // Reload on every job so an operator can remove or update a source without restarting workers.
      const entries = loadKnowledgeSourceMap(input.registryPath);
      const entry = entries.get(data.sourceId);
      if (!entry) throw new Error("Knowledge source is no longer registered.");
      if (!(job.signal instanceof AbortSignal)) throw new Error("Knowledge job cancellation signal is invalid.");
      const signal = input.signal ? AbortSignal.any([job.signal, input.signal]) : job.signal;
      signal.throwIfAborted();
      await input.sync(entry, signal);
    }
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isMatchingKnowledgeJob(value: unknown, sourceId: string): boolean {
  try {
    return validateKnowledgeJob(value).sourceId === sourceId;
  } catch {
    return false;
  }
}
