import { sha256Hex } from "@vennek/shared";
import { chunkDocument } from "./chunkDocument.js";
import type { CrawlSourceResult, CrawledDocument } from "./crawlSource.js";
import type { KnowledgeChunkInput, KnowledgeRepository, RepositoryOperationOptions } from "./knowledgeRepository.js";

const MAX_DOCUMENT_CHARS = 2_000_000;
const INDEX_DEADLINE_MS = 120_000;

export type IndexDocumentRepository = Pick<KnowledgeRepository, "storeVersion" | "hasCompleteChunks" | "replaceChunks">;
export type EmbeddingProvider = {
  embed(input: string[], signal?: AbortSignal): Promise<Array<{ index: number; embedding: number[] }>>;
};
export type IndexDocumentDependencies = {
  repository: IndexDocumentRepository;
  embedder: EmbeddingProvider;
  embeddingModel: string;
};
export type IndexDocumentInput = CrawledDocument & IndexDocumentDependencies & { signal?: AbortSignal; deadlineAt?: number };
export type IndexedDocument = {
  versionId: string;
  contentHash: string;
  chunkCount: number;
  indexed: boolean;
};
export type IndexCrawlInput = IndexDocumentDependencies & { crawlResult: CrawlSourceResult; signal?: AbortSignal };
export type IndexCrawlSummary = {
  documents: IndexedDocument[];
  indexed: number;
  skipped: number;
  unchanged: number;
  committed: boolean;
};

export async function indexDocument(input: IndexDocumentInput): Promise<IndexedDocument> {
  const deadline = createDeadline(input.signal, input.deadlineAt);
  const signal = deadline.signal;
  const operation = repositoryOperation(deadline);
  ensureActive(signal);
  if (typeof input.embeddingModel !== "string" || !input.embeddingModel.trim()) {
    throw new Error("Embedding model must not be empty.");
  }
  const normalizedContent = normalizeDocumentText(input.text);
  if (normalizedContent.length > MAX_DOCUMENT_CHARS) throw new Error("Document content is too large.");
  const contentHash = sha256Hex(normalizedContent);
  ensureActive(signal);
  const version = await input.repository.storeVersion({
    sourceId: input.sourceId,
    canonicalUrl: input.canonicalUrl,
    title: input.title,
    content: normalizedContent,
    contentHash,
    ...(input.publishedAt ? { publishedAt: input.publishedAt } : {}),
    retrievedAt: input.retrievedAt,
  }, operation);
  ensureActive(signal);
  const chunks = chunkDocument(normalizedContent);
  const expectedHashes = chunks.map((chunk) => chunk.contentHash);
  const complete = await input.repository.hasCompleteChunks(version.id, input.embeddingModel, expectedHashes, operation);
  ensureActive(signal);
  if (complete) {
    return { versionId: version.id, contentHash, chunkCount: chunks.length, indexed: false };
  }

  ensureActive(signal);
  const embedded = await input.embedder.embed(chunks.map((chunk) => `${chunk.heading}\n${chunk.content}`), signal);
  if (!Array.isArray(embedded) || embedded.length !== chunks.length) {
    throw new Error("Embedding indexes are malformed.");
  }
  const indexedChunks = chunks.map((chunk, index) => {
    const result = embedded[index];
    if (!result || result.index !== index || !Array.isArray(result.embedding)) {
      throw new Error("Embedding indexes are malformed.");
    }
    return {
      ordinal: chunk.ordinal,
      heading: chunk.heading,
      content: chunk.content,
      contentHash: chunk.contentHash,
      embeddingModel: input.embeddingModel,
      embedding: result.embedding,
    } satisfies KnowledgeChunkInput;
  });
  ensureActive(signal);
  await input.repository.replaceChunks(version.id, indexedChunks, operation);
  ensureActive(signal);
  return { versionId: version.id, contentHash, chunkCount: chunks.length, indexed: true };
}

export async function indexCrawlResult(input: IndexCrawlInput): Promise<IndexCrawlSummary> {
  const deadline = createDeadline(input.signal);
  const signal = deadline.signal;
  ensureActive(signal);
  const documents: IndexedDocument[] = [];
  for (const document of input.crawlResult.documents) {
    ensureActive(signal);
    documents.push(await indexDocument({
      ...document,
      repository: input.repository,
      embedder: input.embedder,
      embeddingModel: input.embeddingModel,
      signal,
      deadlineAt: deadline.deadlineAt,
    }));
  }
  ensureActive(signal);
  let committed = false;
  if (input.crawlResult.commitState) {
    if (!(await input.crawlResult.commitState(repositoryOperation(deadline)))) throw new Error("GitHub fetch state commit failed.");
    ensureActive(signal);
    committed = true;
  }
  return {
    documents,
    indexed: documents.filter((document) => document.indexed).length,
    skipped: documents.filter((document) => !document.indexed).length,
    unchanged: input.crawlResult.unchanged,
    committed,
  };
}

function normalizeDocumentText(content: string): string {
  if (typeof content !== "string") throw new Error("Document content is required.");
  const normalized = content.replace(/\r\n?/g, "\n").normalize("NFC").trim();
  if (!normalized) throw new Error("Document content must not be empty.");
  return normalized;
}

type DeadlineContext = {
  signal: AbortSignal;
  deadlineAt: number;
};

function createDeadline(signal: AbortSignal | undefined, deadlineAt = Date.now() + INDEX_DEADLINE_MS): DeadlineContext {
  if (typeof deadlineAt !== "number" || !Number.isFinite(deadlineAt)) {
    throw new Error("Indexing deadline is invalid.");
  }
  const now = Date.now();
  const boundedDeadlineAt = Math.min(deadlineAt, now + INDEX_DEADLINE_MS);
  const remaining = boundedDeadlineAt - now;
  let deadlineSignal: AbortSignal;
  if (remaining <= 0) {
    const controller = new AbortController();
    controller.abort();
    deadlineSignal = controller.signal;
  } else {
    deadlineSignal = AbortSignal.timeout(remaining);
  }
  return { signal: signal ? AbortSignal.any([signal, deadlineSignal]) : deadlineSignal, deadlineAt: boundedDeadlineAt };
}

function repositoryOperation(deadline: DeadlineContext): RepositoryOperationOptions {
  return { signal: deadline.signal, deadlineAt: deadline.deadlineAt };
}

function ensureActive(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("Indexing aborted.");
}
