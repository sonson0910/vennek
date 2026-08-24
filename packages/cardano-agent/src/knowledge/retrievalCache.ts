import type { Pool, PoolClient } from "pg";
import { sha256Hex } from "@vennek/shared";
import type { RepositoryOperationOptions } from "./knowledgeRepository.js";

const CACHE_TTL_MS = 15 * 60 * 1_000;

export type RetrievalCacheKey = {
  queryHash: string;
  language: string;
  filterHash: string;
  embeddingModel: string;
};

export type RetrievalCacheEntry = {
  chunkIds: string[];
  scores: number[];
};

export type RetrievalFilter = {
  topics?: string[];
  networks?: string[];
};

export type RetrievalCacheSnapshot = {
  fingerprint: string;
  cached: RetrievalCacheEntry | undefined;
  staleFingerprint?: string;
};

export function createRetrievalCacheKey(query: string, language: string, embeddingModel: string, filter: RetrievalFilter): RetrievalCacheKey {
  const topics = [...(filter.topics ?? [])].sort();
  const networks = [...(filter.networks ?? [])].sort();
  return {
    queryHash: sha256Hex(query),
    language,
    filterHash: sha256Hex(JSON.stringify({ topics, networks })),
    embeddingModel,
  };
}

async function sourceVersionFingerprintOnClient(
  client: PoolClient,
  options: RepositoryOperationOptions,
): Promise<string> {
  ensureActive(options);
  // ponytail: keep invalidation O(1); shard revisions by source only if indexing churn materially hurts cache reuse.
  const result = await client.query<{ revision: string }>("SELECT revision::text AS revision FROM knowledge_revision WHERE id = true");
  ensureActive(options);
  const revision = result.rows[0]?.revision;
  if (!revision) throw new Error("Knowledge revision is unavailable.");
  return sha256Hex(revision);
}

export async function withRetrievalCacheSnapshot<T>(
  db: Pool,
  key: RetrievalCacheKey,
  now: Date,
  options: RepositoryOperationOptions,
  operation: (client: PoolClient, snapshot: RetrievalCacheSnapshot) => Promise<T>,
): Promise<T> {
  return runRetrievalTransaction(db, options, async (client) => {
    const fingerprint = await sourceVersionFingerprintOnClient(client, options);
    const cached = await readRetrievalCacheOnClient(client, key, now, options, fingerprint);
    const snapshot = {
      fingerprint,
      cached: cached.entry,
      ...(cached.staleFingerprint ? { staleFingerprint: cached.staleFingerprint } : {}),
    };
    return operation(client, snapshot);
  }, "REPEATABLE READ");
}

async function readRetrievalCacheOnClient(
  client: PoolClient,
  key: RetrievalCacheKey,
  now: Date,
  options: RepositoryOperationOptions,
  expectedFingerprint?: string,
): Promise<{ entry: RetrievalCacheEntry | undefined; staleFingerprint?: string }> {
  ensureActive(options);
  const result = await client.query<{ source_version_fingerprint: string; chunk_ids: unknown; scores: unknown; expires_at: Date }>(
    `SELECT source_version_fingerprint, chunk_ids, scores, expires_at
     FROM retrieval_cache
     WHERE query_hash = $1 AND language = $2 AND filter_hash = $3 AND embedding_model = $4`,
    [key.queryHash, key.language, key.filterHash, key.embeddingModel],
  );
  const row = result.rows[0];
  if (!row) return { entry: undefined };
  if (expectedFingerprint !== undefined && row.source_version_fingerprint !== expectedFingerprint) {
    return { entry: undefined, staleFingerprint: row.source_version_fingerprint };
  }
  const expired = new Date(row.expires_at).getTime() <= now.getTime();
  if (expired) return { entry: undefined };
  const chunkIds = parseChunkIds(row.chunk_ids);
  const scores = parseScores(row.scores);
  if (chunkIds.length === 0 || chunkIds.length !== scores.length) {
    return { entry: undefined };
  }
  ensureActive(options);
  return { entry: { chunkIds, scores } };
}

export async function writeRetrievalCache(
  db: Pool,
  key: RetrievalCacheKey,
  fingerprint: string,
  entry: RetrievalCacheEntry,
  now: Date,
  options: RepositoryOperationOptions,
): Promise<boolean> {
  return runRetrievalTransaction(db, options, async (client) => {
    const currentFingerprint = await sourceVersionFingerprintOnClient(client, options);
    if (currentFingerprint !== fingerprint) return false;
    ensureActive(options);
    await client.query(
      `INSERT INTO retrieval_cache
       (query_hash, language, filter_hash, embedding_model, source_version_fingerprint, chunk_ids, scores, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)
       ON CONFLICT (query_hash, language, filter_hash, embedding_model) DO UPDATE SET
         source_version_fingerprint = EXCLUDED.source_version_fingerprint,
         chunk_ids = EXCLUDED.chunk_ids,
         scores = EXCLUDED.scores,
         expires_at = EXCLUDED.expires_at`,
      [
        key.queryHash,
        key.language,
        key.filterHash,
        key.embeddingModel,
        fingerprint,
        JSON.stringify(entry.chunkIds),
        JSON.stringify(entry.scores),
        new Date(now.getTime() + CACHE_TTL_MS),
      ],
    );
    ensureActive(options);
    return true;
  });
}

