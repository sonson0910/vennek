import type { Pool, PoolClient } from "pg";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CALLER_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const NONCE_DIGEST_BYTES = 32;
const MAX_PROMOTED_COUNT = 3;
const MAX_LATENCY_MS = 3_600_000;

const PROMOTION_OUTCOMES = [
  "promoted",
  "no_match",
  "busy",
  "timeout",
  "upstream_failed",
  "invalid_authenticated_request",
] as const;
export type PromotionOutcome = typeof PROMOTION_OUTCOMES[number];

export type PromotionClaim =
  | { kind: "claimed" }
  | { kind: "running" }
  | { kind: "conflict" }
  | { kind: "completed"; outcome: PromotionOutcome };

export type PromotionClaimInput = {
  requestId: string;
  callerId: string;
  nonceDigest: Buffer;
};

export type PromotionCompletion = {
  outcome: PromotionOutcome;
  promotedCount: number;
  latencyMs: number;
};

function assertUuid(value: unknown): asserts value is string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new Error("Request ID must be a valid UUID.");
  }
}

function assertCallerId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !CALLER_PATTERN.test(value)) {
    throw new Error("Caller ID is invalid.");
  }
}

function assertNonceDigest(value: unknown): asserts value is Buffer {
  if (!Buffer.isBuffer(value) || value.length !== NONCE_DIGEST_BYTES) {
    throw new Error("Nonce digest must be exactly 32 bytes.");
  }
}

function assertOutcome(value: unknown): asserts value is PromotionOutcome {
  if (typeof value !== "string" || !(PROMOTION_OUTCOMES as readonly string[]).includes(value)) {
    throw new Error("Promotion outcome is invalid.");
  }
}

function assertIntegerRange(value: unknown, field: string, max: number): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new Error(`${field} must be an integer between 0 and ${max}.`);
  }
}

function assertValidDate(value: unknown): asserts value is Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("Prune date must be a valid date.");
  }
}

function assertFields(value: object, allowed: readonly string[], message: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(message);
}

function validateClaimInput(value: unknown): asserts value is PromotionClaimInput {
  if (typeof value !== "object" || value === null) throw new Error("Promotion claim input is invalid.");
  assertFields(value, ["requestId", "callerId", "nonceDigest"], "Promotion claim input is invalid.");
  const input = value as Partial<PromotionClaimInput>;
  assertUuid(input.requestId);
  assertCallerId(input.callerId);
  assertNonceDigest(input.nonceDigest);
}

function validateCompletion(value: unknown): asserts value is PromotionCompletion {
  if (typeof value !== "object" || value === null) throw new Error("Promotion completion is invalid.");
  assertFields(value, ["outcome", "promotedCount", "latencyMs"], "Promotion completion is invalid.");
  const completion = value as Partial<PromotionCompletion>;
  assertOutcome(completion.outcome);
  assertIntegerRange(completion.promotedCount, "Promoted count", MAX_PROMOTED_COUNT);
  assertIntegerRange(completion.latencyMs, "Latency", MAX_LATENCY_MS);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error("Promotion audit transaction failed.");
}

async function runTransaction<T>(db: Pool, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  let client: PoolClient | undefined;
  let inTransaction = false;
  let releaseError: Error | undefined;
  try {
    client = await db.connect();
    await client.query("BEGIN");
    inTransaction = true;
    const result = await operation(client);
    await client.query("COMMIT");
    inTransaction = false;
    return result;
  } catch (error) {
    if (client && inTransaction) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        releaseError = toError(rollbackError);
      }
    } else if (client) {
      releaseError = toError(error);
    }
    throw error;
  } finally {
    client?.release(releaseError);
  }
}

export class PromotionAuditRepository {
  constructor(private readonly db: Pool) {}

  async claim(input: PromotionClaimInput): Promise<PromotionClaim> {
    validateClaimInput(input);
    return runTransaction(this.db, async (client) => {
      const inserted = await client.query(
        `INSERT INTO knowledge_promotion_requests (request_id, caller_id, nonce_digest, state)
         VALUES ($1::uuid, $2, $3::bytea, 'started')
         ON CONFLICT DO NOTHING
         RETURNING request_id`,
        [input.requestId, input.callerId, input.nonceDigest],
      );
      if ((inserted.rowCount ?? inserted.rows.length) === 1) return { kind: "claimed" };

      const conflicts = await client.query<{
        requestId: string;
        state: string;
        outcome: string | null;
        requestMatches: boolean;
        nonceMatches: boolean;
      }>(
        `SELECT request_id::text AS "requestId", state, outcome,
                request_id = $1::uuid AS "requestMatches",
                nonce_digest = $2::bytea AS "nonceMatches"
         FROM knowledge_promotion_requests
         WHERE request_id = $1::uuid OR nonce_digest = $2::bytea`,
        [input.requestId, input.nonceDigest],
      );
      if (conflicts.rows.length !== 1) return { kind: "conflict" };
      const [row] = conflicts.rows;
      if (!row.requestMatches || !row.nonceMatches) return { kind: "conflict" };
      if (row.state === "started") return { kind: "running" };
      if ((row.state === "succeeded" || row.state === "failed") && row.outcome !== null) {
        assertOutcome(row.outcome);
        return { kind: "completed", outcome: row.outcome };
      }
      return { kind: "conflict" };
    });
  }

  async complete(requestId: string, completion: PromotionCompletion): Promise<void> {
    assertUuid(requestId);
    validateCompletion(completion);
    const state = completion.outcome === "promoted" || completion.outcome === "no_match"
      ? "succeeded"
      : "failed";
    const result = await this.db.query(
      `UPDATE knowledge_promotion_requests
       SET state = $2,
           outcome = $3,
           promoted_count = $4,
           latency_ms = $5,
           completed_at = clock_timestamp()
       WHERE request_id = $1::uuid AND state = 'started'`,
      [requestId, state, completion.outcome, completion.promotedCount, completion.latencyMs],
    );
    if ((result.rowCount ?? 0) !== 1) {
      throw new Error("Promotion request is not in the started state.");
    }
  }

  async prune(now: Date): Promise<number> {
    assertValidDate(now);
    const result = await this.db.query(
      `DELETE FROM knowledge_promotion_requests
       WHERE request_id IN (
         SELECT request_id
         FROM knowledge_promotion_requests
         WHERE received_at < $1::timestamptz - interval '30 days'
         ORDER BY received_at ASC, request_id ASC
         LIMIT 1000
       )`,
      [now],
    );
    return result.rowCount ?? 0;
  }
}
