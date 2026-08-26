import {
  comparePrivateDocument,
  detectQuestionLanguage,
  findWalletSecret,
  localizedQuestionMessage,
  PrivateDocumentClientError,
  PrivateComparisonProviderError,
  type EmbeddingProvider,
  type Evidence,
  type PrivateComparisonCompletion,
  type PrivateComparisonUsage,
  type RetrieveEvidenceDependencies,
  type RetrieveEvidenceInput,
  type PrivateExtractionResult,
  type QuestionLanguage,
} from "@vennek/cardano-agent";
import { TelegramApiError, type TelegramApi, type TelegramFile } from "./pollingRuntime.js";
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
  if (signal?.aborted) throw new TelegramApiError(499, "Telegram private document unavailable");
  let file: TelegramFile;
  try {
    file = await api.getFile({ file_id: fileId });
    if (signal?.aborted) throw new TelegramApiError(499, "Telegram private document unavailable");
    if (
      file.file_id !== fileId ||
      file.file_unique_id !== expectedFileUniqueId ||
      file.file_path === undefined ||
      (expectedSize !== undefined && file.file_size !== undefined && expectedSize !== file.file_size)
    ) {
      throw new TelegramApiError(400, "Telegram private document unavailable");
    }
  } catch (error) {
    if (error instanceof TelegramApiError) throw error;
    throw new TelegramApiError(502, "Telegram private document unavailable");
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
  send(chatId: string, text: string, signal?: AbortSignal): Promise<{ delivered: boolean; attempts: number; aborted?: boolean; status?: number } | void>;
  signal?: AbortSignal;
  markStatus?: (updateId: number, status: "processed" | "failed") => Promise<void>;
  log?: (category: PrivateComparisonFailureCategory) => void;
}>;

export type PrivateComparisonJobOutcome = Readonly<{
  delivered: boolean;
  attempts: number;
  aborted?: boolean;
  terminal?: boolean;
  status?: number;
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
  let failedStatusAttempted = false;
  let language: QuestionLanguage = "en";
  try {
    try {
      metadata = decryptPrivateComparisonJob(job, dependencies.encryptionKey, owner);
    } catch {
      throw new PrivateComparisonRuntimeError("validation");
    }

    const safeMetadata = metadata;
    if (!safeMetadata) throw new PrivateComparisonRuntimeError("validation");
    language = detectQuestionLanguage(safeMetadata.caption);
    failedStatusAttempted = true;
    await markPrivateStatus(dependencies, owner.updateId, "failed");
    throwIfAborted(signal);
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
        throwIfAborted(signal);
        document = extracted;
        if (findWalletSecret(extracted.title) || findWalletSecret(extracted.text)) {
          answer = walletSecretWarning(language);
          return;
        }

        phase = "retrieval";
        const retrieved = await dependencies.retrieve(
          {
            query: safeMetadata.caption,
            language,
            embeddingModel: dependencies.embeddingModel,
            personalized: true,
            ...(signal ? { signal } : {}),
          },
          { db: dependencies.db, embedder: dependencies.embedder },
        );
        throwIfAborted(signal);
        if (!Array.isArray(retrieved)) throw new PrivateComparisonRuntimeError("retrieval", false);
        evidence = retrieved.filter((item) => isFreshEvidence(item));
        if (findWalletSecret(JSON.stringify(evidence))) {
          answer = walletSecretWarning(language);
          return;
        }

        phase = "comparison";
        const compare = dependencies.compare ?? comparePrivateDocument;
        const complete = async (input: Parameters<PrivateComparisonCompletion>[0]) => {
          const output = await stopOnAbort(Promise.resolve().then(() => dependencies.complete(input)), signal);
          return { ...output, model: input.model };
        };
        answer = await stopOnAbort(Promise.resolve().then(() => compare({
          caption: safeMetadata.caption,
          language,
          privateDocument: extracted,
          publicEvidence: evidence ?? [],
          generationModel: dependencies.generationModel,
          verifierModel: dependencies.verifierModel,
          complete,
          ...(dependencies.recordUsage === undefined ? {} : {
            recordUsage: (usage: PrivateComparisonUsage) => dependencies.recordUsage!(owner.telegramUserId, usage),
          }),
        })), signal);
        throwIfAborted(signal);
      },
    );
    if (answer === undefined) throw new Error("Private comparison produced no answer");
    const finalAnswer = answer;

    phase = "delivery";
    throwIfAborted(signal);
    const delivery = await stopOnAbort(Promise.resolve().then(() => signal === undefined
      ? dependencies.send(owner.telegramChatId, finalAnswer)
      : dependencies.send(owner.telegramChatId, finalAnswer, signal)), signal);
    const outcome = normalizeDelivery(delivery);
    if (outcome.aborted || signal?.aborted) return abortedOutcome(outcome.attempts, outcome.status);
    await markPrivateStatus(dependencies, owner.updateId, outcome.delivered ? "processed" : "failed");
    return !outcome.delivered && isPermanentTelegramStatus(outcome.status)
      ? { ...outcome, terminal: true }
      : outcome;
  } catch (error) {
    if (isAbortError(error, signal)) {
      dependencies.log?.("processing");
      if (failedStatusAttempted) await markPrivateStatus(dependencies, owner.updateId, "failed");
      return abortedOutcome(0);
    }
    const safeError = error instanceof PrivateComparisonProviderError
      ? error
      : classifyFailure(error, phase);
    dependencies.log?.(safeError.category);
    if (!failedStatusAttempted) throw safeError;
    if (!safeError.retryable) {
      let terminal: PrivateComparisonJobOutcome | undefined;
      try {
        terminal = await deliverTerminalFailure(dependencies, owner.telegramChatId, language, safeError.category, signal);
      } catch (error) {
        if (isAbortError(error, signal)) return abortedOutcome(0);
        throw new PrivateComparisonRuntimeError("delivery", true);
      }
      if (terminal) {
        await markPrivateStatus(dependencies, owner.updateId, terminal.delivered ? "processed" : "failed");
        return terminal;
      }
    }
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
  constructor(readonly category: PrivateComparisonFailureCategory, readonly retryable = true) {
    super(`Private comparison failed: ${category}`);
    this.name = "PrivateComparisonRuntimeError";
  }
}

