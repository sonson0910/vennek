import type { Pool, PoolClient } from "pg";
import { validateSourceRegistry, type SourceRegistryEntry } from "./sourceRegistry.js";

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const VECTOR_SIZE = 1_536;
const PG_BIGINT_MAX = "9223372036854775807";
const PG_INTEGER_MAX = 2_147_483_647;
const MAX_ENDPOINT_STATE_BYTES = 4_096;
const MAX_TITLE_CHARS = 300;
const MAX_CANONICAL_URL_CHARS = 2_048;

export const GITHUB_ENDPOINTS = ["organization", "repository", "readme", "releases", "tags"] as const;
export type GithubEndpoint = typeof GITHUB_ENDPOINTS[number];

export type GithubEndpointState = {
  etag?: string;
  checkedAt?: string;
  retryAt?: string;
  rateLimitResetAt?: string;
  rateLimitRemaining?: number;
};

export type GithubEndpointStateUpdate = {
  sourceId: string;
  endpoint: GithubEndpoint;
  expectedState: GithubEndpointState | null;
  nextState: GithubEndpointState | null;
};

export type RepositoryOperationOptions = {
  signal?: AbortSignal;
  deadlineAt?: number;
  timeoutMs?: number;
};

export type StoreVersionInput = {
  sourceId: string;
  canonicalUrl: string;
  title: string;
  content: string;
  contentHash: string;
  publishedAt?: Date;
  retrievedAt: Date;
};

export type KnowledgeVersion = {
  id: string;
};

export type KnowledgeChunkInput = {
  ordinal: number;
  heading: string;
  content: string;
  contentHash: string;
  embeddingModel: string;
  embedding: number[];
};

