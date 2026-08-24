import type { Pool } from "pg";

export async function ensureConversationPartitions(db: Pool, now = new Date()): Promise<void> {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("Partition date is invalid");
  }
  await db.query(
    "SELECT public.ensure_conversation_partitions($1::timestamptz)",
    [now],
  );
}
