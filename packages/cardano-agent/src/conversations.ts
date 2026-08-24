import type { Pool, PoolClient } from "pg";
import { decryptText, encryptText } from "./security/encryption.js";
import { findWalletSecret } from "./security/walletSecrets.js";

export type ConversationRole = "user" | "assistant";

const CONVERSATION_AAD_VERSION = "vennek-conversation-aad:v1";

function conversationAad(
  telegramUserId: string,
  telegramChatId: string,
  role: ConversationRole,
  id: string,
  createdAt: string,
): Buffer {
  return Buffer.from(
    [CONVERSATION_AAD_VERSION, telegramUserId, telegramChatId, role, id, createdAt]
      .map((field) => `${Buffer.byteLength(field, "utf8")}:${field}`)
      .join(""),
    "utf8",
  );
}

export class ConversationRepository {
  constructor(
    private readonly db: Pool,
    private readonly key: Buffer,
  ) {}

  async append(input: {
    telegramUserId: string;
    telegramChatId: string;
    role: ConversationRole;
    text: string;
    telegramUpdateId?: number;
  }): Promise<{ firstInteraction: boolean }> {
    if (findWalletSecret(input.text)) {
      throw new Error("Conversation text contains a wallet secret.");
    }
    if (input.telegramUpdateId !== undefined && (!Number.isSafeInteger(input.telegramUpdateId) || input.telegramUpdateId <= 0)) {
      throw new Error("Telegram update id is invalid.");
    }

    const client: PoolClient = await this.db.connect();
    let inTransaction = false;
    try {
      await client.query("BEGIN");
      inTransaction = true;
      const user = await client.query(
        "INSERT INTO telegram_users (telegram_user_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING telegram_user_id",
        [input.telegramUserId],
      );
      const firstInteraction = user.rows.length > 0;
      if (input.telegramUpdateId !== undefined) {
        const reservation = await client.query<{ first_interaction: boolean }>(
          `INSERT INTO conversation_message_idempotency
           (telegram_update_id, role, first_interaction)
           VALUES ($1, $2, $3)
           ON CONFLICT (telegram_update_id, role) DO NOTHING
           RETURNING first_interaction`,
          [input.telegramUpdateId, input.role, firstInteraction],
        );
        if (reservation.rows.length === 0) {
          const existing = await client.query<{ first_interaction: boolean }>(
            `SELECT first_interaction
             FROM conversation_message_idempotency
             WHERE telegram_update_id = $1 AND role = $2`,
            [input.telegramUpdateId, input.role],
          );
          const original = existing.rows[0]?.first_interaction;
          if (original === undefined) throw new Error("Could not read conversation idempotency reservation.");
          await client.query("COMMIT");
          inTransaction = false;
          return { firstInteraction: original };
        }
      }

      const sequence = await client.query<{ id: string }>(
        "SELECT nextval(pg_get_serial_sequence('conversation_messages', 'id'))::text AS id",
      );
      const id = sequence.rows[0]?.id;
      if (!id) throw new Error("Could not allocate a conversation message id.");
      const createdAt = new Date();
      const createdAtIso = createdAt.toISOString();
      const encrypted = encryptText(
        input.text,
        this.key,
        conversationAad(
          input.telegramUserId,
          input.telegramChatId,
          input.role,
          id,
          createdAtIso,
        ),
      );
      await client.query(
        `INSERT INTO conversation_messages
         (id, telegram_user_id, telegram_chat_id, role, ciphertext, iv, auth_tag, created_at)
         OVERRIDING SYSTEM VALUE
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          id,
          input.telegramUserId,
          input.telegramChatId,
          input.role,
          encrypted.ciphertext,
          encrypted.iv,
          encrypted.tag,
          createdAt,
        ],
      );
      await client.query("COMMIT");
      inTransaction = false;
      return { firstInteraction };
    } catch (error) {
      if (inTransaction) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Preserve the original database error.
        }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async recent(
    telegramUserId: string,
    limit: number,
  ): Promise<Array<{ role: ConversationRole; text: string }>> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      throw new Error("Conversation limit must be between 1 and 50.");
    }

    const result = await this.db.query<{
      id: string;
      created_at: Date;
      telegram_user_id: string;
      telegram_chat_id: string;
      role: ConversationRole;
      ciphertext: string;
      iv: string;
      auth_tag: string;
    }>(
      `SELECT id, created_at, telegram_user_id, telegram_chat_id, role, ciphertext, iv, auth_tag FROM conversation_messages
       WHERE telegram_user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
      [telegramUserId, limit],
    );

    return result.rows.reverse().map((row) => ({
      role: row.role,
      text: decryptText(
        { ciphertext: row.ciphertext, iv: row.iv, tag: row.auth_tag },
        this.key,
        conversationAad(
          row.telegram_user_id,
          row.telegram_chat_id,
          row.role,
          row.id,
          row.created_at.toISOString(),
        ),
      ),
    }));
  }
}
