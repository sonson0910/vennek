import {
  decryptText,
  encryptText,
  findWalletSecret,
  type EncryptedText,
} from "@vennek/cardano-agent";

export const PRIVATE_COMPARISON_QUEUE = "telegram-private-compare";
export const PRIVATE_COMPARISON_AAD_PREFIX = "telegram-private-compare";
export const PRIVATE_COMPARISON_MAX_FILE_BYTES = 20 * 1024 * 1024;
/** PgBoss policy: four 5-minute attempts plus 1+2+4s backoff and 5-minute retention. */
export const PRIVATE_COMPARISON_EXPIRE_SECONDS = 300;
export const PRIVATE_COMPARISON_RETENTION_SECONDS = 300;
export const PRIVATE_COMPARISON_RETRY_LIMIT = 3;
export const PRIVATE_COMPARISON_RETRY_DELAY_SECONDS = 1;
export const PRIVATE_COMPARISON_RETRY_BACKOFF = true;
/** Conservative maximum: pg-boss v12 failJobsBody jitter can reach 2+4+8s across the three retries. */
export const PRIVATE_COMPARISON_MAX_LIFETIME_SECONDS =
  PRIVATE_COMPARISON_RETENTION_SECONDS +
  (PRIVATE_COMPARISON_RETRY_LIMIT + 1) * PRIVATE_COMPARISON_EXPIRE_SECONDS +
  PRIVATE_COMPARISON_RETRY_DELAY_SECONDS * ((2 ** (PRIVATE_COMPARISON_RETRY_LIMIT + 1)) - 2);

const MAX_CAPTION_BYTES = 16_384;
const MAX_CAPTION_CODE_POINTS = 16_384;
const MAX_FILE_ID_BYTES = 512;
const MAX_FILE_UNIQUE_ID_BYTES = 256;
const MAX_FILE_NAME_BYTES = 512;
const MAX_MIME_BYTES = 128;
/** 128 KiB covers JSON escaping for the accepted 16 KiB caption plus metadata and envelope overhead. */
export const PRIVATE_COMPARISON_MAX_CIPHERTEXT_BYTES = 128 * 1024;
const MAX_TELEGRAM_SAFE_ID = BigInt(Number.MAX_SAFE_INTEGER);
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const PRIVATE_COMPARISON_ENVELOPE_KEYS = ["ciphertext", "iv", "tag"] as const;
const PRIVATE_COMPARISON_JOB_KEYS = ["kind", "updateId", "telegramUserId", "telegramChatId", "encrypted"] as const;
const PRIVATE_COMPARISON_INPUT_KEYS = ["kind", "updateId", "telegramUserId", "telegramChatId", "metadata"] as const;
const PRIVATE_COMPARISON_METADATA_KEYS = ["caption", "fileId", "fileUniqueId", "fileName", "mime", "fileSize"] as const;

export type PrivateComparisonOwner = Readonly<{
  updateId: number;
  telegramUserId: string;
  telegramChatId: string;
}>;

export type PrivateComparisonMetadata = Readonly<{
  caption: string;
  fileId: string;
  fileUniqueId: string;
  fileName?: string;
  mime?: string;
  fileSize?: number;
}>;

export type PrivateComparisonIngressJob = PrivateComparisonOwner & Readonly<{
  kind: "private-compare";
  metadata: PrivateComparisonMetadata;
}>;

export type EncryptedPrivateComparisonJob = PrivateComparisonOwner & Readonly<{
  kind: "private-compare";
  encrypted: EncryptedText;
}>;

export type PrivateComparisonJob = PrivateComparisonIngressJob | EncryptedPrivateComparisonJob;

