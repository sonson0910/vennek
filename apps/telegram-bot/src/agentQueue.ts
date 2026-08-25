import { findWalletSecret } from "@vennek/cardano-agent";
import {
  enqueuePgBossJob,
  PgBossPrivateComparisonQueue,
  type PgBossDatabase,
  type PgBossLike,
  type PgPoolClientLike,
  type PgPoolLike,
  type PrivateComparisonJob,
  parsePrivateComparisonEncryptionKey,
  validateEncryptedPrivateComparisonJob,
} from "./privateComparisonQueue.js";

export const WALLET_SECRET_JOB_MARKER = "[vennek-wallet-secret-redacted]";

export type TelegramAnswerJob = {
  updateId: number;
  telegramUserId: string;
  telegramChatId: string;
  text: string;
  walletSecretDetected?: true;
};

export type TelegramIngressJob = TelegramAnswerJob | PrivateComparisonJob;

export type { PgBossDatabase, PgBossLike, PgPoolClientLike, PgPoolLike } from "./privateComparisonQueue.js";

export type AgentQueue = {
  enqueue(job: TelegramIngressJob): Promise<boolean>;
};

export class PgBossAgentQueue implements AgentQueue {
  constructor(
    private readonly boss: PgBossLike,
    private readonly database: PgPoolLike,
    private readonly encryptionKey?: Uint8Array,
  ) {}

  async enqueue(job: TelegramIngressJob): Promise<boolean> {
    if ("kind" in job && job.kind === "private-compare") {
      if (!("metadata" in job)) {
        const queue = new PgBossPrivateComparisonQueue(this.boss, this.database, this.encryptionKey);
        return queue.enqueueEncrypted(validateEncryptedPrivateComparisonJob(job));
      }
      const queue = new PgBossPrivateComparisonQueue(this.boss, this.database, this.encryptionKey ?? parsePrivateComparisonEncryptionKey());
      return queue.enqueue(job);
    }

    if (!("text" in job)) throw new Error("Telegram job is invalid.");
    const safeJob = protectWalletSecret(job);
    return enqueuePgBossJob(this.boss, this.database, {
      updateId: safeJob.updateId,
      telegramUserId: safeJob.telegramUserId,
      telegramChatId: safeJob.telegramChatId,
      queueName: "telegram-answer",
      data: safeJob,
      singletonKey: String(safeJob.updateId),
      retryLimit: 3,
      retryBackoff: true,
    });
  }
}

export function protectWalletSecret(job: TelegramAnswerJob): TelegramAnswerJob {
  if (!findWalletSecret(job.text)) return job;
  return {
    ...job,
    text: WALLET_SECRET_JOB_MARKER,
    walletSecretDetected: true,
  };
}