function assertNonEmpty(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must not be empty.`);
  }
}

function assertValidDate(value: Date, field: string): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(`${field} must be a valid date.`);
  }
}

function assertContentHash(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    throw new Error(`${field} must be a lowercase 64-hex hash.`);
  }
}

function assertCanonicalHttpsUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Canonical URL must be a valid HTTPS URL.");
  }
  if (url.protocol !== "https:") {
    throw new Error("Canonical URL must use HTTPS.");
  }
  if (url.username || url.password) {
    throw new Error("Canonical URL must not contain credentials.");
  }
  if (Array.from(value).length > MAX_CANONICAL_URL_CHARS) {
    throw new Error("Canonical URL is too long.");
  }
}

function normalizeVersionId(value: string | number): string {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error("Version ID must be a positive integer.");
    }
    return String(value);
  }
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error("Version ID must be a positive integer.");
  }
  if (value.length > PG_BIGINT_MAX.length || (value.length === PG_BIGINT_MAX.length && value > PG_BIGINT_MAX)) {
    throw new Error("Version ID exceeds the PostgreSQL bigint range.");
  }
  return value;
}

function validateVersion(input: StoreVersionInput): void {
  assertNonEmpty(input.sourceId, "Source ID");
  assertCanonicalHttpsUrl(input.canonicalUrl);
  assertNonEmpty(input.title, "Title");
  if (Array.from(input.title).length > MAX_TITLE_CHARS) throw new Error("Title is too long.");
  assertNonEmpty(input.content, "Content");
  assertContentHash(input.contentHash, "Content hash");
  assertValidDate(input.retrievedAt, "Retrieved at");
  if (input.publishedAt !== undefined) assertValidDate(input.publishedAt, "Published at");
}

function validateChunks(versionId: string | number, chunks: KnowledgeChunkInput[]): string {
  const normalizedVersionId = normalizeVersionId(versionId);
  if (!Array.isArray(chunks) || chunks.length === 0) {
    throw new Error("Chunks must not be empty.");
  }
  const ordinals = new Set<number>();
  for (const chunk of chunks) {
    if (!chunk || typeof chunk !== "object") {
      throw new Error("Chunk must be an object.");
    }
    if (!Number.isSafeInteger(chunk.ordinal) || chunk.ordinal < 0 || chunk.ordinal > PG_INTEGER_MAX) {
      throw new Error("Chunk ordinal must be a nonnegative integer.");
    }
    if (ordinals.has(chunk.ordinal)) {
      throw new Error("Chunk ordinals must be unique.");
    }
    ordinals.add(chunk.ordinal);
    assertNonEmpty(chunk.heading, "Chunk heading");
    assertNonEmpty(chunk.content, "Chunk content");
    assertContentHash(chunk.contentHash, "Chunk content hash");
    assertNonEmpty(chunk.embeddingModel, "Embedding model");
    if (!Array.isArray(chunk.embedding) || chunk.embedding.length !== VECTOR_SIZE) {
      throw new Error("Chunk embedding must contain exactly 1,536 finite numbers.");
    }
    for (let index = 0; index < VECTOR_SIZE; index += 1) {
      const value = chunk.embedding[index];
      if (!(index in chunk.embedding) || typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error("Chunk embedding must contain exactly 1,536 finite numbers.");
      }
      if (!Number.isFinite(Math.fround(value))) {
        throw new Error("Chunk embedding values must fit PostgreSQL float4.");
      }
    }
  }
  return normalizedVersionId;
}

function serializeEmbedding(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

function assertSourceId(value: string): void {
  assertNonEmpty(value, "Source ID");
}

function assertGithubEndpoint(value: string): asserts value is GithubEndpoint {
  if (!(GITHUB_ENDPOINTS as readonly string[]).includes(value)) {
    throw new Error(`Unknown GitHub endpoint: ${value}`);
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertIsoDate(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string") throw new Error(`${field} must be an ISO timestamp.`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new Error(`${field} must be an ISO timestamp.`);
  }
}

function validateGithubEndpointState(value: unknown, field = "Endpoint state"): GithubEndpointState {
  if (!isPlainRecord(value)) {
    throw new Error(`${field} must be a plain JSON object.`);
  }
  const allowed = new Set(["etag", "checkedAt", "retryAt", "rateLimitResetAt", "rateLimitRemaining"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${field} contains unknown field: ${key}`);
  }
  if ("etag" in value) {
    if (typeof value.etag !== "string" || value.etag.length === 0 || value.etag.length > 256 || !/^[\x20-\x7e]+$/.test(value.etag)) {
      throw new Error(`${field} etag is invalid.`);
    }
  }
  if ("checkedAt" in value) assertIsoDate(value.checkedAt, `${field} checkedAt`);
  if ("retryAt" in value) assertIsoDate(value.retryAt, `${field} retryAt`);
  if ("rateLimitResetAt" in value) assertIsoDate(value.rateLimitResetAt, `${field} rateLimitResetAt`);
  if ("rateLimitRemaining" in value) {
    const remaining = value.rateLimitRemaining;
    if (typeof remaining !== "number" || !Number.isSafeInteger(remaining) || remaining < 0) {
      throw new Error(`${field} rateLimitRemaining is invalid.`);
    }
  }
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_ENDPOINT_STATE_BYTES) {
    throw new Error(`${field} is too large.`);
  }
  return value as GithubEndpointState;
}

function serializeEndpointState(value: GithubEndpointState | null): string {
  if (value === null) return "null";
  validateGithubEndpointState(value);
  return JSON.stringify(value);
}

function remainingOperationMs(options: RepositoryOperationOptions | undefined): number | undefined {
  if (!options) return undefined;
  const limits: number[] = [];
  if (options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs)) limits.push(options.timeoutMs);
  if (options.deadlineAt !== undefined && Number.isFinite(options.deadlineAt)) limits.push(options.deadlineAt - Date.now());
  if (limits.length === 0) return options.signal ? 5_000 : undefined;
  return Math.min(...limits);
}

function ensureOperationActive(options: RepositoryOperationOptions | undefined): void {
  if (options?.signal?.aborted) throw new Error("Knowledge repository operation aborted.");
  const remaining = remainingOperationMs(options);
  if (remaining !== undefined && remaining <= 0) throw new Error("Knowledge repository operation timed out.");
}

function operationExpired(options: RepositoryOperationOptions | undefined): boolean {
  if (options?.signal?.aborted) return true;
  const remaining = remainingOperationMs(options);
  return remaining !== undefined && remaining <= 0;
}

