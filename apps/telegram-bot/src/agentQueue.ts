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

      if (!(await admitUpdate(client, safeJob.telegramUserId, safeJob.telegramChatId))) {
        await client.query(
          "UPDATE telegram_updates SET status = 'failed', processed_at = now() WHERE update_id = $1",
          [safeJob.updateId],
        );
        await client.query("COMMIT");
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

const ADMISSION_LIMIT = 10;
const ADMISSION_WINDOW_MS = 60_000;

type AdmissionState = {
  windowStartedAt: Date;
  acceptedCount: number;
};

async function admitUpdate(client: PgPoolClientLike, telegramUserId: string, telegramChatId: string): Promise<boolean> {
  const clock = await client.query("SELECT clock_timestamp() AS now");
  const now = asDate(clock.rows[0] && typeof clock.rows[0] === "object" ? (clock.rows[0] as Record<string, unknown>).now : undefined);
  if (!now) throw new Error("Database clock unavailable.");

  const user = await lockAdmissionState(client, "user", telegramUserId, now);
  const chat = await lockAdmissionState(client, "chat", telegramChatId, now);
  if (!withinAdmissionLimit(user, now) || !withinAdmissionLimit(chat, now)) return false;

  await saveAdmissionState(client, "user", telegramUserId, nextAdmissionState(user, now));
  await saveAdmissionState(client, "chat", telegramChatId, nextAdmissionState(chat, now));
  return true;
}

async function lockAdmissionState(
  client: PgPoolClientLike,
  subjectType: "user" | "chat",
  subjectId: string,
  now: Date,
): Promise<AdmissionState> {
  await client.query(
    `INSERT INTO telegram_admission_windows (subject_type, subject_id, window_started_at, accepted_count)
     VALUES ($1, $2, $3, 0)
     ON CONFLICT (subject_type, subject_id) DO NOTHING`,
    [subjectType, subjectId, now],
  );
  const result = await client.query(
    `SELECT window_started_at, accepted_count
     FROM telegram_admission_windows
     WHERE subject_type = $1 AND subject_id = $2
     FOR UPDATE`,
    [subjectType, subjectId],
  );
  const row = result.rows[0];
  if (!row || typeof row !== "object") return { windowStartedAt: now, acceptedCount: 0 };
  const record = row as Record<string, unknown>;
  const windowStartedAt = asDate(record.window_started_at);
  const acceptedCount = record.accepted_count;
  if (!windowStartedAt || typeof acceptedCount !== "number" || !Number.isSafeInteger(acceptedCount) || acceptedCount < 0 || acceptedCount > ADMISSION_LIMIT) {
    throw new Error("Admission state is invalid.");
  }
  return { windowStartedAt, acceptedCount };
}

function withinAdmissionLimit(state: AdmissionState, now: Date): boolean {
  return now.getTime() - state.windowStartedAt.getTime() >= ADMISSION_WINDOW_MS || state.acceptedCount < ADMISSION_LIMIT;
}

function nextAdmissionState(state: AdmissionState, now: Date): AdmissionState {
  return now.getTime() - state.windowStartedAt.getTime() >= ADMISSION_WINDOW_MS
    ? { windowStartedAt: now, acceptedCount: 1 }
    : { windowStartedAt: state.windowStartedAt, acceptedCount: state.acceptedCount + 1 };
}

async function saveAdmissionState(client: PgPoolClientLike, subjectType: "user" | "chat", subjectId: string, state: AdmissionState): Promise<void> {
  await client.query(
    `UPDATE telegram_admission_windows
     SET window_started_at = $3, accepted_count = $4
     WHERE subject_type = $1 AND subject_id = $2`,
    [subjectType, subjectId, state.windowStartedAt, state.acceptedCount],
  );
}

function asDate(value: unknown): Date | undefined {
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : undefined;
  return date && Number.isFinite(date.getTime()) ? date : undefined;
}

export function protectWalletSecret(job: TelegramAnswerJob): TelegramAnswerJob {
  if (!findWalletSecret(job.text)) return job;
  return {
    ...job,
    text: WALLET_SECRET_JOB_MARKER,
    walletSecretDetected: true,
  };
}
