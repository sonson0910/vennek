import { describe, expect, it } from "vitest";
import {
  ConversationRepository,
  createDatabase,
  ensureConversationPartitions,
} from "@vennek/cardano-agent";

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

  it("creates the next two monthly partitions safely", async () => {
    const db = createDatabase(databaseUrl!);

    try {
      await ensureConversationPartitions(db, new Date("2031-04-15T00:00:00.000Z"));
      const result = await db.query<{ first: boolean; second: boolean }>(
        "SELECT to_regclass($1) IS NOT NULL AS first, to_regclass($2) IS NOT NULL AS second",
        ["conversation_messages_2031_05", "conversation_messages_2031_06"],
      );
      expect(result.rows[0]).toEqual({ first: true, second: true });
    } finally {
      await db.end();
    }
  });
});
