import type { CommandResult } from "@vennek/shared";

const TELEGRAM_MAX_LENGTH = 3900;
const TRUNCATED_SUFFIX = "\n\n[truncated for Telegram]";

export function formatForTelegram(result: CommandResult): string {
  return truncatePreservingCitations(result.text.replace(/\r\n/g, "\n"), TELEGRAM_MAX_LENGTH);
}

export function formatErrorForTelegram(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return truncate(`Draft analysis; human decides.\nCommand failed: ${message}`, TELEGRAM_MAX_LENGTH);
}

export function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - TRUNCATED_SUFFIX.length).trimEnd()}${TRUNCATED_SUFFIX}`;
}

function truncatePreservingCitations(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  const citationMarker = "\nCitations:\n";
  const citationIndex = value.indexOf(citationMarker);
  if (citationIndex === -1) {
    return truncate(value, maxLength);
  }

  const head = value.slice(0, citationIndex).trimEnd();
  const citations = value.slice(citationIndex).trimStart();
  const reservedTail = citations.length <= Math.floor(maxLength / 2) ? citations : truncate(citations, Math.floor(maxLength / 2));
  const separator = `${TRUNCATED_SUFFIX}\n\n`;
  const headBudget = maxLength - reservedTail.length - separator.length;
  if (headBudget <= 80) {
    return truncate(value, maxLength);
  }

  return `${head.slice(0, headBudget).trimEnd()}${separator}${reservedTail}`;
}
