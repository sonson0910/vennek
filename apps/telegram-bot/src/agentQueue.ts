import { findWalletSecret } from "@vennek/cardano-agent";

export const WALLET_SECRET_JOB_MARKER = "[vennek-wallet-secret-redacted]";

export type TelegramAnswerJob = {
  updateId: number;
  telegramUserId: string;
  telegramChatId: string;
  text: string;
  walletSecretDetected?: true;
};

type PgBossSendOptions = {
  singletonKey: string;
  retryLimit: number;
  retryBackoff: boolean;
  db?: PgBossDatabase;
};

export type PgBossDatabase = {
  executeSql(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
};

export type PgBossLike = {
  send(name: string, data: TelegramAnswerJob, options: PgBossSendOptions): Promise<string | null>;
};

export type PgPoolClientLike = {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
  release(): void;
};

export type PgPoolLike = {
  connect(): Promise<PgPoolClientLike>;
};

export type AgentQueue = {
  enqueue(job: TelegramAnswerJob): Promise<boolean>;
};

export class PgBossAgentQueue implements AgentQueue {
  constructor(
    private readonly boss: PgBossLike,
    private readonly database: PgPoolLike,
  ) {}

  async enqueue(job: TelegramAnswerJob): Promise<boolean> {
    const safeJob = protectWalletSecret(job);
    const client = await this.database.connect();
    let inTransaction = false;
    try {
      await client.query("BEGIN");
      inTransaction = true;
      const claim = await client.query(
        `INSERT INTO telegram_updates (update_id, status)
         VALUES ($1, 'received')
         ON CONFLICT (update_id) DO NOTHING
         RETURNING update_id`,
        [safeJob.updateId],
      );
      if (claim.rows.length === 0) {
        await client.query("ROLLBACK");
        inTransaction = false;
        return false;
      }

      const id = await this.boss.send("telegram-answer", safeJob, {
        singletonKey: String(safeJob.updateId),
        retryLimit: 3,
        retryBackoff: true,
        db: {
          executeSql: (text, values) => client.query(text, values),
        },
      });
      if (id === null) {
        await client.query("ROLLBACK");
        inTransaction = false;
        throw new Error("Queue insertion failed.");
      }
      await client.query("COMMIT");
      inTransaction = false;
      return true;
    } catch (error) {
      if (inTransaction) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Preserve the original queue/database failure.
        }
      }
      throw error;
    } finally {
      client.release();
    }
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
