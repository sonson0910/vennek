import { describe, expect, it, vi } from "vitest";
import {
  createWebhookOptions,
  decryptPrivateComparisonJob,
  handleTelegramWebhook,
  PgBossAgentQueue,
  PRIVATE_COMPARISON_EXPIRE_SECONDS,
  PRIVATE_COMPARISON_MAX_LIFETIME_SECONDS,
  PRIVATE_COMPARISON_QUEUE,
  PRIVATE_COMPARISON_RETENTION_SECONDS,
  PRIVATE_COMPARISON_RETRY_BACKOFF,
  PRIVATE_COMPARISON_RETRY_DELAY_SECONDS,
  PRIVATE_COMPARISON_RETRY_LIMIT,
  parsePrivateComparisonEncryptionKey,
  validateEncryptedPrivateComparisonJob,
  type EncryptedPrivateComparisonJob,
  type PrivateComparisonMetadata,
} from "@vennek/telegram-bot";
import { decryptText, encryptText } from "@vennek/cardano-agent";
import { parseWebhookRuntimeConfig } from "../apps/telegram-bot/src/main.js";

const secret = "webhook-secret-with-at-least-32-chars";
const encryptionKey = Buffer.alloc(32, 7);

const documentUpdate = {
  update_id: 177,
  message: {
    from: { id: 42 },
    chat: { id: 42, type: "private" },
    caption: "Compare Cardano governance claims",
    document: {
      file_id: "AgACAgQAAx",
      file_unique_id: "AQADunique",
      file_name: "claims.md",
      mime_type: "text/markdown",
      file_size: 1234,
    },
  },
};