export type PgBossDatabase = {
  executeSql(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
};

export type PgBossSendOptions = {
  singletonKey: string;
  retryLimit: number;
  retryDelay?: number;
  retryBackoff: boolean;
  expireInSeconds?: number;
  retentionSeconds?: number;
  deleteAfterSeconds?: number;
  db?: PgBossDatabase;
};

export type PgBossLike = {
  send(name: string, data: object, options: PgBossSendOptions): Promise<string | null>;
};

export type PgPoolClientLike = {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
  release(): void;
};

export type PgPoolLike = {
  connect(): Promise<PgPoolClientLike>;
};

export type PgBossAdmissionInput = Readonly<{
  updateId: number;
  telegramUserId: string;
  telegramChatId: string;
  queueName: string;
  data: object;
  singletonKey: string;
  retryLimit: number;
  retryDelay?: number;
  retryBackoff: boolean;
  expireInSeconds?: number;
  retentionSeconds?: number;
  deleteAfterSeconds?: number;
}>;

export function parsePrivateComparisonEncryptionKey(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): Buffer {
  const encoded = env.VENNEK_ENCRYPTION_KEY?.trim();
  if (!encoded || !CANONICAL_BASE64.test(encoded) || encoded.length % 4 !== 0) {
    throw new Error("VENNEK_ENCRYPTION_KEY must be valid base64");
  }
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32 || key.toString("base64") !== encoded) {
    throw new Error("VENNEK_ENCRYPTION_KEY must decode to exactly 32 bytes");
  }
  return key;
}

/**
 * Claims an update, applies the existing per-user/per-chat limiter, and sends
 * one PgBoss job on the same database transaction.
 */
