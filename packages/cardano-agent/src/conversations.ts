import type { Pool } from "pg";
import { decryptText, encryptText } from "./security/encryption.js";

export type ConversationRole = "user" | "assistant";

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
    const encrypted = encryptText(input.text, this.key);

    await this.db.query(
      "INSERT INTO telegram_users (telegram_user_id) VALUES ($1) ON CONFLICT DO NOTHING",
      [input.telegramUserId],
    );
    await this.db.query(
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
  }

  async recent(
    telegramUserId: string,
    limit: number,
  ): Promise<Array<{ role: ConversationRole; text: string }>> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      throw new Error("Conversation limit must be between 1 and 50.");
    }

    const result = await this.db.query<{
      role: ConversationRole;
      ciphertext: string;
      iv: string;
      auth_tag: string;
    }>(
      `SELECT role, ciphertext, iv, auth_tag FROM conversation_messages
       WHERE telegram_user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
      [telegramUserId, limit],
    );

    return result.rows.reverse().map((row) => ({
      role: row.role,
      text: decryptText(
        { ciphertext: row.ciphertext, iv: row.iv, tag: row.auth_tag },
        this.key,
      ),
    }));
  }
}
