import { createHash, randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PgBoss } from "pg-boss";
import { createDatabase, PromotionAuditRepository } from "@vennek/cardano-agent";
import { provisionKnowledgeRole } from "../scripts/provision-knowledge-role.js";
import { quoteIdentifier, validateRoleName } from "../scripts/provision-app-role.js";
import { KNOWLEDGE_QUEUE, loadKnowledgeSourceMap, scheduleKnowledgeSources } from "../apps/telegram-bot/src/knowledgeWorker.js";

const ownerUrl = process.env.TEST_DATABASE_OWNER_URL;

describe.skipIf(!ownerUrl)("restricted knowledge role", () => {
  it("grants ingestion tables and isolated PgBoss access only", async () => {
    const owner = createDatabase(ownerUrl!);
    const roleName = `vennek_knowledge_${process.pid}_${Date.now()}`;
    const initialPassword = randomBytes(24).toString("base64");
    const finalPassword = randomBytes(24).toString("base64");
    const appUrl = new URL(ownerUrl!);
    appUrl.username = roleName;
    appUrl.password = finalPassword;
    const app = createDatabase(appUrl.toString());
    const auditRequestId = randomUUID();
    let knowledgeBoss: PgBoss | undefined;
    try {
      await provisionKnowledgeRole(ownerUrl!, roleName, initialPassword);
      await provisionKnowledgeRole(ownerUrl!, roleName, finalPassword);
      const grants = await owner.query<{ table_name: string; privilege_type: string }>(
        `SELECT table_name, privilege_type FROM information_schema.role_table_grants
         WHERE grantee = $1 AND table_schema = 'public'
           AND table_name IN ('knowledge_sources', 'source_versions', 'knowledge_chunks', 'knowledge_revision')`,
        [roleName],
      );
      expect(grants.rows).toEqual(expect.arrayContaining([
        { table_name: "knowledge_sources", privilege_type: "SELECT" },
        { table_name: "knowledge_sources", privilege_type: "INSERT" },
        { table_name: "knowledge_sources", privilege_type: "UPDATE" },
        { table_name: "source_versions", privilege_type: "SELECT" },
        { table_name: "source_versions", privilege_type: "INSERT" },
        { table_name: "knowledge_chunks", privilege_type: "DELETE" },
      ]));
      const auditGrants = await owner.query<{ table_name: string; privilege_type: string }>(
        `SELECT table_name, privilege_type FROM information_schema.role_table_grants
         WHERE grantee = $1 AND table_schema = 'public'
           AND table_name = 'knowledge_promotion_requests'
         ORDER BY privilege_type`,
        [roleName],
      );
      expect(auditGrants.rows).toEqual([
        { table_name: "knowledge_promotion_requests", privilege_type: "DELETE" },
        { table_name: "knowledge_promotion_requests", privilege_type: "INSERT" },
        { table_name: "knowledge_promotion_requests", privilege_type: "SELECT" },
        { table_name: "knowledge_promotion_requests", privilege_type: "UPDATE" },
      ]);

      const audit = new PromotionAuditRepository(app);
      const auditInput = {
        requestId: auditRequestId,
        callerId: `knowledge-role-${process.pid}`,
        nonceDigest: createHash("sha256").update(auditRequestId).digest(),
      };
      await expect(audit.claim(auditInput)).resolves.toEqual({ kind: "claimed" });
      await expect(app.query(
        "SELECT state, outcome FROM public.knowledge_promotion_requests WHERE request_id = $1",
        [auditRequestId],
      )).resolves.toMatchObject({ rows: [{ state: "started", outcome: null }] });
      await expect(audit.complete(auditRequestId, {
        outcome: "promoted",
        promotedCount: 1,
        latencyMs: 12,
      })).resolves.toBeUndefined();
      await expect(app.query(
        "SELECT state, outcome, promoted_count, latency_ms FROM public.knowledge_promotion_requests WHERE request_id = $1",
        [auditRequestId],
      )).resolves.toMatchObject({
        rows: [{ state: "succeeded", outcome: "promoted", promoted_count: 1, latency_ms: 12 }],
      });
      await owner.query(
        "UPDATE public.knowledge_promotion_requests SET received_at = $2 WHERE request_id = $1",
        [auditRequestId, new Date("1900-01-01T00:00:00.000Z")],
      );
      await expect(audit.prune(new Date("1900-02-01T00:00:00.000Z"))).resolves.toBe(1);
      await expect(app.query(
        "SELECT 1 FROM public.knowledge_promotion_requests WHERE request_id = $1",
        [auditRequestId],
      )).resolves.toMatchObject({ rows: [] });

      await expect(app.query("SELECT * FROM conversation_messages LIMIT 1")).rejects.toThrow(/permission denied/i);
      await expect(app.query("SELECT * FROM usage_ledger LIMIT 1")).rejects.toThrow(/permission denied/i);
      await expect(app.query("CREATE TABLE public.knowledge_role_forbidden (id integer)")).rejects.toThrow(/permission denied|must be owner/i);
      await expect(app.query("CREATE TABLE pgboss.knowledge_role_forbidden (id integer)")).rejects.toThrow(/permission denied|must be owner/i);
      const createPrivileges = await app.query<{ database_create: boolean; schema_create_count: string }>(
        `SELECT
           has_database_privilege(current_user, current_database(), 'CREATE') AS database_create,
           (SELECT count(*) FROM pg_catalog.pg_namespace
            WHERE has_schema_privilege(current_user, oid, 'CREATE'))::text AS schema_create_count`,
      );
      expect(createPrivileges.rows[0]).toEqual({ database_create: false, schema_create_count: "0" });

      knowledgeBoss = new PgBoss({
        db: { executeSql: (text, values) => app.query(text, values) },
        schema: "knowledge_boss",
        migrate: false,
        createSchema: false,
      });
      await knowledgeBoss.start();
      const cardanoOrg = loadKnowledgeSourceMap().get("cardano-org");
      expect(cardanoOrg).toBeDefined();
      await scheduleKnowledgeSources(knowledgeBoss, new Map([["cardano-org", cardanoOrg!]]));
      const schedules = await knowledgeBoss.getSchedules(KNOWLEDGE_QUEUE);
      expect(schedules).toContainEqual(expect.objectContaining({
        key: "source/cardano-org",
        cron: "15 2 * * *",
        timezone: "UTC",
      }));
      await knowledgeBoss.unschedule(KNOWLEDGE_QUEUE, "source/cardano-org");
      const singletonKey = `integration:${roleName}`;
      const jobId = await knowledgeBoss.send("sync-cardano-source", { sourceId: "cardano-org" }, { singletonKey });
      const duplicateJobId = await knowledgeBoss.send("sync-cardano-source", { sourceId: "cardano-org" }, { singletonKey });
      expect(jobId).toEqual(expect.any(String));
      expect(duplicateJobId).toBeNull();
      await knowledgeBoss.deleteJob("sync-cardano-source", jobId!);
      await knowledgeBoss.stop();
      knowledgeBoss = undefined;
      await expect(app.query("SELECT 1 FROM pgboss.job LIMIT 1")).rejects.toThrow(/permission denied/i);
    } finally {
      await knowledgeBoss?.stop().catch(() => undefined);
      await app.end().catch(() => undefined);
      await owner.query(
        "DELETE FROM public.knowledge_promotion_requests WHERE request_id = $1",
        [auditRequestId],
      ).catch(() => undefined);
      const safe = quoteIdentifier(validateRoleName(roleName));
      await owner.query(`DROP OWNED BY ${safe}`).catch(() => undefined);
      await owner.query(`DROP ROLE ${safe}`).catch(() => undefined);
      await owner.end();
    }
  }, 30_000);
});
