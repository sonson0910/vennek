import type { Pool, PoolClient } from "pg";
import { decryptText, encryptText } from "./security/encryption.js";
import { findWalletSecret } from "./security/walletSecrets.js";

export type ConversationRole = "user" | "assistant";

const CONVERSATION_AAD_VERSION = "vennek-conversation-aad:v1";

function conversationAad(
  telegramUserId: string,
  telegramChatId: string,
  role: ConversationRole,
): Buffer {
  return Buffer.from(
    [CONVERSATION_AAD_VERSION, telegramUserId, telegramChatId, role]
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
  }): Promise<void> {
    if (findWalletSecret(input.text)) {
      throw new Error("Conversation text contains a wallet secret.");
    }
    const encrypted = encryptText(
      input.text,
      this.key,
      conversationAad(input.telegramUserId, input.telegramChatId, input.role),
    );

    const client: PoolClient = await this.db.connect();
    let inTransaction = false;
    try {
      await client.query("BEGIN");
      inTransaction = true;
      await client.query(
        "INSERT INTO telegram_users (telegram_user_id) VALUES ($1) ON CONFLICT DO NOTHING",
        [input.telegramUserId],
      );
      await client.query(
        `INSERT INTO conversation_messages
         (telegram_user_id, telegram_chat_id, role, ciphertext, iv, auth_tag)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          input.telegramUserId,
          input.telegramChatId,
          input.role,
          encrypted.ciphertext,
          encrypted.iv,
          encrypted.tag,
        ],
      );
      await client.query("COMMIT");
      inTransaction = false;
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
      telegram_user_id: string;
      telegram_chat_id: string;
      role: ConversationRole;
      ciphertext: string;
      iv: string;
      auth_tag: string;
    }>(
      `SELECT telegram_user_id, telegram_chat_id, role, ciphertext, iv, auth_tag FROM conversation_messages
       WHERE telegram_user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
      [telegramUserId, limit],
    );

    return result.rows.reverse().map((row) => ({
      role: row.role,
      text: decryptText(
        { ciphertext: row.ciphertext, iv: row.iv, tag: row.auth_tag },
        this.key,
        conversationAad(row.telegram_user_id, row.telegram_chat_id, row.role),
      ),
    }));
  }
}
