import { pathToFileURL } from "node:url";
import type { PoolClient } from "pg";
import { createDatabase } from "@vennek/cardano-agent";

const ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/u;
const PASSWORD = /^[\x21-\x7e]{24,256}$/u;
const RESERVED_ROLE_NAMES = new Set(["postgres", "public", "pg_catalog", "pg_signal_backend"]);

export function validateRoleName(value: string): string {
  if (!ROLE_NAME.test(value) || RESERVED_ROLE_NAMES.has(value)) {
    throw new Error("VENNEK_APP_DB_USER must be a safe application role name.");
  }
  return value;
}

export function quoteIdentifier(value: string): string {
  validateRoleName(value);
  return `"${value}"`;
}

export function quoteSqlLiteral(value: string): string {
  if (!PASSWORD.test(value)) {
    throw new Error("VENNEK_APP_DB_PASSWORD must be 24 to 256 printable ASCII characters.");
  }
  return `E'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

export async function provisionAppRole(
  databaseUrl: string,
  roleName: string,
  password: string,
): Promise<void> {
  const safeRoleName = validateRoleName(roleName);
  const roleIdentifier = quoteIdentifier(safeRoleName);
  const passwordLiteral = quoteSqlLiteral(password);
  const db = createDatabase(databaseUrl);
  let client: PoolClient | undefined;
  let inTransaction = false;
  try {
    client = await db.connect();
    await client.query("BEGIN");
    inTransaction = true;

    const existing = await client.query(
      "SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1",
      [safeRoleName],
    );
    if (existing.rowCount) {
      await client.query(
        `ALTER ROLE ${roleIdentifier} LOGIN PASSWORD ${passwordLiteral}
         NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
      );
    } else {
      await client.query(
        `CREATE ROLE ${roleIdentifier} LOGIN PASSWORD ${passwordLiteral}
         NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
      );
    }

    await client.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
    await client.query("REVOKE CREATE ON SCHEMA pgboss FROM PUBLIC");
    await client.query(`REVOKE CREATE ON SCHEMA public, pgboss FROM ${roleIdentifier}`);
    await client.query(`GRANT USAGE ON SCHEMA public, pgboss TO ${roleIdentifier}`);
    await client.query(`
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
        public.telegram_users,
        public.conversation_messages,
        public.conversation_summaries,
        public.telegram_updates,
        public.telegram_admission_windows,
        public.conversation_message_idempotency,
        public.usage_ledger
      TO ${roleIdentifier}
    `);
    await client.query(`
      GRANT USAGE, SELECT, UPDATE ON SEQUENCE
        public.conversation_messages_id_seq,
        public.usage_ledger_id_seq
      TO ${roleIdentifier}
    `);
    await client.query(
      `GRANT EXECUTE ON FUNCTION public.ensure_conversation_partitions(timestamptz) TO ${roleIdentifier}`,
    );
    await client.query(`
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss
      TO ${roleIdentifier}
    `);
    await client.query(`
      GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA pgboss
      TO ${roleIdentifier}
    `);

    await client.query("COMMIT");
    inTransaction = false;
  } catch (error) {
    if (client && inTransaction) {
      await client.query("ROLLBACK").catch(() => undefined);
    }
    throw error;
  } finally {
    client?.release();
    await db.end();
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_OWNER_URL?.trim() || process.env.DATABASE_URL?.trim();
  const roleName = process.env.VENNEK_APP_DB_USER?.trim();
  const password = process.env.VENNEK_APP_DB_PASSWORD;
  if (!databaseUrl) throw new Error("DATABASE_OWNER_URL is required");
  if (!roleName) throw new Error("VENNEK_APP_DB_USER is required");
  if (password === undefined) throw new Error("VENNEK_APP_DB_PASSWORD is required");
  await provisionAppRole(databaseUrl, roleName, password);
  console.log(`Provisioned application role ${validateRoleName(roleName)}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
