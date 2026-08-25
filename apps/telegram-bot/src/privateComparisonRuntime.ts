import type { TelegramApi, TelegramFile } from "./pollingRuntime.js";

export type PrivateTelegramApi = Pick<
  Required<TelegramApi>,
  "getFile" | "withDownloadedFile"
>;

/**
 * Resolves Telegram metadata immediately before streaming and binds both file
 * identifiers and the advisory size before any private bytes reach a worker.
 */
export async function withPrivateTelegramDocument(
  api: PrivateTelegramApi,
  fileId: string,
  expectedFileUniqueId: string,
  expectedSize: number | undefined,
  signal: AbortSignal | undefined,
  consumer: (bytes: Buffer) => void | Promise<void>,
): Promise<void> {
  let file: TelegramFile;
  try {
    file = await api.getFile({ file_id: fileId });
    if (
      file.file_id !== fileId ||
      file.file_unique_id !== expectedFileUniqueId ||
      file.file_path === undefined ||
      (expectedSize !== undefined && file.file_size !== undefined && expectedSize !== file.file_size)
    ) {
      throw new Error("Telegram file metadata changed");
    }
  } catch {
    throw new Error("Telegram private document unavailable");
  }

  await api.withDownloadedFile(file.file_path, expectedSize ?? file.file_size, signal, consumer);
}
