import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, afterAll } from "vitest";
import type { Pool } from "pg";
import {
  PromotionAuditRepository,
  createDatabase,
  type PromotionOutcome,
} from "@vennek/cardano-agent";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for promotion audit integration tests.");

const db = createDatabase(databaseUrl);
const ownedRequestIds: string[] = [];
const ownedCallers: string[] = [];

function request(caller = `pa-${process.pid}-${Date.now()}-${ownedCallers.length}`) {
  const requestId = randomUUID();
  const nonceDigest = createHash("sha256").update(requestId).digest();
  ownedRequestIds.push(requestId);
  ownedCallers.push(caller);
  return { requestId, callerId: caller, nonceDigest };
}

function digestFor(index: number): Buffer {
  const digest = Buffer.alloc(32);
  digest.writeUInt32BE(index, 28);
  return digest;
}

async function insertTerminalRows(
  rows: Array<{ requestId: string; callerId: string; nonceDigest: Buffer; receivedAt: Date; completedAt: Date }>,
): Promise<void> {
  const values: unknown[] = [];
  const placeholders = rows.map((row, index) => {
    const offset = index * 5;
    values.push(row.requestId, row.callerId, row.nonceDigest, row.receivedAt, row.completedAt);
    return `($${offset + 1}, $${offset + 2}, $${offset + 3}, 'succeeded', 'no_match', 0, 0, $${offset + 4}, $${offset + 5})`;
  });
  await db.query(
    `INSERT INTO knowledge_promotion_requests
      (request_id, caller_id, nonce_digest, state, outcome, promoted_count, latency_ms, received_at, completed_at)
     VALUES ${placeholders.join(", ")}`,
    values,
  );
}

afterAll(async () => {
  await db.query("DELETE FROM knowledge_promotion_requests WHERE request_id = ANY($1::uuid[])", [ownedRequestIds]).catch(() => undefined);
  await db.end();
});

