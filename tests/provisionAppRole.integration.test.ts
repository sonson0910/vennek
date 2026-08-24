import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PgBoss } from "pg-boss";
import { createDatabase, ensureConversationPartitions } from "@vennek/cardano-agent";
import { provisionAppRole } from "../scripts/provision-app-role.js";

const ownerUrl = process.env.TEST_DATABASE_OWNER_URL;

describe.skipIf(!ownerUrl)("restricted application role", () => {
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
      await expect(app.query("CREATE TABLE public.vennek_forbidden_table (id integer)"))
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
      await boss.unschedule(partitionQueue, `test-${updateId}`).catch(() => undefined);
      if (jobId) await boss.deleteJob(queue, jobId).catch(() => undefined);
      await boss.stop().catch(() => undefined);
      await app.end().catch(() => undefined);
      await owner.query(`DROP ROLE IF EXISTS "${roleName}"`).catch(() => undefined);
      await owner.end();
    }
  }, 30_000);
});
