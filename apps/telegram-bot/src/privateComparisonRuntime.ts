import {
  comparePrivateDocument,
  findWalletSecret,
  type EmbeddingProvider,
  type Evidence,
  type PrivateComparisonCompletion,
  type PrivateComparisonUsage,
  type RetrieveEvidenceDependencies,
  type RetrieveEvidenceInput,
  type PrivateExtractionResult,
} from "@vennek/cardano-agent";
import type { TelegramApi, TelegramFile } from "./pollingRuntime.js";
import {
  decryptPrivateComparisonJob,
  validateEncryptedPrivateComparisonJob,
  type EncryptedPrivateComparisonJob,
  type PrivateComparisonMetadata,
  type PrivateComparisonOwner,
} from "./privateComparisonQueue.js";

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

export type PrivateComparisonRuntimeDependencies = Readonly<{
  api: PrivateTelegramApi;
  encryptionKey: Uint8Array;
  extractor: {
    extract(bytes: Uint8Array, metadata: { fileName: string; mime: string }, signal?: AbortSignal): Promise<PrivateExtractionResult>;
  };
  retrieve(input: RetrieveEvidenceInput, dependencies: RetrieveEvidenceDependencies): Promise<unknown>;
  db: RetrieveEvidenceDependencies["db"];
  embedder: EmbeddingProvider;
  embeddingModel: string;
  generationModel: string;
  verifierModel: string;
  complete: PrivateComparisonCompletion;
  compare?: typeof comparePrivateDocument;
  recordUsage?: (telegramUserId: string, usage: PrivateComparisonUsage) => Promise<void> | void;
  send(chatId: string, text: string): Promise<{ delivered: boolean; attempts: number } | void>;
  signal?: AbortSignal;
  markStatus?: (updateId: number, status: "processed" | "failed") => Promise<void>;
  log?: (category: PrivateComparisonFailureCategory) => void;
}>;

export type PrivateComparisonJobOutcome = Readonly<{
  delivered: boolean;
  attempts: number;
}>;

export type PrivateComparisonFailureCategory =
  | "validation"
  | "telegram"
  | "extraction"
  | "retrieval"
  | "comparison"
  | "delivery"
  | "processing";

/**
 * Runs one private comparison entirely in memory. No conversation repository,
 * discovery, promotion, or retrieval-cache path is available to this seam.
 */
export async function processPrivateComparisonJob(
  value: unknown,
  dependencies: PrivateComparisonRuntimeDependencies,
): Promise<PrivateComparisonJobOutcome> {
  let job: EncryptedPrivateComparisonJob;
  try {
    job = validateEncryptedPrivateComparisonJob(value);
  } catch {
    dependencies.log?.("validation");
    throw new PrivateComparisonRuntimeError("validation");
  }
  const owner: PrivateComparisonOwner = Object.freeze({
    updateId: job.updateId,
    telegramUserId: job.telegramUserId,
    telegramChatId: job.telegramChatId,
  });

  let metadata: PrivateComparisonMetadata | undefined;
  let document: PrivateExtractionResult | undefined;
  let evidence: readonly Evidence[] | undefined;
  let phase: PrivateComparisonFailureCategory = "processing";
  const signal = dependencies.signal;
  try {
    try {
      metadata = decryptPrivateComparisonJob(job, dependencies.encryptionKey, owner);
    } catch {
      throw new PrivateComparisonRuntimeError("validation");
    }

    const safeMetadata = metadata;
    if (!safeMetadata) throw new PrivateComparisonRuntimeError("validation");
    let answer: string | undefined;
    phase = "telegram";
    await withPrivateTelegramDocument(
      dependencies.api,
      safeMetadata.fileId,
      safeMetadata.fileUniqueId,
      safeMetadata.fileSize,
      signal,
      async (bytes) => {
        phase = "extraction";
        const extracted = await dependencies.extractor.extract(
          bytes,
          { fileName: safeMetadata.fileName ?? "", mime: safeMetadata.mime ?? "" },
          signal,
        );
        document = extracted;
        if (findWalletSecret(extracted.title) || findWalletSecret(extracted.text)) {
          answer = walletSecretWarning();
          return;
        }

        phase = "retrieval";
        const retrieved = await dependencies.retrieve(
          {
            query: safeMetadata.caption,
            language: "en",
            embeddingModel: dependencies.embeddingModel,
            personalized: true,
            ...(signal ? { signal } : {}),
          },
          { db: dependencies.db, embedder: dependencies.embedder },
        );
        if (!Array.isArray(retrieved)) throw new Error("Cardano evidence is invalid");
        evidence = retrieved.filter((item) => isFreshEvidence(item));
        if (findWalletSecret(JSON.stringify(evidence))) {
          answer = walletSecretWarning();
          return;
        }

        phase = "comparison";
        const compare = dependencies.compare ?? comparePrivateDocument;
        const complete = async (input: Parameters<PrivateComparisonCompletion>[0]) => {
          const output = await dependencies.complete(input);
          return { ...output, model: input.model };
        };
        answer = await compare({
          caption: safeMetadata.caption,
          language: "en",
          privateDocument: extracted,
          publicEvidence: evidence ?? [],
          generationModel: dependencies.generationModel,
          verifierModel: dependencies.verifierModel,
          complete,
          ...(dependencies.recordUsage === undefined ? {} : {
            recordUsage: (usage: PrivateComparisonUsage) => dependencies.recordUsage!(owner.telegramUserId, usage),
          }),
        });
      },
    );
    if (answer === undefined) throw new Error("Private comparison produced no answer");

    phase = "delivery";
    const delivery = await dependencies.send(owner.telegramChatId, answer);
    const outcome = normalizeDelivery(delivery);
    await markPrivateStatus(dependencies, owner.updateId, outcome.delivered ? "processed" : "failed");
    return outcome;
  } catch (error) {
    const safeError = error instanceof PrivateComparisonRuntimeError
      ? error
      : new PrivateComparisonRuntimeError(phase);
    dependencies.log?.(safeError.category);
    await markPrivateStatus(dependencies, owner.updateId, "failed");
    throw safeError;
  } finally {
    // The downloader/client own byte cleanup; dropping references here bounds worker retention.
    metadata = undefined;
    document = undefined;
    evidence = undefined;
  }
}

class PrivateComparisonRuntimeError extends Error {
  constructor(readonly category: PrivateComparisonFailureCategory) {
    super(`Private comparison failed: ${category}`);
    this.name = "PrivateComparisonRuntimeError";
  }
}

function isFreshEvidence(value: unknown): boolean {
  return typeof value === "object" && value !== null && (value as { stale?: unknown }).stale !== true;
}

function walletSecretWarning(): string {
  return "Do not send wallet secrets such as a seed phrase or private key here. Please remove them from the document.";
}

function normalizeDelivery(delivery: { delivered: boolean; attempts: number } | void): PrivateComparisonJobOutcome {
  if (delivery && "delivered" in delivery) {
    return { delivered: delivery.delivered, attempts: delivery.attempts };
  }
  return { delivered: true, attempts: 1 };
}

async function markPrivateStatus(
  dependencies: PrivateComparisonRuntimeDependencies,
  updateId: number,
  status: "processed" | "failed",
): Promise<void> {
  try {
    await dependencies.markStatus?.(updateId, status);
  } catch {
    dependencies.log?.("processing");
  }
}