export async function deleteStaleRetrievalCache(
  db: Pool,
  key: RetrievalCacheKey,
  observedFingerprint: string,
  options: RepositoryOperationOptions,
): Promise<void> {
  return runRetrievalTransaction(db, options, async (client) => {
    ensureActive(options);
    await client.query(
      `DELETE FROM retrieval_cache
       WHERE query_hash = $1 AND language = $2 AND filter_hash = $3 AND embedding_model = $4
         AND source_version_fingerprint = $5`,
      [key.queryHash, key.language, key.filterHash, key.embeddingModel, observedFingerprint],
    );
    ensureActive(options);
  });
}

function parseChunkIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  if (value.length > 10) return [];
  return value.filter((item): item is string => typeof item === "string" && /^[1-9][0-9]*$/.test(item));
}

function parseScores(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  if (value.length > 10) return [];
  return value.filter((item): item is number => typeof item === "number" && Number.isFinite(item));
}

export async function runRetrievalTransaction<T>(db: Pool, options: RepositoryOperationOptions, operation: (client: PoolClient) => Promise<T>, isolationLevel: "READ COMMITTED" | "REPEATABLE READ" = "READ COMMITTED"): Promise<T> {
  const client = await acquireRetrievalClient(db, options);
  let inTransaction = false;
  let releaseError: Error | undefined;
  try {
    ensureActive(options);
    await client.query("BEGIN");
    inTransaction = true;
    if (isolationLevel !== "READ COMMITTED") await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    const remaining = operationRemainingMs(options);
    if (remaining !== undefined) {
      const timeoutMs = Math.max(1, Math.min(5_000, Math.floor(remaining)));
      await client.query(
        "SELECT set_config($1, $2, true), set_config($3, $4, true)",
        ["lock_timeout", `${timeoutMs}ms`, "statement_timeout", `${timeoutMs}ms`],
      );
    }
    const result = await operation(client);
    ensureActive(options);
    await client.query("COMMIT");
    inTransaction = false;
    ensureActive(options);
    return result;
  } catch (error) {
    if (inTransaction) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        releaseError = rollbackError instanceof Error ? rollbackError : new Error("Retrieval rollback failed.");
      }
    } else {
      releaseError = error instanceof Error ? error : new Error("Retrieval transaction failed.");
    }
    if (options.signal?.aborted) throw new Error("Retrieval aborted.");
    if (operationExpired(options) || databaseTimeout(error)) throw new Error("Retrieval database operation timed out.");
    throw error instanceof Error ? error : new Error("Retrieval database operation failed.");
  } finally {
    client.release(releaseError);
  }
}

async function acquireRetrievalClient(db: Pool, options: RepositoryOperationOptions): Promise<PoolClient> {
  ensureActive(options);
  const connectPromise = db.connect();
  connectPromise.catch(() => undefined);
  const remaining = operationRemainingMs(options);
  if (remaining === undefined) {
    const client = await connectPromise;
    try {
      ensureActive(options);
      return client;
    } catch (error) {
      client.release();
      throw error;
    }
  }
  if (remaining <= 0) {
    connectPromise.then((client) => client.release(), () => undefined);
    ensureActive(options);
    throw new Error("Retrieval deadline exceeded.");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortHandler: (() => void) | undefined;
  let cancelled = false;
  let acquired: PoolClient | undefined;
  const cancellation = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      cancelled = true;
      reject(new Error("Retrieval deadline exceeded."));
    }, Math.max(1, Math.floor(remaining)));
    if (options.signal) {
      abortHandler = () => {
        cancelled = true;
        reject(new Error("Retrieval aborted."));
      };
      options.signal.addEventListener("abort", abortHandler, { once: true });
    }
  });
  try {
    acquired = await Promise.race([connectPromise, cancellation]);
    if (timer) clearTimeout(timer);
    if (abortHandler && options.signal) options.signal.removeEventListener("abort", abortHandler);
    ensureActive(options);
    if (!acquired) throw new Error("Retrieval client was not acquired.");
    return acquired;
  } catch (error) {
    if (timer) clearTimeout(timer);
    if (abortHandler && options.signal) options.signal.removeEventListener("abort", abortHandler);
    if (acquired) acquired.release();
    else if (cancelled) connectPromise.then((client) => client.release(), () => undefined);
    throw error;
  }
}

function operationRemainingMs(options: RepositoryOperationOptions): number | undefined {
  const values: number[] = [];
  if (options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs)) values.push(options.timeoutMs);
  if (options.deadlineAt !== undefined && Number.isFinite(options.deadlineAt)) values.push(options.deadlineAt - Date.now());
  return values.length === 0 ? 5_000 : Math.min(...values);
}

function operationExpired(options: RepositoryOperationOptions): boolean {
  const remaining = operationRemainingMs(options);
  return remaining !== undefined && remaining <= 0;
}

function databaseTimeout(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
  return code === "55P03" || code === "57014";
}

function ensureActive(options: RepositoryOperationOptions): void {
  if (options.signal?.aborted) throw new Error("Retrieval aborted.");
  if (operationExpired(options)) throw new Error("Retrieval deadline exceeded.");
}
