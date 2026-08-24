import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PgBoss } from "pg-boss";
import { createDatabase, ensureConversationPartitions } from "@vennek/cardano-agent";
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
});