export class PrivateComparisonAbortError extends PrivateComparisonRuntimeError {
  constructor() {
    super("processing", false);
    this.name = "PrivateComparisonAbortError";
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new PrivateComparisonAbortError();
}

function stopOnAbort<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return operation;
  if (signal.aborted) return Promise.reject(new PrivateComparisonAbortError());
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", abort);
    const abort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new PrivateComparisonAbortError());
    };
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

function isAbortError(error: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || error instanceof PrivateComparisonAbortError ||
    (error instanceof PrivateDocumentClientError && error.aborted);
}

function classifyFailure(error: unknown, phase: PrivateComparisonFailureCategory): PrivateComparisonRuntimeError {
  if (error instanceof PrivateComparisonRuntimeError) return error;
  if (error instanceof PrivateComparisonProviderError) return new PrivateComparisonRuntimeError("comparison", true);
  if (error instanceof PrivateDocumentClientError) return new PrivateComparisonRuntimeError("extraction", error.retryable);
  if (error instanceof TelegramApiError) {
    return new PrivateComparisonRuntimeError("telegram", error.status === 429 || error.status >= 500);
  }
  return new PrivateComparisonRuntimeError(phase, phase !== "extraction" && phase !== "telegram" ? true : false);
}

function isPermanentTelegramStatus(status: number | undefined): boolean {
  return status !== undefined && status >= 400 && status <= 499 && status !== 429;
}

async function deliverTerminalFailure(
  dependencies: PrivateComparisonRuntimeDependencies,
  chatId: string,
  language: QuestionLanguage,
  category: PrivateComparisonFailureCategory,
  signal: AbortSignal | undefined,
): Promise<PrivateComparisonJobOutcome | undefined> {
  if (signal?.aborted) return abortedOutcome(0);
  const delivery = normalizeDelivery(await stopOnAbort(
    Promise.resolve().then(() => signal === undefined
      ? dependencies.send(chatId, terminalFailureMessage(language, category))
      : dependencies.send(chatId, terminalFailureMessage(language, category), signal)),
    signal,
  ));
  if (delivery.aborted || signal?.aborted) return abortedOutcome(delivery.attempts, delivery.status);
  if (delivery.delivered) return { ...delivery, terminal: true };
  if (isPermanentTelegramStatus(delivery.status)) {
    return { ...delivery, terminal: true };
  }
  return undefined;
}

function isFreshEvidence(value: unknown): boolean {
  return typeof value === "object" && value !== null && (value as { stale?: unknown }).stale !== true;
}

function walletSecretWarning(language: QuestionLanguage): string {
  return localizedQuestionMessage(language, "secret");
}

function terminalFailureMessage(language: QuestionLanguage, category: PrivateComparisonFailureCategory): string {
  const kind = category === "validation" || category === "extraction" || category === "retrieval"
    ? "invalid"
    : "dependency";
  return localizedQuestionMessage(language, kind);
}

function normalizeDelivery(delivery: { delivered: boolean; attempts: number; aborted?: boolean; status?: number } | void): PrivateComparisonJobOutcome {
  if (delivery && "delivered" in delivery) {
    return {
      delivered: delivery.delivered,
      attempts: delivery.attempts,
      ...(delivery.aborted ? { aborted: true } : {}),
      ...(delivery.status === undefined ? {} : { status: delivery.status }),
    };
  }
  return { delivered: true, attempts: 1 };
}

function abortedOutcome(attempts: number, status?: number): PrivateComparisonJobOutcome {
  return { delivered: false, attempts, aborted: true, ...(status === undefined ? {} : { status }) };
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