function isDatabaseTimeout(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  return code === "55P03" || code === "57014";
}

function operationError(error: unknown, options: RepositoryOperationOptions | undefined): Error {
  if (options?.signal?.aborted) return new Error("Knowledge repository operation aborted.");
  if (operationExpired(options) || isDatabaseTimeout(error)) return new Error("Knowledge repository operation timed out.");
  return toError(error);
}

async function configureTransactionTimeout(client: PoolClient, options: RepositoryOperationOptions | undefined): Promise<void> {
  const remaining = remainingOperationMs(options);
  if (remaining === undefined) return;
  const timeoutMs = Math.max(1, Math.min(5_000, Math.floor(remaining)));
  await client.query(
    "SELECT set_config($1, $2, true), set_config($3, $4, true)",
    ["lock_timeout", `${timeoutMs}ms`, "statement_timeout", `${timeoutMs}ms`],
  );
}

async function runBoundedTransaction<T>(
  db: Pool,
  options: RepositoryOperationOptions,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  let client: PoolClient | undefined;
  let inTransaction = false;
  let releaseError: Error | undefined;
  try {
    client = await acquireBoundedClient(db, options);
    ensureOperationActive(options);
    await client.query("BEGIN");
    inTransaction = true;
    await configureTransactionTimeout(client, options);
    const result = await operation(client);
    ensureOperationActive(options);
    await client.query("COMMIT");
    inTransaction = false;
    ensureOperationActive(options);
    return result;
  } catch (error) {
    if (inTransaction && client) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        releaseError = toError(rollbackError);
      }
    } else {
      releaseError = toError(error);
    }
    throw operationError(error, options);
  } finally {
    client?.release(releaseError);
  }
}

