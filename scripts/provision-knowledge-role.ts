import { pathToFileURL } from "node:url";
import type { PoolClient } from "pg";
import { createDatabase } from "@vennek/cardano-agent";
import { quoteIdentifier, quoteSqlLiteral, validateRoleName } from "./provision-app-role.js";

export async function provisionKnowledgeRole(databaseUrl: string, roleName: string, password: string): Promise<void> {
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
    const currentUser = await client.query<{ current_user: string }>("SELECT current_user");
    if (currentUser.rows[0]?.current_user === safeRoleName) throw new Error("Knowledge role must not be the current database role.");
    const existing = await client.query<{ oid: string }>("SELECT oid::text AS oid FROM pg_catalog.pg_roles WHERE rolname = $1", [safeRoleName]);
    if (existing.rowCount) {
      const ownership = await client.query<{ kind: string }>(
        `SELECT kind FROM (
           SELECT 'database' AS kind FROM pg_catalog.pg_database WHERE datdba = $1::oid
           UNION ALL SELECT 'schema' FROM pg_catalog.pg_namespace WHERE nspowner = $1::oid
           UNION ALL SELECT 'relation' FROM pg_catalog.pg_class WHERE relowner = $1::oid
           UNION ALL SELECT 'function' FROM pg_catalog.pg_proc WHERE proowner = $1::oid
           UNION ALL SELECT 'type' FROM pg_catalog.pg_type WHERE typowner = $1::oid
           UNION ALL SELECT 'owned object' FROM pg_catalog.pg_shdepend
             WHERE refclassid = 'pg_catalog.pg_authid'::regclass AND refobjid = $1::oid AND deptype = 'o'
           UNION ALL SELECT 'membership' FROM pg_catalog.pg_auth_members WHERE roleid = $1::oid OR member = $1::oid
         ) owned LIMIT 1`,
        [existing.rows[0]!.oid],
      );
      if (ownership.rowCount) throw new Error(`Knowledge role ${safeRoleName} must not own objects or have memberships (${ownership.rows[0]!.kind}).`);
      await client.query(`DROP OWNED BY ${roleIdentifier}`);
      await client.query(`ALTER ROLE ${roleIdentifier} LOGIN PASSWORD ${passwordLiteral} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    } else {
      await client.query(`CREATE ROLE ${roleIdentifier} LOGIN PASSWORD ${passwordLiteral} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    }

    await client.query("REVOKE CREATE ON SCHEMA public, knowledge_boss, pgboss FROM PUBLIC");
    await client.query("REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public, knowledge_boss, pgboss FROM PUBLIC");
    await client.query("REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public, knowledge_boss, pgboss FROM PUBLIC");
    await client.query(`REVOKE ALL PRIVILEGES ON SCHEMA public, knowledge_boss, pgboss FROM ${roleIdentifier}`);
    await client.query(`GRANT USAGE ON SCHEMA public, knowledge_boss TO ${roleIdentifier}`);
    await client.query(`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ${roleIdentifier}`);
    await client.query(`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA pgboss FROM ${roleIdentifier}`);
    await client.query(`REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM ${roleIdentifier}`);
    await client.query(`REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA pgboss FROM ${roleIdentifier}`);
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.knowledge_promotion_requests TO ${roleIdentifier}`);
    await client.query(`
      GRANT SELECT, INSERT, UPDATE ON TABLE public.knowledge_sources TO ${roleIdentifier};
      GRANT SELECT, INSERT ON TABLE public.source_versions TO ${roleIdentifier};
      GRANT SELECT, INSERT, DELETE ON TABLE public.knowledge_chunks TO ${roleIdentifier};
      GRANT SELECT, INSERT, UPDATE ON TABLE public.knowledge_revision TO ${roleIdentifier};
    `);
    await client.query(`GRANT USAGE ON SEQUENCE public.source_versions_id_seq, public.knowledge_chunks_id_seq TO ${roleIdentifier}`);
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA knowledge_boss TO ${roleIdentifier}`);
    await client.query(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA knowledge_boss TO ${roleIdentifier}`);
    const database = await client.query<{ current_database: string }>("SELECT current_database()");
    const databaseIdentifier = quoteIdentifier(database.rows[0]?.current_database ?? "");
    await client.query(`REVOKE CREATE ON DATABASE ${databaseIdentifier} FROM ${roleIdentifier}`);
    const createPrivileges = await client.query<{ database_create: boolean; schema_create: boolean }>(
      `SELECT
         has_database_privilege($1, current_database(), 'CREATE') AS database_create,
         EXISTS (
           SELECT 1 FROM pg_catalog.pg_namespace
           WHERE has_schema_privilege($1, oid, 'CREATE')
         ) AS schema_create`,
      [safeRoleName],
    );
    if (createPrivileges.rows[0]?.database_create || createPrivileges.rows[0]?.schema_create) {
      throw new Error(`Knowledge role ${safeRoleName} must not have CREATE on the database or any schema.`);
    }
    await client.query("COMMIT");
    inTransaction = false;
  } catch (error) {
    if (client && inTransaction) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client?.release();
    await db.end();
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_OWNER_URL?.trim();
  if (!databaseUrl) throw new Error("DATABASE_OWNER_URL is required");
  const roleName = process.env.VENNEK_KNOWLEDGE_DB_USER?.trim();
  const password = process.env.VENNEK_KNOWLEDGE_DB_PASSWORD;
  if (!roleName) throw new Error("VENNEK_KNOWLEDGE_DB_USER is required");
  if (password === undefined) throw new Error("VENNEK_KNOWLEDGE_DB_PASSWORD is required");
  await provisionKnowledgeRole(databaseUrl, roleName, password);
  console.log(`Provisioned knowledge role ${validateRoleName(roleName)}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
