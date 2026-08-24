import type { Pool, PoolClient } from "pg";
import { validateSourceRegistry, type SourceRegistryEntry } from "./sourceRegistry.js";

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const VECTOR_SIZE = 1_536;
const PG_BIGINT_MAX = "9223372036854775807";
const PG_INTEGER_MAX = 2_147_483_647;
const MAX_ENDPOINT_STATE_BYTES = 4_096;

export const GITHUB_ENDPOINTS = ["organization", "repository", "readme", "releases", "tags"] as const;
export type GithubEndpoint = typeof GITHUB_ENDPOINTS[number];

export type GithubEndpointState = {
  etag?: string;
  checkedAt?: string;
  retryAt?: string;
  rateLimitResetAt?: string;
  rateLimitRemaining?: number;
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

function assertContentHash(value: string, field: string): void {
  if (!HASH_PATTERN.test(value)) {
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

export class KnowledgeRepository {
  constructor(private readonly db: Pool) {}

  async ensureSource(entry: SourceRegistryEntry): Promise<void> {
    const [validated] = validateSourceRegistry([entry]);
    await this.db.query(
      `INSERT INTO knowledge_sources (id, owner, trust_tier, registry)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         owner = EXCLUDED.owner,
         trust_tier = EXCLUDED.trust_tier,
         registry = EXCLUDED.registry`,
      [validated.id, validated.owner, validated.trustTier, JSON.stringify(validated)],
    );
  }

  async getGithubEndpointState(sourceId: string, endpoint: GithubEndpoint): Promise<GithubEndpointState | null> {
    assertSourceId(sourceId);
    assertGithubEndpoint(endpoint);
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
  ): Promise<boolean> {
    assertSourceId(sourceId);
    assertGithubEndpoint(endpoint);
    if (expectedState !== null) validateGithubEndpointState(expectedState, "Expected endpoint state");
    if (nextState !== null) validateGithubEndpointState(nextState, "Next endpoint state");
    const result = await this.db.query(
      `UPDATE knowledge_sources
       SET fetch_state = jsonb_set(COALESCE(fetch_state, '{}'::jsonb), ARRAY[$2]::text[], $3::jsonb, true)
       WHERE id = $1
         AND COALESCE(fetch_state -> $2, 'null'::jsonb) = $4::jsonb`,
      [sourceId, endpoint, serializeEndpointState(nextState), serializeEndpointState(expectedState)],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async storeVersion(input: StoreVersionInput): Promise<KnowledgeVersion> {
    validateVersion(input);
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

  async replaceChunks(versionId: string | number, chunks: KnowledgeChunkInput[]): Promise<void> {
    const normalizedVersionId = validateChunks(versionId, chunks);
    const client: PoolClient = await this.db.connect();
    let inTransaction = false;
    let releaseError: Error | undefined;
    try {
      await client.query("BEGIN");
      inTransaction = true;
      await client.query("DELETE FROM knowledge_chunks WHERE version_id = $1", [normalizedVersionId]);
      for (const chunk of chunks) {
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
      await client.query("COMMIT");
      inTransaction = false;
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
      throw error;
    } finally {
      client.release(releaseError);
    }
  }
}
