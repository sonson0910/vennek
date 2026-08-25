import { describe, expect, it } from "vitest";
import { randomInt } from "node:crypto";
import {
  ConversationRepository,
  createDatabase,
  ensureConversationPartitions,
} from "@vennek/cardano-agent";
import type { Pool } from "pg";

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("conversation repository", () => {
  it("stores encrypted messages and reads them in order", async () => {
    const db = createDatabase(databaseUrl!);
    const repository = new ConversationRepository(db, Buffer.alloc(32, 3));
    const telegramUserId = `f4-${process.pid}-${Date.now()}`;

    try {
      const first = await repository.append({
        telegramUserId,
        telegramChatId: "99",
        role: "user",
        text: "Cardano là gì?",
      });
      const second = await repository.append({
        telegramUserId,
        telegramChatId: "99",
        role: "assistant",
        text: "Cardano là một blockchain.",
      });

      expect(await repository.recent(telegramUserId, 10)).toEqual([
        { role: "user", text: "Cardano là gì?" },
        { role: "assistant", text: "Cardano là một blockchain." },
      ]);
      expect(first).toEqual({ firstInteraction: true });
      expect(second).toEqual({ firstInteraction: false });
    } finally {
      await db.end();
    }
  });

  it("deduplicates a repeated update and preserves its original first-interaction result", async () => {
    const db = createDatabase(databaseUrl!);
    const repository = new ConversationRepository(db, Buffer.alloc(32, 3));
    const telegramUserId = `dedupe-${process.pid}-${Date.now()}`;
    const telegramUpdateId = 8_200_000_000_000_000 + randomInt(0, 100_000);

    try {
      const first = await repository.append({
        telegramUserId,
        telegramChatId: "dedupe-chat",
        role: "user",
        text: "first",
        telegramUpdateId,
      });
      const duplicate = await repository.append({
        telegramUserId,
        telegramChatId: "dedupe-chat",
        role: "user",
        text: "duplicate",
        telegramUpdateId,
      });

      expect(first).toEqual({ firstInteraction: true });
      expect(duplicate).toEqual(first);
      const assistant = await repository.append({
        telegramUserId,
        telegramChatId: "dedupe-chat",
        role: "assistant",
        text: "answer",
        telegramUpdateId,
      });
      const assistantDuplicate = await repository.append({
        telegramUserId,
        telegramChatId: "dedupe-chat",
        role: "assistant",
        text: "duplicate answer",
        telegramUpdateId,
      });

      expect(assistant).toEqual({ firstInteraction: false });
      expect(assistantDuplicate).toEqual(assistant);
      expect(await repository.recent(telegramUserId, 10)).toEqual([
        { role: "user", text: "first" },
        { role: "assistant", text: "answer" },
      ]);
    } finally {
      await db.query("DELETE FROM conversation_message_idempotency WHERE telegram_update_id = $1", [telegramUpdateId]).catch(() => undefined);
      await db.query("DELETE FROM telegram_users WHERE telegram_user_id = $1", [telegramUserId]).catch(() => undefined);
      await db.end();
    }
  });

  it("recovers the exact encrypted assistant message for an update and rejects mismatched identity", async () => {
    const db = createDatabase(databaseUrl!);
    const repository = new ConversationRepository(db, Buffer.alloc(32, 3));
    const telegramUserId = `recover-${process.pid}-${Date.now()}`;
    const telegramChatId = "recover-chat";
    const telegramUpdateId = 8_250_000_000_000_000 + randomInt(0, 100_000);

    try {
      await repository.append({ telegramUserId, telegramChatId, role: "user", text: "question", telegramUpdateId });
      await repository.append({ telegramUserId, telegramChatId, role: "assistant", text: "Answer A", telegramUpdateId });

      await expect(repository.findForUpdate({ telegramUpdateId, telegramUserId, telegramChatId, role: "assistant" }))
        .resolves.toEqual({ role: "assistant", text: "Answer A" });
      await expect(repository.findForUpdate({ telegramUpdateId, telegramUserId: "other-user", telegramChatId, role: "assistant" }))
        .resolves.toBeUndefined();
      await expect(repository.findForUpdate({ telegramUpdateId, telegramUserId, telegramChatId: "other-chat", role: "assistant" }))
        .resolves.toBeUndefined();
      await db.query(
        "UPDATE conversation_message_idempotency SET message_id = NULL WHERE telegram_update_id = $1 AND role = 'assistant'",
        [telegramUpdateId],
      );
      await expect(repository.findForUpdate({ telegramUpdateId, telegramUserId, telegramChatId, role: "assistant" }))
        .resolves.toBeNull();
    } finally {
      await db.query("DELETE FROM conversation_message_idempotency WHERE telegram_update_id = $1", [telegramUpdateId]).catch(() => undefined);
      await db.query("DELETE FROM telegram_users WHERE telegram_user_id = $1", [telegramUserId]).catch(() => undefined);
      await db.end();
    }
  });

  it("inserts one message for concurrent duplicate update-role appends", async () => {
    const db = createDatabase(databaseUrl!);
    const repository = new ConversationRepository(db, Buffer.alloc(32, 3));
    const telegramUserId = `dedupe-concurrent-${process.pid}-${Date.now()}`;
    const telegramUpdateId = 8_300_000_000_000_000 + randomInt(0, 100_000);

    try {
      const results = await Promise.all([
        repository.append({ telegramUserId, telegramChatId: "dedupe-chat", role: "user", text: "one", telegramUpdateId }),
        repository.append({ telegramUserId, telegramChatId: "dedupe-chat", role: "user", text: "two", telegramUpdateId }),
      ]);
      const count = await db.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM conversation_messages WHERE telegram_user_id = $1",
        [telegramUserId],
      );

      expect(results).toEqual([{ firstInteraction: true }, { firstInteraction: true }]);
      expect(count.rows[0]?.count).toBe("1");
    } finally {
      await db.query("DELETE FROM conversation_message_idempotency WHERE telegram_update_id = $1", [telegramUpdateId]).catch(() => undefined);
      await db.query("DELETE FROM telegram_users WHERE telegram_user_id = $1", [telegramUserId]).catch(() => undefined);
      await db.end();
    }
  });

  it("rolls back the user row when the message insert fails", async () => {
    const db = createDatabase(databaseUrl!);
    const repository = new ConversationRepository(db, Buffer.alloc(32, 3));
    const telegramUserId = `rollback-${process.pid}-${Date.now()}`;

    try {
      await expect(
        repository.append({
          telegramUserId,
          telegramChatId: "99",
          role: "invalid" as "user",
          text: "this insert must fail",
        }),
      ).rejects.toThrow();

      const result = await db.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM telegram_users WHERE telegram_user_id = $1",
        [telegramUserId],
      );
      expect(result.rows[0]?.count).toBe("0");
    } finally {
      await db.end();
    }
  });

  it("rejects a wallet secret before touching the pool", async () => {
    let queryCalls = 0;
    let connectCalls = 0;
    const query = async () => {
      queryCalls += 1;
      throw new Error("pool must not be queried");
    };
    const connect = async () => {
      connectCalls += 1;
      throw new Error("pool must not be connected");
    };
    const db = { query, connect } as unknown as Pool;
    const repository = new ConversationRepository(db, Buffer.alloc(32, 3));
    const secret = "addr_xsk1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";

    try {
      await repository.append({
        telegramUserId: "secret-user",
        telegramChatId: "secret-chat",
        role: "user",
        text: `please do not store ${secret}`,
      });
      throw new Error("expected wallet secret rejection");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toBe("Conversation text contains a wallet secret.");
      expect(message).not.toContain(secret);
    }
    expect(queryCalls).toBe(0);
    expect(connectCalls).toBe(0);
  });

  it("rejects a recent-message limit outside the safe range", async () => {
    const db = createDatabase(databaseUrl!);
    const repository = new ConversationRepository(db, Buffer.alloc(32, 3));

    try {
      await expect(repository.recent("42", 0)).rejects.toThrow(
        "Conversation limit must be between 1 and 50.",
      );
      await expect(repository.recent("42", 51)).rejects.toThrow(
        "Conversation limit must be between 1 and 50.",
      );
    } finally {
      await db.end();
    }
  });

  it("creates the current and next two monthly partitions with UTC bounds", async () => {
    const hcmDatabaseUrl = new URL(databaseUrl!);
    hcmDatabaseUrl.searchParams.set("options", "-c timezone=Asia/Ho_Chi_Minh");
    const db = createDatabase(hcmDatabaseUrl.toString());
    let hcmClosed = false;

    try {
      await ensureConversationPartitions(db, new Date("2031-04-15T00:00:00.000Z"));
      await db.end();
      hcmClosed = true;

      const utcDb = createDatabase(databaseUrl!);
      try {
        await ensureConversationPartitions(utcDb, new Date("2031-04-15T00:00:00.000Z"));
        const partitions = await utcDb.query<{ name: string; bounds: string }>(
          `SELECT c.relname AS name, pg_get_expr(c.relpartbound, c.oid) AS bounds
           FROM pg_class c
           JOIN pg_inherits i ON i.inhrelid = c.oid
           JOIN pg_class p ON p.oid = i.inhparent
           WHERE p.relname = 'conversation_messages'
             AND c.relname IN ($1, $2, $3)
           ORDER BY c.relname`,
          [
            "conversation_messages_2031_04",
            "conversation_messages_2031_05",
            "conversation_messages_2031_06",
          ],
        );
        expect(partitions.rows).toHaveLength(3);
        expect(partitions.rows.every(({ bounds }) => bounds.includes("00:00:00+00"))).toBe(true);
      } finally {
        await utcDb.end();
      }
    } finally {
      if (!hcmClosed) await db.end();
    }
  });

  it("rejects copied envelopes between same-context messages and blocks identity clones", async () => {
    const db = createDatabase(databaseUrl!);
    const repository = new ConversationRepository(db, Buffer.alloc(32, 3));
    const telegramUserId = `aad-source-${process.pid}-${Date.now()}`;

    try {
      await repository.append({
        telegramUserId,
        telegramChatId: "source-chat",
        role: "user",
        text: "first message",
      });
      await repository.append({
        telegramUserId,
        telegramChatId: "source-chat",
        role: "user",
        text: "second message",
      });
      const source = await db.query<{
        id: string;
        created_at: Date;
        ciphertext: string;
        iv: string;
        auth_tag: string;
      }>(
        `SELECT id, created_at, ciphertext, iv, auth_tag FROM conversation_messages
         WHERE telegram_user_id = $1 ORDER BY id ASC`,
        [telegramUserId],
      );
      const copied = source.rows[0]!;
      const target = source.rows[1]!;
      await db.query(
        `UPDATE conversation_messages
         SET ciphertext = $1, iv = $2, auth_tag = $3
         WHERE id = $4 AND created_at = $5`,
        [copied.ciphertext, copied.iv, copied.auth_tag, target.id, target.created_at],
      );

      await expect(repository.recent(telegramUserId, 10)).rejects.toThrow(/authentication/);
      await expect(
        db.query(
          `INSERT INTO conversation_messages
           (id, created_at, telegram_user_id, telegram_chat_id, role, ciphertext, iv, auth_tag)
           OVERRIDING SYSTEM VALUE
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            copied.id,
            copied.created_at,
            telegramUserId,
            "source-chat",
            "user",
            copied.ciphertext,
            copied.iv,
            copied.auth_tag,
          ],
        ),
      ).rejects.toThrow(/duplicate key|already exists/i);
    } finally {
      await db.end();
    }
  });

  it("marks exactly one concurrent first append for a new user", async () => {
    const db = createDatabase(databaseUrl!);
    const repository = new ConversationRepository(db, Buffer.alloc(32, 3));
    const telegramUserId = `concurrent-first-${process.pid}-${Date.now()}`;

    try {
      const results = await Promise.all([
        repository.append({ telegramUserId, telegramChatId: "first-chat", role: "user", text: "first" }),
        repository.append({ telegramUserId, telegramChatId: "second-chat", role: "user", text: "second" }),
      ]);
      expect(results.filter(({ firstInteraction }) => firstInteraction)).toHaveLength(1);
      expect(results.filter(({ firstInteraction }) => !firstInteraction)).toHaveLength(1);
    } finally {
      await db.query("DELETE FROM telegram_users WHERE telegram_user_id = $1", [telegramUserId]).catch(() => undefined);
      await db.end();
    }
  });
});
