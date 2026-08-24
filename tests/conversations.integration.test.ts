import { describe, expect, it } from "vitest";
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
      await repository.append({
        telegramUserId,
        telegramChatId: "99",
        role: "user",
        text: "Cardano là gì?",
      });
      await repository.append({
        telegramUserId,
        telegramChatId: "99",
        role: "assistant",
        text: "Cardano là một blockchain.",
      });

      expect(await repository.recent(telegramUserId, 10)).toEqual([
        { role: "user", text: "Cardano là gì?" },
        { role: "assistant", text: "Cardano là một blockchain." },
      ]);
    } finally {
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

  it("rejects copied message envelopes in another conversation", async () => {
    const db = createDatabase(databaseUrl!);
    const repository = new ConversationRepository(db, Buffer.alloc(32, 3));
    const sourceUserId = `aad-source-${process.pid}-${Date.now()}`;
    const targetUserId = `${sourceUserId}-target`;

    try {
      await repository.append({
        telegramUserId: sourceUserId,
        telegramChatId: "source-chat",
        role: "user",
        text: "source message",
      });
      await db.query(
        `INSERT INTO telegram_users (telegram_user_id) VALUES ($1)
         ON CONFLICT DO NOTHING`,
        [targetUserId],
      );
      const source = await db.query<{
        ciphertext: string;
        iv: string;
        auth_tag: string;
      }>(
        `SELECT ciphertext, iv, auth_tag FROM conversation_messages
         WHERE telegram_user_id = $1 ORDER BY id DESC LIMIT 1`,
        [sourceUserId],
      );
      const copied = source.rows[0]!;
      await db.query(
        `INSERT INTO conversation_messages
         (telegram_user_id, telegram_chat_id, role, ciphertext, iv, auth_tag)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [targetUserId, "other-chat", "assistant", copied.ciphertext, copied.iv, copied.auth_tag],
      );

      await expect(repository.recent(targetUserId, 10)).rejects.toThrow(/authentication/);
    } finally {
      await db.end();
    }
  });
});