async function acquireBoundedClient(db: Pool, options: RepositoryOperationOptions): Promise<PoolClient> {
  ensureOperationActive(options);
  let connectPromise: Promise<PoolClient>;
  try {
    connectPromise = Promise.resolve(db.connect());
  } catch (error) {
    throw operationError(error, options);
  }
  connectPromise.catch(() => undefined);
  const remaining = remainingOperationMs(options);
  if (remaining === undefined && !options.signal) {
    const client = await connectPromise;
    try {
      ensureOperationActive(options);
      return client;
    } catch (error) {
      client.release();
      throw operationError(error, options);
    }
  }
  if (remaining !== undefined && remaining <= 0) {
    void connectPromise.then((lateClient) => lateClient.release(), () => undefined);
    ensureOperationActive(options);
    throw new Error("Knowledge repository operation timed out.");
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortHandler: (() => void) | undefined;
  let cancelled = false;
  let acquired: PoolClient | undefined;
  const cancellation = new Promise<never>((_, reject) => {
    if (remaining !== undefined) {
      timer = setTimeout(() => {
        cancelled = true;
        reject(new Error("Knowledge repository operation timed out."));
      }, Math.max(1, Math.floor(remaining)));
    }
    if (options.signal) {
      abortHandler = () => {
        cancelled = true;
        reject(new Error("Knowledge repository operation aborted."));
      };
      options.signal.addEventListener("abort", abortHandler, { once: true });
    }
  });
  try {
    acquired = await Promise.race([connectPromise, cancellation]);
    if (timer) clearTimeout(timer);
    if (abortHandler && options.signal) options.signal.removeEventListener("abort", abortHandler);
    ensureOperationActive(options);
    return acquired;
  } catch (error) {
    if (timer) clearTimeout(timer);
    if (abortHandler && options.signal) options.signal.removeEventListener("abort", abortHandler);
    if (acquired) acquired.release();
    else if (cancelled) void connectPromise.then((lateClient) => lateClient.release(), () => undefined);
    throw operationError(error, options);
  }
}

export class KnowledgeRepository {
  constructor(private readonly db: Pool) {}

  async ensureSource(entry: SourceRegistryEntry, options?: RepositoryOperationOptions): Promise<void> {
    const [validated] = validateSourceRegistry([entry]);
    const parameters = [validated.id, validated.owner, validated.trustTier, JSON.stringify(validated)];
    if (typeof this.db.connect !== "function") {
      ensureOperationActive(options);
      await this.db.query(
        `INSERT INTO knowledge_sources (id, owner, trust_tier, registry)
         VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (id) DO UPDATE SET
           owner = EXCLUDED.owner,
           trust_tier = EXCLUDED.trust_tier,
           registry = EXCLUDED.registry`,
        parameters,
      );
      ensureOperationActive(options);
      return;
    }
    await runBoundedTransaction(this.db, options ?? {}, async (client) => {
      ensureOperationActive(options);
      await client.query(
        `WITH changed AS (
           INSERT INTO knowledge_sources (id, owner, trust_tier, registry)
           VALUES ($1, $2, $3, $4::jsonb)
           ON CONFLICT (id) DO UPDATE SET
             owner = EXCLUDED.owner,
             trust_tier = EXCLUDED.trust_tier,
             registry = EXCLUDED.registry
           WHERE knowledge_sources.owner IS DISTINCT FROM EXCLUDED.owner
              OR knowledge_sources.trust_tier IS DISTINCT FROM EXCLUDED.trust_tier
              OR knowledge_sources.registry IS DISTINCT FROM EXCLUDED.registry
           RETURNING 1
         ), bumped AS (
           INSERT INTO knowledge_revision (id, revision)
           SELECT true, 1 FROM changed
           ON CONFLICT (id) DO UPDATE SET revision = knowledge_revision.revision + 1
           RETURNING 1
         )
         SELECT count(*) FROM bumped`,
        parameters,
      );
      ensureOperationActive(options);
    });
  }

  async getGithubEndpointState(
    sourceId: string,
    endpoint: GithubEndpoint,
    options?: RepositoryOperationOptions,
  ): Promise<GithubEndpointState | null> {
    assertSourceId(sourceId);
    assertGithubEndpoint(endpoint);
    if (options) {
      const state = await runBoundedTransaction(this.db, options, async (client) => {
        ensureOperationActive(options);
        const result = await client.query<{ state: unknown }>(
          `SELECT fetch_state -> $2 AS state FROM knowledge_sources WHERE id = $1`,
          [sourceId, endpoint],
        );
        ensureOperationActive(options);
        return result.rows[0]?.state;
      });
      return state === null || state === undefined ? null : validateGithubEndpointState(state);
    }
    const result = await this.db.query<{ state: unknown }>(
      `SELECT fetch_state -> $2 AS state FROM knowledge_sources WHERE id = $1`,
      [sourceId, endpoint],
    );
    const state = result.rows[0]?.state;
    return state === null || state === undefined ? null : validateGithubEndpointState(state);
  }

  async compareAndSetGithubEndpointState(
    sourceId: string,
    endpoint: GithubEndpoint,
    expectedState: GithubEndpointState | null,
    nextState: GithubEndpointState | null,
    options?: RepositoryOperationOptions,
  ): Promise<boolean> {
    assertSourceId(sourceId);
    assertGithubEndpoint(endpoint);
    if (expectedState !== null) validateGithubEndpointState(expectedState, "Expected endpoint state");
    if (nextState !== null) validateGithubEndpointState(nextState, "Next endpoint state");
    if (options) {
      return this.compareAndSetGithubEndpointStates([{
        sourceId,
        endpoint,
        expectedState,
        nextState,
      }], options);
    }
    const result = await this.db.query(
      `UPDATE knowledge_sources
       SET fetch_state = jsonb_set(COALESCE(fetch_state, '{}'::jsonb), ARRAY[$2]::text[], $3::jsonb, true)
       WHERE id = $1
         AND COALESCE(fetch_state -> $2, 'null'::jsonb) = $4::jsonb`,
      [sourceId, endpoint, serializeEndpointState(nextState), serializeEndpointState(expectedState)],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async compareAndSetGithubEndpointStates(
    updates: GithubEndpointStateUpdate[],
    options?: RepositoryOperationOptions,
  ): Promise<boolean> {
    if (!Array.isArray(updates)) throw new Error("GitHub endpoint updates must be an array.");
    if (updates.length > GITHUB_ENDPOINTS.length) {
      throw new Error(`GitHub endpoint updates must contain at most ${GITHUB_ENDPOINTS.length} entries.`);
    }
    const keys = new Set<string>();
    for (const update of updates) {
      if (!update || typeof update !== "object") throw new Error("GitHub endpoint update must be an object.");
      if (typeof update.sourceId !== "string") throw new Error("Source ID must be a string.");
      assertSourceId(update.sourceId);
      assertGithubEndpoint(update.endpoint);
      const key = `${update.sourceId}\u0000${update.endpoint}`;
      if (keys.has(key)) throw new Error("GitHub endpoint updates must be unique.");
      keys.add(key);
      if (update.expectedState !== null) validateGithubEndpointState(update.expectedState, "Expected endpoint state");
      if (update.nextState !== null) validateGithubEndpointState(update.nextState, "Next endpoint state");
    }
    if (updates.length === 0) return true;

    const client: PoolClient = await this.db.connect();
    let inTransaction = false;
    let releaseError: Error | undefined;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        client.release(releaseError);
      }
    };
    const rollback = async () => {
      if (!inTransaction) return;
      try {
        await client.query("ROLLBACK");
      } catch (error) {
        releaseError = toError(error);
      } finally {
        inTransaction = false;
      }
    };
    try {
      ensureOperationActive(options);
      await client.query("BEGIN");
      inTransaction = true;
      await configureTransactionTimeout(client, options);
      for (const update of updates) {
        ensureOperationActive(options);
        const result = await client.query(
          `UPDATE knowledge_sources
           SET fetch_state = jsonb_set(COALESCE(fetch_state, '{}'::jsonb), ARRAY[$2]::text[], $3::jsonb, true)
           WHERE id = $1
             AND COALESCE(fetch_state -> $2, 'null'::jsonb) = $4::jsonb`,
          [update.sourceId, update.endpoint, serializeEndpointState(update.nextState), serializeEndpointState(update.expectedState)],
        );
        if ((result.rowCount ?? 0) !== 1) {
          await rollback();
          release();
          ensureOperationActive(options);
          return false;
        }
      }
      ensureOperationActive(options);
      await client.query("COMMIT");
      inTransaction = false;
      ensureOperationActive(options);
      return true;
    } catch (error) {
      if (inTransaction) await rollback();
      else releaseError = toError(error);
      throw operationError(error, options);
    } finally {
      release();
    }
  }

  async storeVersion(input: StoreVersionInput, options?: RepositoryOperationOptions): Promise<KnowledgeVersion> {
    validateVersion(input);
    if (options) {
      return runBoundedTransaction(this.db, options, async (client) => {
        ensureOperationActive(options);
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO source_versions
           (source_id, canonical_url, title, content, content_hash, published_at, retrieved_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (source_id, canonical_url, content_hash) DO NOTHING
           RETURNING id::text AS id`,
          [
            input.sourceId,
            input.canonicalUrl,
            input.title,
            input.content,
            input.contentHash,
            input.publishedAt ?? null,
            input.retrievedAt,
          ],
        );
        ensureOperationActive(options);
        const id = inserted.rows[0]?.id ?? (await client.query<{ id: string }>(
          `SELECT id::text AS id FROM source_versions
           WHERE source_id = $1 AND canonical_url = $2 AND content_hash = $3`,
          [input.sourceId, input.canonicalUrl, input.contentHash],
        )).rows[0]?.id;
        if (!id) throw new Error("Could not store knowledge version.");
        ensureOperationActive(options);
        return { id };
      });
    }
    const inserted = await this.db.query<{ id: string }>(
      `INSERT INTO source_versions
       (source_id, canonical_url, title, content, content_hash, published_at, retrieved_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (source_id, canonical_url, content_hash) DO NOTHING
       RETURNING id::text AS id`,
      [
        input.sourceId,
        input.canonicalUrl,
        input.title,
        input.content,
        input.contentHash,
        input.publishedAt ?? null,
        input.retrievedAt,
      ],
    );
    const id = inserted.rows[0]?.id ?? (await this.db.query<{ id: string }>(
      `SELECT id::text AS id FROM source_versions
       WHERE source_id = $1 AND canonical_url = $2 AND content_hash = $3`,
      [input.sourceId, input.canonicalUrl, input.contentHash],
    )).rows[0]?.id;
    if (!id) throw new Error("Could not store knowledge version.");
    return { id };
  }

  async hasCompleteChunks(
    versionId: string | number,
    embeddingModel: string,
    expectedContentHashes: string[],
    options?: RepositoryOperationOptions,
  ): Promise<boolean> {
    const normalizedVersionId = normalizeVersionId(versionId);
    assertNonEmpty(embeddingModel, "Embedding model");
    if (!Array.isArray(expectedContentHashes) || expectedContentHashes.length === 0) {
      throw new Error("Expected content hashes must not be empty.");
    }
    for (const hash of expectedContentHashes) assertContentHash(hash, "Expected content hash");

    if (options) {
      return runBoundedTransaction(this.db, options, async (client) => {
        ensureOperationActive(options);
        const result = await client.query<{ ordinal: number; content_hash: string }>(
          `SELECT ordinal, content_hash
           FROM knowledge_chunks
           WHERE version_id = $1 AND embedding_model = $2
           ORDER BY ordinal`,
          [normalizedVersionId, embeddingModel],
        );
        ensureOperationActive(options);
        if (result.rows.length !== expectedContentHashes.length) return false;
        return result.rows.every((row, index) => row.ordinal === index && row.content_hash === expectedContentHashes[index]);
      });
    }

    const result = await this.db.query<{ ordinal: number; content_hash: string }>(
      `SELECT ordinal, content_hash
       FROM knowledge_chunks
       WHERE version_id = $1 AND embedding_model = $2
       ORDER BY ordinal`,
      [normalizedVersionId, embeddingModel],
    );
    if (result.rows.length !== expectedContentHashes.length) return false;
    return result.rows.every((row, index) => row.ordinal === index && row.content_hash === expectedContentHashes[index]);
  }

  async replaceChunks(
    versionId: string | number,
    chunks: KnowledgeChunkInput[],
    options?: RepositoryOperationOptions,
  ): Promise<void> {
    const normalizedVersionId = validateChunks(versionId, chunks);
    const client: PoolClient = await this.db.connect();
    let inTransaction = false;
    let releaseError: Error | undefined;
    try {
      ensureOperationActive(options);
      await client.query("BEGIN");
      inTransaction = true;
      await configureTransactionTimeout(client, options);
      ensureOperationActive(options);
      const version = await client.query<{ id: string }>(
        "SELECT id FROM source_versions WHERE id = $1 FOR UPDATE",
        [normalizedVersionId],
      );
      if ((version.rowCount ?? version.rows.length) !== 1) {
        throw new Error("Knowledge version was not found.");
      }
      ensureOperationActive(options);
      await client.query("DELETE FROM knowledge_chunks WHERE version_id = $1", [normalizedVersionId]);
      for (const chunk of chunks) {
        ensureOperationActive(options);
        await client.query(
          `INSERT INTO knowledge_chunks
           (version_id, ordinal, heading, content, content_hash, embedding_model, embedding)
           VALUES ($1, $2, $3, $4, $5, $6, $7::vector)`,
          [
            normalizedVersionId,
            chunk.ordinal,
            chunk.heading,
            chunk.content,
            chunk.contentHash,
            chunk.embeddingModel,
            serializeEmbedding(chunk.embedding),
          ],
        );
      }
      await client.query(
        `INSERT INTO knowledge_revision (id, revision) VALUES (true, 1)
         ON CONFLICT (id) DO UPDATE SET revision = knowledge_revision.revision + 1`,
      );
      ensureOperationActive(options);
      await client.query("COMMIT");
      inTransaction = false;
      ensureOperationActive(options);
    } catch (error) {
      if (inTransaction) {
        try {
          await client.query("ROLLBACK");
        } catch {
          releaseError = error instanceof Error ? error : new Error("Knowledge transaction failed.");
        }
      } else {
        releaseError = error instanceof Error ? error : new Error("Knowledge transaction failed.");
      }
      throw operationError(error, options);
    } finally {
      client.release(releaseError);
    }
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error("Knowledge repository transaction failed.");
}