export async function enqueuePgBossJob(
  boss: PgBossLike,
  database: PgPoolLike,
  input: PgBossAdmissionInput,
): Promise<boolean> {
  const client = await database.connect();
  let inTransaction = false;
  try {
    await client.query("BEGIN");
    inTransaction = true;
    const claim = await client.query(
      `INSERT INTO telegram_updates (update_id, status)
       VALUES ($1, 'received')
       ON CONFLICT (update_id) DO NOTHING
       RETURNING update_id`,
      [input.updateId],
    );
    if (claim.rows.length === 0) {
      await client.query("ROLLBACK");
      inTransaction = false;
      return false;
    }

    if (!(await admitUpdate(client, input.telegramUserId, input.telegramChatId))) {
      await client.query(
        "UPDATE telegram_updates SET status = 'failed', processed_at = now() WHERE update_id = $1",
        [input.updateId],
      );
      await client.query("COMMIT");
      inTransaction = false;
      return false;
    }

    const id = await boss.send(input.queueName, input.data, {
      singletonKey: input.singletonKey,
      retryLimit: input.retryLimit,
      ...(input.retryDelay === undefined ? {} : { retryDelay: input.retryDelay }),
      retryBackoff: input.retryBackoff,
      ...(input.expireInSeconds === undefined ? {} : { expireInSeconds: input.expireInSeconds }),
      ...(input.retentionSeconds === undefined ? {} : { retentionSeconds: input.retentionSeconds }),
      ...(input.deleteAfterSeconds === undefined ? {} : { deleteAfterSeconds: input.deleteAfterSeconds }),
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

export function privateComparisonAad(owner: PrivateComparisonOwner): string {
  const snapshot = snapshotOwner(owner, true);
  return `${PRIVATE_COMPARISON_AAD_PREFIX}:${snapshot.updateId}:${snapshot.telegramUserId}:${snapshot.telegramChatId}`;
}

export function validatePrivateComparisonMetadata(value: unknown): PrivateComparisonMetadata {
  const record = optionalDataRecord(value, PRIVATE_COMPARISON_METADATA_KEYS, ["caption", "fileId", "fileUniqueId"] as const);
  if (!record) throw new Error("Private comparison metadata is invalid.");

  const caption = record.caption;
  const fileId = record.fileId;
  const fileUniqueId = record.fileUniqueId;
  const fileName = record.fileName;
  const mime = record.mime;
  const fileSize = record.fileSize;
  if (typeof caption !== "string" || !boundedText(caption, MAX_CAPTION_CODE_POINTS, MAX_CAPTION_BYTES, false) || caption.trim().length === 0) throw new Error("Private comparison metadata is invalid.");
  if (typeof fileId !== "string" || fileId.length === 0 || fileId.trim() !== fileId || !boundedText(fileId, MAX_FILE_ID_BYTES, MAX_FILE_ID_BYTES)) throw new Error("Private comparison metadata is invalid.");
  if (typeof fileUniqueId !== "string" || fileUniqueId.length === 0 || fileUniqueId.trim() !== fileUniqueId || !boundedText(fileUniqueId, MAX_FILE_UNIQUE_ID_BYTES, MAX_FILE_UNIQUE_ID_BYTES)) throw new Error("Private comparison metadata is invalid.");
  let safeFileName: string | undefined;
  let safeMime: string | undefined;
  let safeFileSize: number | undefined;
  if (Object.hasOwn(record, "fileName")) {
    if (typeof fileName !== "string" || !boundedFileName(fileName)) throw new Error("Private comparison metadata is invalid.");
    safeFileName = fileName;
  }
  if (Object.hasOwn(record, "mime")) {
    if (typeof mime !== "string" || !boundedMime(mime)) throw new Error("Private comparison metadata is invalid.");
    safeMime = mime;
  }
  if (Object.hasOwn(record, "fileSize")) {
    if (typeof fileSize !== "number" || !Number.isSafeInteger(fileSize) || fileSize < 1 || fileSize > PRIVATE_COMPARISON_MAX_FILE_BYTES) throw new Error("Private comparison metadata is invalid.");
    safeFileSize = fileSize;
  }

  for (const text of [caption, fileId, fileUniqueId, safeFileName, safeMime]) {
    if (text !== undefined && hasWalletSecret(text)) throw new Error("Wallet secret is not accepted.");
  }

  const canonical: {
    caption: string;
    fileId: string;
    fileUniqueId: string;
    fileName?: string;
    mime?: string;
    fileSize?: number;
  } = { caption, fileId, fileUniqueId };
  if (safeFileName !== undefined) canonical.fileName = safeFileName;
  if (safeMime !== undefined) canonical.mime = safeMime;
  if (safeFileSize !== undefined) canonical.fileSize = safeFileSize;
  return Object.freeze(canonical);
}

export function encryptPrivateComparisonJob(
  input: unknown,
  encryptionKey: Uint8Array,
): EncryptedPrivateComparisonJob {
  const record = exactDataRecord(input, PRIVATE_COMPARISON_INPUT_KEYS);
  if (!record || record.kind !== "private-compare") throw new Error("Private comparison job is invalid.");
  const owner = snapshotOwner(record);
  const metadata = validatePrivateComparisonMetadata(record.metadata);
  const encrypted = encryptText(JSON.stringify(metadata), encryptionKey, privateComparisonAad(owner));
  return Object.freeze({ ...owner, kind: "private-compare" as const, encrypted: snapshotEncryptedText(encrypted) });
}

export function decryptPrivateComparisonJob(
  value: unknown,
  encryptionKey: Uint8Array,
  expectedOwner: PrivateComparisonOwner,
): PrivateComparisonMetadata {
  const record = exactDataRecord(value, PRIVATE_COMPARISON_JOB_KEYS);
  if (!record || record.kind !== "private-compare") throw new Error("Private comparison job is invalid.");
  const owner = snapshotOwner(record);
  const expected = snapshotOwner(expectedOwner, true);
  if (
    owner.updateId !== expected.updateId ||
    owner.telegramUserId !== expected.telegramUserId ||
    owner.telegramChatId !== expected.telegramChatId
  ) {
    throw new Error("Private comparison owner mismatch.");
  }
  const encrypted = snapshotEncryptedText(record.encrypted);
  let plaintext: string;
  try {
    plaintext = decryptText(encrypted, encryptionKey, privateComparisonAad(expected));
  } catch {
    throw new Error("Private comparison payload authentication failed.");
  }
  let metadata: unknown;
  try {
    metadata = JSON.parse(plaintext) as unknown;
  } catch {
    throw new Error("Private comparison metadata is invalid.");
  }
  return validatePrivateComparisonMetadata(metadata);
}

export function validateEncryptedPrivateComparisonJob(value: unknown): EncryptedPrivateComparisonJob {
  const record = exactDataRecord(value, PRIVATE_COMPARISON_JOB_KEYS);
  if (!record || record.kind !== "private-compare") throw new Error("Private comparison job is invalid.");
  const owner = snapshotOwner(record);
  const encrypted = snapshotEncryptedText(record.encrypted);
  return Object.freeze({ ...owner, kind: "private-compare" as const, encrypted });
}

export class PgBossPrivateComparisonQueue {
  constructor(
    private readonly boss: PgBossLike,
    private readonly database: PgPoolLike,
    private readonly encryptionKey?: Uint8Array,
  ) {}

  async enqueue(job: PrivateComparisonIngressJob): Promise<boolean> {
    if (!this.encryptionKey) throw new Error("Private comparison encryption key is unavailable.");
    const encrypted = encryptPrivateComparisonJob(job, this.encryptionKey);
    return this.enqueueEncrypted(encrypted);
  }

  async enqueueEncrypted(job: EncryptedPrivateComparisonJob): Promise<boolean> {
    const encrypted = validateEncryptedPrivateComparisonJob(job);
    return enqueuePgBossJob(this.boss, this.database, {
      updateId: encrypted.updateId,
      telegramUserId: encrypted.telegramUserId,
      telegramChatId: encrypted.telegramChatId,
      queueName: PRIVATE_COMPARISON_QUEUE,
      data: encrypted,
      singletonKey: `private:${encrypted.updateId}`,
      retryLimit: PRIVATE_COMPARISON_RETRY_LIMIT,
      retryDelay: PRIVATE_COMPARISON_RETRY_DELAY_SECONDS,
      retryBackoff: PRIVATE_COMPARISON_RETRY_BACKOFF,
      expireInSeconds: PRIVATE_COMPARISON_EXPIRE_SECONDS,
      retentionSeconds: PRIVATE_COMPARISON_RETENTION_SECONDS,
      deleteAfterSeconds: 1,
    });
  }
}

function snapshotOwner(value: unknown, exact = false): PrivateComparisonOwner {
  const ownerKeys = ["updateId", "telegramUserId", "telegramChatId"] as const;
  const record = exact ? exactDataRecord(value, ownerKeys) : dataFieldsRecord(value, ownerKeys);
  if (!record) throw new Error("Private comparison owner is invalid.");
  const owner = {
    updateId: record.updateId,
    telegramUserId: record.telegramUserId,
    telegramChatId: record.telegramChatId,
  } as PrivateComparisonOwner;
  validateOwner(owner);
  return Object.freeze(owner);
}

function validateOwner(owner: PrivateComparisonOwner): void {
  if (
    typeof owner.updateId !== "number" || !Number.isSafeInteger(owner.updateId) || owner.updateId < 1 ||
    !canonicalPositiveTelegramId(owner.telegramUserId) ||
    !canonicalPositiveTelegramId(owner.telegramChatId) ||
    owner.telegramUserId !== owner.telegramChatId
  ) {
    throw new Error("Private comparison owner is invalid.");
  }
}

function snapshotEncryptedText(value: unknown): EncryptedText {
  const record = exactDataRecord(value, PRIVATE_COMPARISON_ENVELOPE_KEYS);
  if (!record || typeof record.ciphertext !== "string" || typeof record.iv !== "string" || typeof record.tag !== "string") {
    throw new Error("Private comparison envelope is invalid.");
  }
  const ciphertext = decodeCanonicalBase64(record.ciphertext, PRIVATE_COMPARISON_MAX_CIPHERTEXT_BYTES, false);
  const iv = decodeCanonicalBase64(record.iv, 12, true);
  const tag = decodeCanonicalBase64(record.tag, 16, true);
  if (ciphertext.length < 1) throw new Error("Private comparison envelope is invalid.");
  return Object.freeze({ ciphertext: ciphertext.toString("base64"), iv: iv.toString("base64"), tag: tag.toString("base64") });
}

function decodeCanonicalBase64(value: string, maximumBytes: number, exactLength: boolean): Buffer {
  if (!CANONICAL_BASE64.test(value)) throw new Error("Private comparison envelope is invalid.");
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value || decoded.length > maximumBytes || (exactLength && decoded.length !== maximumBytes)) {
    throw new Error("Private comparison envelope is invalid.");
  }
  return decoded;
}

function canonicalPositiveTelegramId(value: unknown): value is string {
  if (typeof value !== "string" || !/^[1-9]\d*$/u.test(value)) return false;
  try {
    return BigInt(value) <= MAX_TELEGRAM_SAFE_ID;
  } catch {
    return false;
  }
}

function exactDataRecord<const Keys extends readonly string[]>(value: unknown, keys: Keys): Record<Keys[number], unknown> | undefined {
  if (!isPlainObject(value)) return undefined;
  let ownKeys: PropertyKey[];
  try {
    ownKeys = Reflect.ownKeys(value);
  } catch {
    return undefined;
  }
  if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))) return undefined;
  const result = {} as Record<Keys[number], unknown>;
  try {
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return undefined;
      (result as Record<string, unknown>)[key] = descriptor.value;
    }
  } catch {
    return undefined;
  }
  return result;
}

