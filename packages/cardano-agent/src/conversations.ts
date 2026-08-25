import type { Pool, PoolClient } from "pg";
import { decryptText, encryptText } from "./security/encryption.js";
import { findWalletSecret } from "./security/walletSecrets.js";

export type ConversationRole = "user" | "assistant";

export type ConversationMessage = {
  role: ConversationRole;
  text: string;
};

export type FindConversationMessageInput = {
  telegramUpdateId: number;
  telegramUserId: string;
  telegramChatId: string;
  role: ConversationRole;
};

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
      if (input.telegramUpdateId !== undefined) {
        const linked = await client.query(
          `UPDATE conversation_message_idempotency
           SET message_id = $1
           WHERE telegram_update_id = $2 AND role = $3 AND message_id IS NULL`,
          [id, input.telegramUpdateId, input.role],
        );
        if (linked.rowCount !== 1) throw new Error("Could not link conversation message idempotency record.");
      }
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

  async findForUpdate(input: FindConversationMessageInput): Promise<ConversationMessage | null | undefined> {
    if (!input || typeof input !== "object") {
      throw new Error("Conversation lookup input is invalid.");
    }
    if (!Number.isSafeInteger(input.telegramUpdateId) || input.telegramUpdateId <= 0) {
      throw new Error("Telegram update id is invalid.");
    }
    if (
      typeof input.telegramUserId !== "string" || !input.telegramUserId.trim() ||
      typeof input.telegramChatId !== "string" || !input.telegramChatId.trim()
    ) {
      throw new Error("Conversation identity is invalid.");
    }
    if (input.role !== "user" && input.role !== "assistant") {
      throw new Error("Conversation role is invalid.");
    }

    const reservation = await this.db.query<{ message_id: string | null }>(
      `SELECT message_id
       FROM conversation_message_idempotency
       WHERE telegram_update_id = $1 AND role = $2
       FOR UPDATE`,
      [input.telegramUpdateId, input.role],
    );
    const reservationRow = reservation.rows[0];
    if (!reservationRow) return undefined;

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
      `SELECT cm.id, cm.created_at, cm.telegram_user_id, cm.telegram_chat_id,
              cm.role, cm.ciphertext, cm.iv, cm.auth_tag
       FROM conversation_messages AS cm
       WHERE cm.telegram_user_id = $2
         AND cm.telegram_chat_id = $3
         AND cm.role = $4
         AND cm.id = $1
       FOR UPDATE`,
      [reservationRow.message_id, input.telegramUserId, input.telegramChatId, input.role],
    );
    const row = result.rows[0];
    if (!row) {
      if (reservationRow.message_id === null) {
        const legacy = await this.db.query(
          `SELECT cm.id
           FROM conversation_messages AS cm
           WHERE cm.telegram_user_id = $1 AND cm.telegram_chat_id = $2 AND cm.role = $3
           LIMIT 1
           FOR UPDATE`,
          [input.telegramUserId, input.telegramChatId, input.role],
        );
        return legacy.rows.length > 0 ? null : undefined;
      }
      return undefined;
    }
    return {
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
    };
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
