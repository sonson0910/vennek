import { describe, expect, it } from "vitest";
import { randomInt } from "node:crypto";
import { PgBoss } from "pg-boss";
import { createDatabase } from "@vennek/cardano-agent";
import {
  PgBossAgentQueue,
  PRIVATE_COMPARISON_EXPIRE_SECONDS,
  PRIVATE_COMPARISON_MAX_LIFETIME_SECONDS,
  PRIVATE_COMPARISON_QUEUE,
  PRIVATE_COMPARISON_RETENTION_SECONDS,
  PRIVATE_COMPARISON_RETRY_BACKOFF,
  PRIVATE_COMPARISON_RETRY_DELAY_SECONDS,
  PRIVATE_COMPARISON_RETRY_LIMIT,
} from "@vennek/telegram-bot";

const databaseUrl = process.env.TEST_DATABASE_URL;
const runIntegration = describe.skipIf(!databaseUrl);

function createIntegrationBoss(): PgBoss {
  return new PgBoss({
    connectionString: databaseUrl!,
    maintenanceIntervalSeconds: 1,
    monitorIntervalSeconds: 1,
    superviseIntervalSeconds: 1,
  });
}

runIntegration("private comparison queue PostgreSQL/PgBoss integration", () => {
  it("admits one replay-safe encrypted job and deletes it after terminal completion", async () => {
    const db = createDatabase(databaseUrl!);
    const boss = createIntegrationBoss();
    const key = Buffer.alloc(32, 7);
    const updateId = 8_300_000_000_000_000 + randomInt(0, 100_000_000);
    const userId = String(updateId);
    const chatId = userId;
    const queue = new PgBossAgentQueue(boss, db, key);
    const job = {
      kind: "private-compare" as const,
      updateId,
      telegramUserId: userId,
      telegramChatId: chatId,
      metadata: {
        caption: "Compare Cardano governance claims",
        fileId: `integration-file-${updateId}`,
        fileUniqueId: `integration-unique-${updateId}`,
        fileName: "claims.md",
        mime: "text/markdown",
        fileSize: 1234,
      },
    };
    let jobId: string | undefined;

    try {
      await boss.start();
      await boss.createQueue(PRIVATE_COMPARISON_QUEUE, {
        retryLimit: PRIVATE_COMPARISON_RETRY_LIMIT,
        retryDelay: PRIVATE_COMPARISON_RETRY_DELAY_SECONDS,
        retryBackoff: PRIVATE_COMPARISON_RETRY_BACKOFF,
        expireInSeconds: PRIVATE_COMPARISON_EXPIRE_SECONDS,
        retentionSeconds: PRIVATE_COMPARISON_RETENTION_SECONDS,
        deleteAfterSeconds: 1,
      });

      const results = await Promise.all([queue.enqueue(job), queue.enqueue(job)]);
      expect(results.sort()).toEqual([false, true]);

      const jobs = await boss.findJobs(PRIVATE_COMPARISON_QUEUE, { key: `private:${updateId}`, queued: true });
      expect(jobs).toHaveLength(1);
      jobId = jobs[0]?.id;
      expect(JSON.stringify(jobs[0]?.data)).not.toContain(job.metadata.caption);
      expect(JSON.stringify(jobs[0]?.data)).not.toContain(job.metadata.fileId);
      if (!jobId) throw new Error("Expected an admitted private comparison job");

      await boss.complete(PRIVATE_COMPARISON_QUEUE, jobId, undefined, { includeQueued: true });
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        await boss.supervise(PRIVATE_COMPARISON_QUEUE);
        const remaining = await boss.findJobs(PRIVATE_COMPARISON_QUEUE, { id: jobId });
        if (remaining.length === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await expect(boss.findJobs(PRIVATE_COMPARISON_QUEUE, { id: jobId })).resolves.toHaveLength(0);
    } finally {
      if (jobId) await boss.deleteJob(PRIVATE_COMPARISON_QUEUE, jobId).catch(() => undefined);
      await db.query("DELETE FROM telegram_updates WHERE update_id = $1", [updateId]).catch(() => undefined);
      await db.query(
        "DELETE FROM telegram_admission_windows WHERE (subject_type = 'user' AND subject_id = $1) OR (subject_type = 'chat' AND subject_id = $2)",
        [userId, chatId],
      ).catch(() => undefined);
      await boss.stop().catch(() => undefined);
      await db.end();
    }
  }, 15_000);

  it("requeues an abandoned active job after its configured expiry", async () => {
    const db = createDatabase(databaseUrl!);
    const boss = createIntegrationBoss();
    const key = Buffer.alloc(32, 7);
    const updateId = 8_300_000_000_000_000 + randomInt(0, 100_000_000);
    const userId = String(updateId);
    const job = {
      kind: "private-compare" as const,
      updateId,
      telegramUserId: userId,
      telegramChatId: userId,
      metadata: {
        caption: "Compare Cardano governance claims",
        fileId: `integration-abandoned-file-${updateId}`,
        fileUniqueId: `integration-abandoned-unique-${updateId}`,
      },
    };
    let jobId: string | undefined;

    try {
      await boss.start();
      await boss.createQueue(PRIVATE_COMPARISON_QUEUE, {
        retryLimit: PRIVATE_COMPARISON_RETRY_LIMIT,
        retryDelay: PRIVATE_COMPARISON_RETRY_DELAY_SECONDS,
        retryBackoff: PRIVATE_COMPARISON_RETRY_BACKOFF,
        expireInSeconds: PRIVATE_COMPARISON_EXPIRE_SECONDS,
        retentionSeconds: PRIVATE_COMPARISON_RETENTION_SECONDS,
        deleteAfterSeconds: 1,
      });

      const queue = new PgBossAgentQueue(boss, db, key);
      await expect(queue.enqueue(job)).resolves.toBe(true);
      const active = await boss.fetch(PRIVATE_COMPARISON_QUEUE);
      jobId = active[0]?.id;
      if (!jobId) throw new Error("Expected an active integration job");

      await db.query(
        "UPDATE pgboss.job SET started_on = now() - interval '1801 seconds' WHERE id = $1",
        [jobId],
      );
      let retried = await boss.findJobs(PRIVATE_COMPARISON_QUEUE, { key: `private:${updateId}` });
      const retryDeadline = Date.now() + 5_000;
      while (Date.now() < retryDeadline && retried[0]?.state !== "retry") {
        await boss.supervise(PRIVATE_COMPARISON_QUEUE);
        retried = await boss.findJobs(PRIVATE_COMPARISON_QUEUE, { key: `private:${updateId}` });
        if (retried[0]?.state === "retry") break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(retried).toHaveLength(1);
      const retriedJob = retried[0];
      expect(retriedJob?.state).toBe("retry");
      expect(retriedJob?.retryLimit).toBe(PRIVATE_COMPARISON_RETRY_LIMIT);
      expect(retriedJob?.expireInSeconds).toBe(PRIVATE_COMPARISON_EXPIRE_SECONDS);
      expect(retriedJob?.retryDelay).toBe(PRIVATE_COMPARISON_RETRY_DELAY_SECONDS);
      expect(retriedJob?.retryBackoff).toBe(PRIVATE_COMPARISON_RETRY_BACKOFF);
      if (!retriedJob) throw new Error("Expected a retry job");
      expect(retriedJob.retryCount).toBeGreaterThanOrEqual(0);
      expect(retriedJob.retryCount).toBeLessThanOrEqual(PRIVATE_COMPARISON_RETRY_LIMIT);
      const createdToKeepUntil = retriedJob.keepUntil.getTime() - retriedJob.createdOn.getTime();
      const createdToNextAttempt = retriedJob.startAfter.getTime() - retriedJob.createdOn.getTime();
      expect(createdToKeepUntil).toBeGreaterThanOrEqual(0);
      expect(createdToKeepUntil).toBeLessThanOrEqual(PRIVATE_COMPARISON_RETENTION_SECONDS * 1_000);
      expect(createdToNextAttempt).toBeGreaterThanOrEqual(0);
      expect(createdToNextAttempt).toBeLessThanOrEqual(PRIVATE_COMPARISON_MAX_LIFETIME_SECONDS * 1_000);
    } finally {
      const remaining = await boss.findJobs(PRIVATE_COMPARISON_QUEUE, { key: `private:${updateId}` }).catch(() => []);
      for (const remainingJob of remaining) {
        await boss.deleteJob(PRIVATE_COMPARISON_QUEUE, remainingJob.id).catch(() => undefined);
      }
      if (jobId) await boss.deleteJob(PRIVATE_COMPARISON_QUEUE, jobId).catch(() => undefined);
      await db.query("DELETE FROM telegram_updates WHERE update_id = $1", [updateId]).catch(() => undefined);
      await db.query(
        "DELETE FROM telegram_admission_windows WHERE (subject_type = 'user' AND subject_id = $1) OR (subject_type = 'chat' AND subject_id = $2)",
        [userId, userId],
      ).catch(() => undefined);
      await boss.stop().catch(() => undefined);
      await db.end();
    }
  }, 15_000);
});
