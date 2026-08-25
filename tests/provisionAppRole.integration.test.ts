import { createHash, randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PgBoss } from "pg-boss";
import { sha256Hex } from "@vennek/shared";
import {
  createDatabase,
  ensureConversationPartitions,
  KnowledgeRepository,
  retrieveEvidence,
  type EmbeddingProvider,
  type SourceRegistryEntry,
} from "@vennek/cardano-agent";
import {
  provisionAppRole,
  quoteIdentifier,
  validateRoleName,
} from "../scripts/provision-app-role.js";

const ownerUrl = process.env.TEST_DATABASE_OWNER_URL;

async function cleanupRole(owner: ReturnType<typeof createDatabase>, roleName: string): Promise<void> {
  const safeRoleName = validateRoleName(roleName);
  const roleIdentifier = quoteIdentifier(safeRoleName);
  const role = await owner.query("SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1", [safeRoleName]);
  if (!role.rowCount) return;
  try {
    await owner.query(`DROP OWNED BY ${roleIdentifier}`);
  } finally {
    await owner.query(`DROP ROLE ${roleIdentifier}`);
  }
}

describe.skipIf(!ownerUrl)("restricted application role", () => {
  it("can retrieve and cache knowledge without knowledge write privileges", async () => {
    const suffix = `${process.pid}_${Date.now()}`;
    const roleName = `vennek_retrieve_app_${suffix}`;
    const password = randomBytes(24).toString("base64");
    const sourceId = `role-retrieval-${process.pid}-${Date.now()}`;
    const canonicalUrl = `https://${sourceId}.example.com/docs`;
    const query = `role retrieval ${suffix}`;
    const model = "test-retrieval-model";
    const telegramUserId = `role-user-${process.pid}-${Date.now()}`;
    const owner = createDatabase(ownerUrl!);
    const appUrl = new URL(ownerUrl!);
    appUrl.username = roleName;
    appUrl.password = password;
    const app = createDatabase(appUrl.toString());
    const repository = new KnowledgeRepository(owner);
    const entry: SourceRegistryEntry = {
      id: sourceId,
      owner: "Cardano",
      trustTier: "official",
      kind: "page",
      url: canonicalUrl,
      allowedDomains: [`${sourceId}.example.com`],
      topics: ["developer"],
      networks: ["mainnet"],
      refresh: "daily",
    };
    const embedding = Array.from({ length: 1_536 }, (_, index) => index === 0 ? 1 : 0);
    const embedder: EmbeddingProvider = {
      embed: async (inputs) => inputs.map((_, index) => ({ index, embedding })),
    };

    try {
      await repository.ensureSource(entry);
      const version = await repository.storeVersion({
        sourceId,
        canonicalUrl,
        title: "Role retrieval",
        content: query,
        contentHash: sha256Hex(query),
        retrievedAt: new Date("2026-08-25T00:00:00.000Z"),
      });
      await repository.replaceChunks(version.id, [{
        ordinal: 0,
        heading: "Role retrieval",
        content: query,
        contentHash: sha256Hex(`Role retrieval\n${query}`),
        embeddingModel: model,
        embedding,
      }]);

      await provisionAppRole(ownerUrl!, roleName, password);
      await owner.query("INSERT INTO telegram_users (telegram_user_id) VALUES ($1)", [telegramUserId]);
      await app.query(
        `INSERT INTO usage_ledger
         (telegram_user_id, model, prompt_tokens, completion_tokens, latency_ms)
         VALUES ($1, $2, $3, $4, $5)`,
        [telegramUserId, "cardano-fast", 4, 2, 17],
      );
      const ownerUsage = await owner.query<{ telegram_user_id: string; model: string; prompt_tokens: number; completion_tokens: number; latency_ms: number }>(
        "SELECT telegram_user_id, model, prompt_tokens, completion_tokens, latency_ms FROM usage_ledger WHERE telegram_user_id = $1",
        [telegramUserId],
      );
      expect(ownerUsage.rows[0]).toMatchObject({ telegram_user_id: telegramUserId, model: "cardano-fast", prompt_tokens: 4, completion_tokens: 2, latency_ms: 17 });
      await expect(app.query("SELECT model FROM usage_ledger WHERE telegram_user_id = $1", [telegramUserId])).rejects.toThrow(/permission denied/i);
      await expect(app.query("UPDATE usage_ledger SET model = 'forbidden' WHERE telegram_user_id = $1", [telegramUserId])).rejects.toThrow(/permission denied/i);
      await expect(app.query("DELETE FROM usage_ledger WHERE telegram_user_id = $1", [telegramUserId])).rejects.toThrow(/permission denied/i);
      await expect(app.query("SELECT setval('public.usage_ledger_id_seq'::regclass, 1)")).rejects.toThrow(/permission denied/i);
      await expect(app.query("SELECT setval('public.conversation_messages_id_seq'::regclass, 1)")).rejects.toThrow(/permission denied/i);
      const auditGrants = await owner.query<{ table_name: string; privilege_type: string }>(
        `SELECT table_name, privilege_type FROM information_schema.role_table_grants
         WHERE grantee = $1 AND table_schema = 'public'
           AND table_name = 'knowledge_promotion_requests'
         ORDER BY privilege_type`,
        [roleName],
      );
      expect(auditGrants.rows).toEqual([]);
      const auditRequestId = randomUUID();
      const auditNonceDigest = createHash("sha256").update(auditRequestId).digest();
      await expect(app.query(
        "SELECT state FROM public.knowledge_promotion_requests WHERE request_id = $1",
        [auditRequestId],
      )).rejects.toThrow(/permission denied/i);
      await expect(app.query(
        `INSERT INTO public.knowledge_promotion_requests (request_id, caller_id, nonce_digest, state)
         VALUES ($1, $2, $3, 'started')`,
        [auditRequestId, `app-role-${process.pid}`, auditNonceDigest],
      )).rejects.toThrow(/permission denied/i);
      await expect(app.query(
        "UPDATE public.knowledge_promotion_requests SET state = 'started' WHERE request_id = $1",
        [auditRequestId],
      )).rejects.toThrow(/permission denied/i);
      await expect(app.query(
        "DELETE FROM public.knowledge_promotion_requests WHERE request_id = $1",
        [auditRequestId],
      )).rejects.toThrow(/permission denied/i);
      const request = {
        query,
        language: "en",
        embeddingModel: model,
        cachePolicy: "stable",
        now: new Date("2026-08-25T00:00:00.000Z"),
      } as const;
      let evidence = await retrieveEvidence(request, { db: app, embedder });
      let cached = await app.query("SELECT count(*)::text AS count FROM retrieval_cache WHERE query_hash = $1", [sha256Hex(query)]);
      for (let attempt = 0; attempt < 7 && cached.rows[0]?.count !== "1"; attempt += 1) {
        evidence = await retrieveEvidence(request, { db: app, embedder });
        cached = await app.query("SELECT count(*)::text AS count FROM retrieval_cache WHERE query_hash = $1", [sha256Hex(query)]);
      }
      expect(evidence[0]?.sourceId).toBe(sourceId);
      expect(cached.rows[0]?.count).toBe("1");
      await expect(app.query(
        "INSERT INTO knowledge_sources (id, owner, trust_tier, registry) VALUES ($1, 'x', 'community', '{}'::jsonb)",
        [`forbidden-${sourceId}`],
      )).rejects.toThrow(/permission denied/i);
      await expect(app.query("UPDATE source_versions SET title = 'forbidden' WHERE id = $1", [version.id])).rejects.toThrow(/permission denied/i);
      await expect(app.query(
        "INSERT INTO knowledge_chunks (version_id, ordinal, heading, content, content_hash, embedding_model, embedding) VALUES ($1, 99, 'x', 'x', $2, $3, $4::vector)",
        [version.id, sha256Hex("x"), model, `[${embedding.join(",")}]`],
      )).rejects.toThrow(/permission denied/i);
    } finally {
      await app.end().catch(() => undefined);
      await owner.query("DELETE FROM usage_ledger WHERE telegram_user_id = $1", [telegramUserId]).catch(() => undefined);
      await owner.query("DELETE FROM telegram_users WHERE telegram_user_id = $1", [telegramUserId]).catch(() => undefined);
      await owner.query("DELETE FROM retrieval_cache WHERE query_hash = $1", [sha256Hex(query)]).catch(() => undefined);
      await owner.query("DELETE FROM source_versions WHERE source_id = $1", [sourceId]).catch(() => undefined);
      await owner.query("DELETE FROM knowledge_sources WHERE id = $1", [sourceId]).catch(() => undefined);
      await cleanupRole(owner, roleName).catch(() => undefined);
      await owner.end();
    }
  }, 30_000);

  it("rejects the owner role and existing roles with owned objects or memberships", async () => {
    const owner = createDatabase(ownerUrl!);
    const ownerRole = validateRoleName(decodeURIComponent(new URL(ownerUrl!).username));
    const password = randomBytes(24).toString("base64");
    const ownedRole = `vennek_owned_${process.pid}_${Date.now()}`;
    const memberRole = `vennek_member_${process.pid}_${Date.now()}`;
    const groupRole = `vennek_group_${process.pid}_${Date.now()}`;
    const ownedSchema = `vennek_owned_schema_${process.pid}_${Date.now()}`;

    try {
      await expect(provisionAppRole(ownerUrl!, ownerRole, password)).rejects.toThrow(/current database role/i);

      await owner.query(`CREATE ROLE ${quoteIdentifier(ownedRole)}`);
      await owner.query(`CREATE SCHEMA ${quoteIdentifier(ownedSchema)} AUTHORIZATION ${quoteIdentifier(ownedRole)}`);
      await expect(provisionAppRole(ownerUrl!, ownedRole, password)).rejects.toThrow(/schema/i);

      await owner.query(`CREATE ROLE ${quoteIdentifier(memberRole)}`);
      await owner.query(`CREATE ROLE ${quoteIdentifier(groupRole)}`);
      await owner.query(`GRANT ${quoteIdentifier(groupRole)} TO ${quoteIdentifier(memberRole)}`);
      await expect(provisionAppRole(ownerUrl!, memberRole, password)).rejects.toThrow(/membership/i);
    } finally {
      try {
        await cleanupRole(owner, ownedRole);
      } finally {
        try {
          await owner.query(`REVOKE ${quoteIdentifier(groupRole)} FROM ${quoteIdentifier(memberRole)}`);
        } finally {
          try {
            await cleanupRole(owner, memberRole);
          } finally {
            try {
              await cleanupRole(owner, groupRole);
            } finally {
              await owner.end();
            }
          }
        }
      }
    }
  }, 30_000);

  it("blocks CREATE and permits partition, queue send/work, and scheduling paths", async () => {
    const roleName = `vennek_test_app_${process.pid}_${Date.now()}`;
    const password = randomBytes(24).toString("base64");
    const appUrl = new URL(ownerUrl!);
    appUrl.username = roleName;
    appUrl.password = password;
    const owner = createDatabase(ownerUrl!);
    const app = createDatabase(appUrl.toString());
    const boss = new PgBoss({
      db: { executeSql: (text, values) => app.query(text, values) },
      migrate: false,
      createSchema: false,
    });
    const queue = "telegram-answer";
    const partitionQueue = "conversation-partition-maintenance";
    const updateId = 9_000_000_000_000_000 + (Date.now() % 100_000);
    let jobId: string | null = null;

    try {
      await provisionAppRole(ownerUrl!, roleName, password);
      await expect(ensureConversationPartitions(app, new Date("2031-04-15T00:00:00.000Z")))
        .rejects.toThrow(/permission denied/i);
      await ensureConversationPartitions(owner, new Date("2031-04-15T00:00:00.000Z"));
      await expect(app.query(
        "SELECT public.ensure_conversation_partitions($1::timestamptz)",
        [new Date("2099-04-15T00:00:00.000Z")],
      )).resolves.toBeDefined();
      const compatibilityPartition = await owner.query<{ partition: string | null }>(
        "SELECT pg_catalog.to_regclass('public.conversation_messages_2099_04')::text AS partition",
      );
      expect(compatibilityPartition.rows[0]?.partition).toBeNull();
      await expect(app.query("CREATE TABLE public.vennek_forbidden_table (id integer)"))
        .rejects.toThrow(/permission denied|must be owner/i);
      await expect(app.query("CREATE TABLE pgboss.vennek_forbidden_table (id integer)"))
        .rejects.toThrow(/permission denied|must be owner/i);
      await ensureConversationPartitions(app);
      await boss.start();

      const handled = new Promise<void>((resolve, reject) => {
        void boss.work(queue, async ([job]) => {
          if (!job) return;
          if (job.data && typeof job.data === "object" && "updateId" in job.data && job.data.updateId === updateId) {
            resolve();
          }
        }).catch(reject);
      });
      jobId = await boss.send(queue, { updateId });
      expect(jobId).toEqual(expect.any(String));
      await boss.schedule(partitionQueue, "0 0 * * *", null, { key: `test-${updateId}` });
      await expect(Promise.race([
        handled,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("worker timeout")), 10_000)),
      ])).resolves.toBeUndefined();
    } finally {
      try {
        await boss.unschedule(partitionQueue, `test-${updateId}`);
      } finally {
        try {
          if (jobId) await boss.deleteJob(queue, jobId);
        } finally {
          try {
            await boss.stop();
          } finally {
            try {
              await app.end();
            } finally {
              try {
                await cleanupRole(owner, roleName);
              } finally {
                await owner.end();
              }
            }
          }
        }
      }
    }
  }, 30_000);

  it("normalizes a pre-existing role and allows password rotation", async () => {
    const roleName = `vennek_reprovision_${process.pid}_${Date.now()}`;
    const initialPassword = randomBytes(24).toString("base64");
    const rotatedPassword = randomBytes(24).toString("base64");
    const roleIdentifier = quoteIdentifier(roleName);
    const owner = createDatabase(ownerUrl!);
    const initialAppUrl = new URL(ownerUrl!);
    initialAppUrl.username = roleName;
    initialAppUrl.password = initialPassword;
    const rotatedAppUrl = new URL(ownerUrl!);
    rotatedAppUrl.username = roleName;
    rotatedAppUrl.password = rotatedPassword;

    try {
      await owner.query(`CREATE ROLE ${roleIdentifier} LOGIN PASSWORD '${initialPassword}'`);
      const database = await owner.query<{ name: string }>("SELECT current_database() AS name");
      await owner.query(`GRANT CREATE ON DATABASE ${quoteIdentifier(database.rows[0]!.name)} TO ${roleIdentifier}`);
      await owner.query(`GRANT SELECT ON TABLE public.schema_migrations TO ${roleIdentifier}`);

      await provisionAppRole(ownerUrl!, roleName, initialPassword);

      const privileges = await owner.query<{
        database_create: boolean;
        unrelated_select: boolean;
        knowledge_select: boolean;
        source_insert: boolean;
        revision_select: boolean;
        retrieval_insert: boolean;
        schema_create_count: string;
      }>(
        `SELECT
           has_database_privilege($1, current_database(), 'CREATE') AS database_create,
           has_table_privilege($1, 'public.schema_migrations', 'SELECT') AS unrelated_select,
           has_table_privilege($1, 'public.knowledge_sources', 'SELECT') AS knowledge_select,
           has_table_privilege($1, 'public.knowledge_sources', 'INSERT') AS source_insert,
           has_table_privilege($1, 'public.knowledge_revision', 'SELECT') AS revision_select,
           has_table_privilege($1, 'public.retrieval_cache', 'INSERT') AS retrieval_insert,
           (SELECT count(*) FROM pg_catalog.pg_namespace
            WHERE has_schema_privilege($1, oid, 'CREATE'))::text AS schema_create_count`,
        [roleName],
      );
      expect(privileges.rows[0]).toEqual({
        database_create: false,
        unrelated_select: false,
        knowledge_select: true,
        source_insert: false,
        revision_select: true,
        retrieval_insert: true,
        schema_create_count: "0",
      });

      const initialApp = createDatabase(initialAppUrl.toString());
      try {
        await expect(initialApp.query("SELECT 1")).resolves.toBeDefined();
      } finally {
        await initialApp.end();
      }

      await provisionAppRole(ownerUrl!, roleName, rotatedPassword);

      const reprovisioned = await owner.query<{ knowledge_select: boolean; source_insert: boolean; retrieval_insert: boolean }>(
        `SELECT
           has_table_privilege($1, 'public.knowledge_sources', 'SELECT') AS knowledge_select,
           has_table_privilege($1, 'public.knowledge_sources', 'INSERT') AS source_insert,
           has_table_privilege($1, 'public.retrieval_cache', 'INSERT') AS retrieval_insert`,
        [roleName],
      );
      expect(reprovisioned.rows[0]).toEqual({ knowledge_select: true, source_insert: false, retrieval_insert: true });

      const rotatedApp = createDatabase(rotatedAppUrl.toString());
      try {
        await expect(rotatedApp.query("SELECT public.ensure_conversation_partitions()")).resolves.toBeDefined();
      } finally {
        await rotatedApp.end();
      }
    } finally {
      try {
        await cleanupRole(owner, roleName);
      } finally {
        await owner.end();
      }
    }
  }, 30_000);
});
