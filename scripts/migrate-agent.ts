import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PgBoss } from "pg-boss";
import type { PoolClient } from "pg";
import { createDatabase } from "@vennek/cardano-agent";
import {
  PRIVATE_COMPARISON_EXPIRE_SECONDS,
  PRIVATE_COMPARISON_RETENTION_SECONDS,
  PRIVATE_COMPARISON_RETRY_BACKOFF,
  PRIVATE_COMPARISON_RETRY_DELAY_SECONDS,
  PRIVATE_COMPARISON_RETRY_LIMIT,
} from "../apps/telegram-bot/src/privateComparisonQueue.js";

const MIGRATION_LOCK_NAME = "vennek:agent-migrations";
const migrationDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../packages/cardano-agent/migrations",
);

export async function provisionAgentQueues(
  boss: Pick<PgBoss, "createQueue">,
  knowledgeBoss?: Pick<PgBoss, "createQueue">,
): Promise<void> {
  await boss.createQueue("telegram-answer");
  await boss.createQueue("telegram-private-compare", {
    policy: "standard",
    retryLimit: PRIVATE_COMPARISON_RETRY_LIMIT,
    retryDelay: PRIVATE_COMPARISON_RETRY_DELAY_SECONDS,
    retryBackoff: PRIVATE_COMPARISON_RETRY_BACKOFF,
    expireInSeconds: PRIVATE_COMPARISON_EXPIRE_SECONDS,
    retentionSeconds: PRIVATE_COMPARISON_RETENTION_SECONDS,
    deleteAfterSeconds: 1,
  });
  await boss.createQueue("conversation-partition-maintenance");

  if (!knowledgeBoss) return;
  await knowledgeBoss.createQueue("sync-cardano-source-dead", {
    policy: "standard",
    expireInSeconds: 300,
  });
  await knowledgeBoss.createQueue("sync-cardano-source", {
    policy: "exclusive",
    retryLimit: 2,
    retryDelay: 60,
    retryBackoff: true,
    retryDelayMax: 900,
    expireInSeconds: 300,
    deadLetter: "sync-cardano-source-dead",
  });
}

export async function runMigrations(): Promise<void> {
  const databaseUrl = process.env.DATABASE_OWNER_URL?.trim() || process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("DATABASE_OWNER_URL or DATABASE_URL is required");

  const migrationFiles = (await readdir(migrationDirectory))
    .filter((filename) => filename.endsWith(".sql"))
    .sort((left, right) => left.localeCompare(right));

  const db = createDatabase(databaseUrl);
  let boss: PgBoss | undefined;
  let knowledgeBoss: PgBoss | undefined;
  let client: PoolClient | undefined;
  let lockAcquired = false;

  try {
    client = await db.connect();
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [MIGRATION_LOCK_NAME]);
    lockAcquired = true;
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    for (const filename of migrationFiles) {
      const alreadyApplied = await client.query(
        "SELECT 1 FROM schema_migrations WHERE filename = $1",
        [filename],
      );
      if (alreadyApplied.rowCount) continue;

      const sql = await readFile(resolve(migrationDirectory, filename), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (filename) VALUES ($1)",
          [filename],
        );
        await client.query("COMMIT");
        console.log(`Applied ${filename}`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }

    boss = new PgBoss({ connectionString: databaseUrl });
    await boss.start();
    knowledgeBoss = new PgBoss({ connectionString: databaseUrl, schema: "knowledge_boss" });
    await knowledgeBoss.start();
    await provisionAgentQueues(boss, knowledgeBoss);
  } finally {
    await knowledgeBoss?.stop().catch(() => undefined);
    await boss?.stop().catch(() => undefined);
    if (client) {
      if (lockAcquired) {
        try {
          await client.query("SELECT pg_advisory_unlock(hashtext($1))", [MIGRATION_LOCK_NAME]);
        } finally {
          client.release();
        }
      } else {
        client.release();
      }
    }
    await db.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMigrations().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