function request(body: unknown): Request {
  return new Request("https://bot.example/webhook", {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": secret,
    },
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

function fakeDatabase(claimRows: unknown[] = [{ update_id: "177" }]) {
  const queries: Array<{ text: string; values?: unknown[] }> = [];
  const client = {
    query: vi.fn(async (text: string, values?: unknown[]) => {
      queries.push({ text, values });
      if (text.startsWith("INSERT INTO telegram_updates")) return { rows: claimRows };
      if (text.startsWith("SELECT clock_timestamp")) return { rows: [{ now: new Date("2026-08-26T00:00:00.000Z") }] };
      if (text.startsWith("SELECT window_started_at")) return { rows: [] };
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  return { client, database: { connect: vi.fn(async () => client) }, queries };
}

describe("private comparison webhook intake", () => {
  it("parses webhook startup configuration with only database, secret, and encryption settings", () => {
    const config = parseWebhookRuntimeConfig({
      DATABASE_URL: "postgresql://vennek.test/vennek",
      TELEGRAM_WEBHOOK_SECRET: secret,
      VENNEK_ENCRYPTION_KEY: encryptionKey.toString("base64"),
    });
    expect(config).toEqual({
      databaseUrl: "postgresql://vennek.test/vennek",
      webhookSecret: secret,
      encryptionKey,
    });
    expect(() => parseWebhookRuntimeConfig({
      DATABASE_URL: "postgresql://vennek.test/vennek",
      TELEGRAM_WEBHOOK_SECRET: secret,
    })).toThrow(/VENNEK_ENCRYPTION_KEY/);
  });

  it("encrypts one private document update before the injected queue boundary", async () => {
    const enqueue = vi.fn().mockResolvedValue(true);
    const options = createWebhookOptions(secret, enqueue, encryptionKey);

    await expect(handleTelegramWebhook(request(documentUpdate), options)).resolves.toMatchObject({ status: 202 });

    const job = enqueue.mock.calls[0]?.[0] as EncryptedPrivateComparisonJob;
    expect(job).toMatchObject({
      kind: "private-compare",
      updateId: 177,
      telegramUserId: "42",
      telegramChatId: "42",
      encrypted: { ciphertext: expect.any(String), iv: expect.any(String), tag: expect.any(String) },
    });
    expect(JSON.stringify(job)).not.toContain("Compare Cardano governance claims");
    expect(JSON.stringify(job)).not.toContain("AgACAgQAAx");
    expect(JSON.stringify(job)).not.toContain("claims.md");
    expect(JSON.stringify(job)).not.toContain("text/markdown");

    expect(decryptPrivateComparisonJob(job, encryptionKey, { updateId: 177, telegramUserId: "42", telegramChatId: "42" })).toEqual({
      caption: "Compare Cardano governance claims",
      fileId: "AgACAgQAAx",
      fileUniqueId: "AQADunique",
      fileName: "claims.md",
      mime: "text/markdown",
      fileSize: 1234,
    });
  });

  it.each([
    ["group", { ...documentUpdate, message: { ...documentUpdate.message, chat: { id: -7, type: "group" }, from: { id: 42 } } }],
    ["missing caption", { ...documentUpdate, message: { ...documentUpdate.message, caption: undefined } }],
    ["competing photo", { ...documentUpdate, message: { ...documentUpdate.message, photo: [{ file_id: "photo" }] } }],
    ["oversize advisory", { ...documentUpdate, message: { ...documentUpdate.message, document: { ...documentUpdate.message.document, file_size: 20 * 1024 * 1024 + 1 } } }],
    ["unsafe filename", { ...documentUpdate, message: { ...documentUpdate.message, document: { ...documentUpdate.message.document, file_name: "../claims.md" } } }],
  ] as const)("rejects %s before queueing", async (_name, body) => {
    const enqueue = vi.fn();
    const response = await handleTelegramWebhook(request(body), createWebhookOptions(secret, enqueue, encryptionKey));
    expect(response.status).toBe(400);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("rejects a wallet secret in the caption", async () => {
    const mnemonic = `${Array.from({ length: 11 }, () => "abandon").join(" ")} about`;
    const enqueue = vi.fn();
    const response = await handleTelegramWebhook(
      request({ ...documentUpdate, message: { ...documentUpdate.message, caption: mnemonic } }),
      createWebhookOptions(secret, enqueue, encryptionKey),
    );
    expect(response.status).toBe(400);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("preserves text-compatible multiline and control captions", async () => {
    const caption = "Compare\tCardano claims\nwith\u0000bounded evidence";
    const enqueue = vi.fn().mockResolvedValue(true);
    const response = await handleTelegramWebhook(
      request({ ...documentUpdate, message: { ...documentUpdate.message, caption } }),
      createWebhookOptions(secret, enqueue, encryptionKey),
    );
    expect(response.status).toBe(202);

    const job = enqueue.mock.calls[0]?.[0] as EncryptedPrivateComparisonJob;
    expect(decryptPrivateComparisonJob(job, encryptionKey, {
      updateId: 177,
      telegramUserId: "42",
      telegramChatId: "42",
    }).caption).toBe(caption);
  });
});

describe("private comparison queue", () => {
  it("proves every retry and retention window stays below one hour", () => {
    expect(PRIVATE_COMPARISON_RETRY_LIMIT).toBe(3);
    expect(PRIVATE_COMPARISON_RETRY_DELAY_SECONDS).toBe(1);
    expect(PRIVATE_COMPARISON_RETRY_BACKOFF).toBe(true);
    expect(PRIVATE_COMPARISON_EXPIRE_SECONDS).toBe(300);
    expect(PRIVATE_COMPARISON_RETENTION_SECONDS).toBe(300);
    expect(PRIVATE_COMPARISON_MAX_LIFETIME_SECONDS).toBe(1_514);
    expect(PRIVATE_COMPARISON_MAX_LIFETIME_SECONDS).toBeLessThan(3_600);
  });

  it("parses only the canonical 32-byte webhook encryption key", () => {
    const encoded = encryptionKey.toString("base64");
    expect(parsePrivateComparisonEncryptionKey({ VENNEK_ENCRYPTION_KEY: encoded })).toEqual(encryptionKey);
    expect(() => parsePrivateComparisonEncryptionKey({ VENNEK_ENCRYPTION_KEY: "short" })).toThrow();
    expect(() => parsePrivateComparisonEncryptionKey({ VENNEK_ENCRYPTION_KEY: `${encoded} ` })).not.toThrow();
    expect(() => parsePrivateComparisonEncryptionKey({ VENNEK_ENCRYPTION_KEY: Buffer.alloc(31).toString("base64") })).toThrow();
  });

  it("admits an encrypted payload on the dedicated queue with bounded retention", async () => {
    const { database, client } = fakeDatabase();
    const send = vi.fn().mockResolvedValue("job-id");
    const queue = new PgBossAgentQueue({ send }, database, encryptionKey);
    const metadata: PrivateComparisonMetadata = {
      caption: "Compare Cardano governance claims",
      fileId: "AgACAgQAAx",
      fileUniqueId: "AQADunique",
      fileName: "claims.md",
      mime: "text/markdown",
      fileSize: 1234,
    };

    await expect(queue.enqueue({ kind: "private-compare", updateId: 177, telegramUserId: "42", telegramChatId: "42", metadata })).resolves.toBe(true);

    expect(send).toHaveBeenCalledWith(
      PRIVATE_COMPARISON_QUEUE,
      expect.objectContaining({ kind: "private-compare", updateId: 177, telegramUserId: "42", telegramChatId: "42", encrypted: expect.any(Object) }),
      expect.objectContaining({
        singletonKey: "private:177",
        retryLimit: PRIVATE_COMPARISON_RETRY_LIMIT,
        retryDelay: PRIVATE_COMPARISON_RETRY_DELAY_SECONDS,
        retryBackoff: PRIVATE_COMPARISON_RETRY_BACKOFF,
        expireInSeconds: PRIVATE_COMPARISON_EXPIRE_SECONDS,
        retentionSeconds: PRIVATE_COMPARISON_RETENTION_SECONDS,
        deleteAfterSeconds: 1,
      }),
    );
    const sent = send.mock.calls[0]?.[1];
    expect(JSON.stringify(sent)).not.toContain(metadata.caption);
    expect(JSON.stringify(sent)).not.toContain(metadata.fileId);
    expect(JSON.stringify(sent)).not.toContain(metadata.fileName);
    expect(JSON.stringify(sent)).not.toContain(metadata.mime);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("encrypts and decrypts the worst-case escaped caption within the bounded envelope", async () => {
    const caption = `${String.fromCharCode(92)}${String.fromCharCode(34)}`.repeat(8_192);
    const metadata: PrivateComparisonMetadata = { caption, fileId: "file", fileUniqueId: "unique" };
    const send = vi.fn().mockResolvedValue("job-id");
    const { database } = fakeDatabase();
    const queue = new PgBossAgentQueue({ send }, database, encryptionKey);

    await expect(queue.enqueue({
      kind: "private-compare",
      updateId: 177,
      telegramUserId: "42",
      telegramChatId: "42",
      metadata,
    })).resolves.toBe(true);

    const sent = send.mock.calls[0]?.[1] as EncryptedPrivateComparisonJob;
    expect(decryptPrivateComparisonJob(sent, encryptionKey, {
      updateId: 177,
      telegramUserId: "42",
      telegramChatId: "42",
    }).caption).toBe(caption);
  });

  it("binds decryption to the exact owner and rejects tampering or extra keys", () => {
    const metadata = { caption: "Compare", fileId: "file", fileUniqueId: "unique" } as PrivateComparisonMetadata;
    const owner = { updateId: 177, telegramUserId: "42", telegramChatId: "42" };
    const aad = "telegram-private-compare:177:42:42";
    const encrypted = encryptText(JSON.stringify(metadata), encryptionKey, aad);
    const job = { kind: "private-compare", ...owner, encrypted } as EncryptedPrivateComparisonJob;

    expect(decryptPrivateComparisonJob(job, encryptionKey, owner)).toEqual(metadata);
    expect(() => decryptPrivateComparisonJob(job, encryptionKey, { ...owner, extra: true } as unknown as typeof owner)).toThrow();
    expect(() => decryptPrivateComparisonJob({ ...job, telegramChatId: "43" }, encryptionKey, owner)).toThrow();
    expect(() => decryptPrivateComparisonJob({ ...job, encrypted: { ...encrypted, tag: `${encrypted.tag.slice(0, -2)}AA` } }, encryptionKey, owner)).toThrow();
    expect(() => decryptPrivateComparisonJob({ ...job, extra: true }, encryptionKey, owner)).toThrow();
    expect(() => decryptPrivateComparisonJob({ ...job, encrypted: { ...encrypted, extra: true } }, encryptionKey, owner)).toThrow();
    expect(decryptText(encrypted, encryptionKey, aad)).toContain("Compare");
  });

  it("rejects noncanonical or oversized encrypted envelope fields before admission", () => {
    const owner = { updateId: 177, telegramUserId: "42", telegramChatId: "42" };
    const encrypted = encryptText(JSON.stringify({ caption: "Compare", fileId: "file", fileUniqueId: "unique" }), encryptionKey, "telegram-private-compare:177:42:42");
    expect(() => validateEncryptedPrivateComparisonJob({ kind: "private-compare", ...owner, encrypted: { ...encrypted, iv: Buffer.alloc(13).toString("base64") } })).toThrow();
    expect(() => validateEncryptedPrivateComparisonJob({ kind: "private-compare", ...owner, encrypted: { ...encrypted, ciphertext: Buffer.alloc(129 * 1024).toString("base64") } })).toThrow();
    expect(() => validateEncryptedPrivateComparisonJob({ kind: "private-compare", ...owner, telegramUserId: "9223372036854775808", encrypted })).toThrow();
    expect(() => validateEncryptedPrivateComparisonJob({ kind: "private-compare", ...owner, telegramUserId: "9007199254740992", encrypted })).toThrow();
    expect(() => validateEncryptedPrivateComparisonJob({ kind: "private-compare", ...owner, telegramChatId: "43", encrypted })).toThrow();
  });

  it("fails closed for private intake when webhook composition has no encryption key", async () => {
    const enqueue = vi.fn();
    const response = await handleTelegramWebhook(request(documentUpdate), createWebhookOptions(secret, enqueue));
    expect(response.status).toBe(500);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("rejects document albums", async () => {
    const enqueue = vi.fn();
    const response = await handleTelegramWebhook(
      request({ ...documentUpdate, message: { ...documentUpdate.message, media_group_id: "album-1" } }),
      createWebhookOptions(secret, enqueue, encryptionKey),
    );
    expect(response.status).toBe(400);
    expect(enqueue).not.toHaveBeenCalled();
  });
});
