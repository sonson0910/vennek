export function parseAllowedChatIds(value = ""): ReadonlySet<string> {
  const ids = value.split(",").map((part) => part.trim()).filter(Boolean);
  if (ids.length === 0) {
    throw new Error("VENNEK_TELEGRAM_ALLOWED_CHAT_IDS is required in polling mode.");
  }
  for (const id of ids) {
    if (!/^-?\d+$/.test(id)) {
      throw new Error(`Invalid Telegram chat id: ${id}`);
    }
  }
  return new Set(ids);
}

export function isAllowedChat(chatId: number | string, allowed: ReadonlySet<string>): boolean {
  return allowed.has(String(chatId));
}