describe("durable promotion audit", () => {
  it("allows exactly one winner among eight concurrent independent claims", async () => {
    const input = request();
    const pools = Array.from({ length: 8 }, () => createDatabase(databaseUrl));
    try {
      const results = await Promise.all(
        pools.map((pool) => new PromotionAuditRepository(pool).claim(input)),
      );
      expect(results.filter((result) => result.kind === "claimed")).toHaveLength(1);
      expect(results.filter((result) => result.kind === "running")).toHaveLength(7);
    } finally {
      await Promise.all(pools.map((pool) => pool.end()));
    }
  });

  it("replays a completed request as completed with the original safe outcome", async () => {
    const repository = new PromotionAuditRepository(db);
    const input = request();
    await expect(repository.claim(input)).resolves.toEqual({ kind: "claimed" });
    await expect(repository.complete(input.requestId, {
      outcome: "promoted",
      promotedCount: 2,
      latencyMs: 42,
    })).resolves.toBeUndefined();
    await expect(repository.claim(input)).resolves.toEqual({ kind: "completed", outcome: "promoted" });

    const row = await db.query(
      "SELECT state, outcome, promoted_count, latency_ms, completed_at FROM knowledge_promotion_requests WHERE request_id = $1",
      [input.requestId],
    );
    expect(row.rows[0]).toMatchObject({
      state: "succeeded",
      outcome: "promoted",
      promoted_count: 2,
      latency_ms: 42,
    });
    expect(row.rows[0]?.completed_at).toBeInstanceOf(Date);
  });

  it("returns conflict for one-sided identity matches and cross collisions", async () => {
    const repository = new PromotionAuditRepository(db);
    const first = request();
    const second = request();
    await expect(repository.claim(first)).resolves.toEqual({ kind: "claimed" });
    await expect(repository.claim({ ...first, nonceDigest: digestFor(7001) })).resolves.toEqual({ kind: "conflict" });
    await expect(repository.claim({ ...second, nonceDigest: first.nonceDigest })).resolves.toEqual({ kind: "conflict" });

    const third = request();
    const fourth = request();
    await expect(repository.claim(third)).resolves.toEqual({ kind: "claimed" });
    await expect(repository.claim(fourth)).resolves.toEqual({ kind: "claimed" });
    await expect(repository.claim({ ...third, nonceDigest: fourth.nonceDigest })).resolves.toEqual({ kind: "conflict" });
    await expect(repository.claim({ ...fourth, nonceDigest: third.nonceDigest })).resolves.toEqual({ kind: "conflict" });
  });

  it("keeps an abandoned started claim running and allows only one completion", async () => {
    const repository = new PromotionAuditRepository(db);
    const input = request();
    await expect(repository.claim(input)).resolves.toEqual({ kind: "claimed" });
    await expect(repository.claim(input)).resolves.toEqual({ kind: "running" });
    await expect(repository.complete(input.requestId, {
      outcome: "timeout",
      promotedCount: 0,
      latencyMs: 100,
    })).resolves.toBeUndefined();
    await expect(repository.complete(input.requestId, {
      outcome: "promoted",
      promotedCount: 1,
      latencyMs: 101,
    })).rejects.toThrow(/started|completed|promotion/i);
    await expect(repository.claim(input)).resolves.toEqual({ kind: "completed", outcome: "timeout" });
  });

  it("rejects invalid table states and leaves no sensitive content columns", async () => {
    const invalidRows = [
      { state: "bogus", outcome: null, promotedCount: 0, latencyMs: null },
      { state: "started", outcome: "no_match", promotedCount: 0, latencyMs: null },
      { state: "succeeded", outcome: null, promotedCount: 0, latencyMs: 1 },
      { state: "succeeded", outcome: "busy", promotedCount: 0, latencyMs: 1 },
      { state: "failed", outcome: "promoted", promotedCount: 0, latencyMs: 1 },
      { state: "succeeded", outcome: "no_match", promotedCount: 4, latencyMs: 1 },
      { state: "succeeded", outcome: "no_match", promotedCount: 0, latencyMs: 3_600_001 },
      { state: "succeeded", outcome: "no_match", promotedCount: 0, latencyMs: -1 },
    ];
    for (const row of invalidRows) {
      const input = request();
      await expect(db.query(
        `INSERT INTO knowledge_promotion_requests
          (request_id, caller_id, nonce_digest, state, outcome, promoted_count, latency_ms, completed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
        [input.requestId, input.callerId, input.nonceDigest, row.state, row.outcome, row.promotedCount, row.latencyMs],
      )).rejects.toThrow();
    }

    const invalidDigest = request();
    await expect(db.query(
      `INSERT INTO knowledge_promotion_requests (request_id, caller_id, nonce_digest, state)
       VALUES ($1, $2, $3, 'started')`,
      [invalidDigest.requestId, invalidDigest.callerId, Buffer.alloc(31)],
    )).rejects.toThrow(/digest|octet/i);
    const invalidCaller = request();
    await expect(db.query(
      `INSERT INTO knowledge_promotion_requests (request_id, caller_id, nonce_digest, state)
       VALUES ($1, $2, $3, 'started')`,
      [invalidCaller.requestId, "Bad Caller", invalidCaller.nonceDigest],
    )).rejects.toThrow(/caller|check/i);

    const columns = await db.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'knowledge_promotion_requests'
       ORDER BY ordinal_position`,
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      "request_id", "caller_id", "nonce_digest", "state", "outcome", "promoted_count",
      "latency_ms", "received_at", "completed_at",
    ]);
    expect(columns.rows.map((row) => row.column_name)).not.toEqual(expect.arrayContaining([
      "question", "body", "hash", "url", "source", "content", "error", "telegram_user_id", "telegram_chat_id",
    ]));
    const sequences = await db.query(
      "SELECT 1 FROM pg_class WHERE relname LIKE 'knowledge_promotion_requests%seq%'",
    );
    expect(sequences.rows).toHaveLength(0);
  });

  it("prunes at most 1,000 oldest rows while retaining recent rows", async () => {
    const now = new Date("2030-01-31T00:00:00.000Z");
    const oldDate = new Date("2000-01-01T00:00:00.000Z");
    const recentDate = new Date("2030-01-15T00:00:00.000Z");
    const oldRows = Array.from({ length: 1_005 }, (_, index) => {
      const requestId = randomUUID();
      ownedRequestIds.push(requestId);
      return { requestId, callerId: `prune-${process.pid}`, nonceDigest: digestFor(index + 10_000), receivedAt: oldDate, completedAt: oldDate };
    });
    const recent = request(`prune-${process.pid}-recent`);
    await insertTerminalRows(oldRows);
    await insertTerminalRows([{ requestId: recent.requestId, callerId: recent.callerId, nonceDigest: recent.nonceDigest, receivedAt: recentDate, completedAt: recentDate }]);

    const deleted = await new PromotionAuditRepository(db).prune(now);
    expect(deleted).toBe(1_000);
    const remaining = await db.query<{ old_count: string; recent_count: string }>(
      `SELECT
         count(*) FILTER (WHERE received_at < $1::timestamptz - interval '30 days')::text AS old_count,
         count(*) FILTER (WHERE request_id = $2)::text AS recent_count
       FROM knowledge_promotion_requests
       WHERE request_id = ANY($3::uuid[]) OR request_id = $2`,
      [now, recent.requestId, oldRows.map((row) => row.requestId)],
    );
    expect(remaining.rows[0]).toEqual({ old_count: "5", recent_count: "1" });
  });

  it("rejects malformed inputs before connecting to the database", async () => {
    let connectCalls = 0;
    const fakePool = {
      connect: async () => {
        connectCalls += 1;
        throw new Error("pool must not be connected");
      },
    } as unknown as Pool;
    const repository = new PromotionAuditRepository(fakePool);
    await expect(repository.claim({ requestId: "bad", callerId: "caller", nonceDigest: Buffer.alloc(32) })).rejects.toThrow(/request ID|UUID/i);
    await expect(repository.claim({ requestId: randomUUID(), callerId: "Bad Caller", nonceDigest: Buffer.alloc(32) })).rejects.toThrow(/caller/i);
    await expect(repository.claim({ requestId: randomUUID(), callerId: "caller", nonceDigest: Buffer.alloc(31) })).rejects.toThrow(/nonce|digest/i);
    await expect(repository.claim({ requestId: randomUUID(), callerId: "caller", nonceDigest: Buffer.alloc(32), body: "secret" } as never)).rejects.toThrow(/claim input/i);
    await expect(repository.complete(randomUUID(), { outcome: "not-safe" as PromotionOutcome, promotedCount: 0, latencyMs: 0 })).rejects.toThrow(/outcome/i);
    await expect(repository.complete(randomUUID(), { outcome: "promoted", promotedCount: 4, latencyMs: 0 })).rejects.toThrow(/count/i);
    await expect(repository.complete(randomUUID(), { outcome: "promoted", promotedCount: 0, latencyMs: 3_600_001 })).rejects.toThrow(/latency/i);
    await expect(repository.prune(new Date("invalid"))).rejects.toThrow(/date/i);
    expect(connectCalls).toBe(0);
  });
});
