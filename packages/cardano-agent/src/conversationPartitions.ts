import type { Pool } from "pg";

export async function ensureConversationPartitions(db: Pool, now?: Date): Promise<void> {
  if (now === undefined) {
    await db.query("SELECT public.ensure_conversation_partitions()");
    return;
  }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("Partition date is invalid");
  }
  await db.query(
    "SELECT public.ensure_conversation_partitions_at($1::timestamptz)",
    [now],
  );
}