function dataFieldsRecord<const Keys extends readonly string[]>(value: unknown, keys: Keys): Record<Keys[number], unknown> | undefined {
  if (!isPlainObject(value)) return undefined;
  const result = {} as Record<Keys[number], unknown>;
  try {
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return undefined;
      (result as Record<string, unknown>)[key] = descriptor.value;
    }
  } catch {
    return undefined;
  }
  return result;
}

function optionalDataRecord<const Allowed extends readonly string[], const Required extends readonly string[]>(
  value: unknown,
  allowed: Allowed,
  required: Required,
): Record<Allowed[number], unknown> | undefined {
  if (!isPlainObject(value)) return undefined;
  let ownKeys: PropertyKey[];
  try {
    ownKeys = Reflect.ownKeys(value);
  } catch {
    return undefined;
  }
  if (ownKeys.some((key) => typeof key !== "string" || !allowed.includes(key)) || required.some((key) => !ownKeys.includes(key))) return undefined;
  const result = {} as Record<Allowed[number], unknown>;
  try {
    for (const key of ownKeys) {
      if (typeof key !== "string") return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return undefined;
      (result as Record<string, unknown>)[key] = descriptor.value;
    }
  } catch {
    return undefined;
  }
  return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  try {
    return typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;
  } catch {
    return false;
  }
}

function boundedText(value: string, maxCodePoints: number, maxBytes: number, rejectControls = true): boolean {
  let codePoints = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
    codePoints += 1;
    if (codePoints > maxCodePoints) return false;
  }
  return Buffer.byteLength(value, "utf8") <= maxBytes && (!rejectControls || !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value));
}

function boundedFileName(value: string): boolean {
  return boundedText(value, MAX_FILE_NAME_BYTES, MAX_FILE_NAME_BYTES) &&
    value.trim().length > 0 && !value.includes("/") && !value.includes("\\") && value !== "." && value !== "..";
}

function boundedMime(value: string): boolean {
  return boundedText(value, MAX_MIME_BYTES, MAX_MIME_BYTES) && value.trim().length > 0 && value.trim() === value;
}

function hasWalletSecret(value: string): boolean {
  return findWalletSecret(value) !== undefined;
}

type AdmissionState = {
  windowStartedAt: Date;
  acceptedCount: number;
};

const ADMISSION_LIMIT = 10;
const ADMISSION_WINDOW_MS = 60_000;

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

async function lockAdmissionState(client: PgPoolClientLike, subjectType: "user" | "chat", subjectId: string, now: Date): Promise<AdmissionState> {
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
