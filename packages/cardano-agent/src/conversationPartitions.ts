import type { Pool } from "pg";

const PARTITION_LOCK_NAME = "vennek:conversation-message-partitions";
const PARTITION_NAME = /^conversation_messages_\d{4}_(?:0[1-9]|1[0-2])$/;
const TIMESTAMPTZ_BOUND = /^\d{4}-\d{2}-\d{2} 00:00:00\+00$/;

function monthStart(now: Date, offset: number): Date {
  if (Number.isNaN(now.getTime()) || !Number.isSafeInteger(offset) || Math.abs(offset) > 120) {
    throw new Error("Partition date is invalid");
  }
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
}

function timestampBound(date: Date): string {
  const value = `${date.toISOString().slice(0, 10)} 00:00:00+00`;
  if (!TIMESTAMPTZ_BOUND.test(value)) throw new Error("Partition date is invalid");
  return value;
}

function partitionName(start: Date): string {
  const name = `conversation_messages_${start.getUTCFullYear()}_${String(start.getUTCMonth() + 1).padStart(2, "0")}`;
  if (!PARTITION_NAME.test(name)) throw new Error("Partition name is invalid");
  return name;
}

async function createPartition(
  client: { query: Pool["query"] },
  start: Date,
): Promise<void> {
  const end = monthStart(start, 1);
  const name = partitionName(start);
  const startBound = timestampBound(start);
  const endBound = timestampBound(end);
  const result = await client.query<{ statement: string }>(
    `SELECT format(
       'CREATE TABLE IF NOT EXISTS %I PARTITION OF conversation_messages FOR VALUES FROM (TIMESTAMPTZ %L) TO (TIMESTAMPTZ %L)',
       $1::text, $2::text, $3::text
     ) AS statement`,
    [name, startBound, endBound],
  );
  const statement = result.rows[0]?.statement;
  if (!statement) throw new Error("Could not build conversation partition statement");
  await client.query(statement);
}

export async function ensureConversationPartitions(db: Pool, now = new Date()): Promise<void> {
  const client = await db.connect();
  let inTransaction = false;
  try {
    await client.query("BEGIN");
    inTransaction = true;
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [PARTITION_LOCK_NAME]);

    // Keep the current month plus two future months available for inserts.
    await createPartition(client, monthStart(now, 0));
    await createPartition(client, monthStart(now, 1));
    await createPartition(client, monthStart(now, 2));

    await client.query("COMMIT");
    inTransaction = false;
  } catch (error) {
    if (inTransaction) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original database error.
      }
    }
    throw error;
  } finally {
    client.release();
  }
}
