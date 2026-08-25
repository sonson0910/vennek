export const AGENT_PACKAGE_VERSION = "1";

export { parseAgentConfig } from "./config.js";
export type { AgentConfig } from "./config.js";

export { decryptText, encryptText } from "./security/encryption.js";
export type { EncryptedText } from "./security/encryption.js";
export { findWalletSecret } from "./security/walletSecrets.js";
export type { WalletSecretKind } from "./security/walletSecrets.js";

export { createDatabase } from "./database.js";
export { ConversationRepository } from "./conversations.js";
export type { ConversationRole } from "./conversations.js";
export { ensureConversationPartitions } from "./conversationPartitions.js";

export { LiteLlmClient } from "./llm/liteLlmClient.js";
export type {
  ChatMessage,
  CompletionInput,
  CompletionOutput,
} from "./llm/liteLlmClient.js";
export { EmbeddingClient } from "./llm/embeddingClient.js";
export type { EmbeddingResult } from "./llm/embeddingClient.js";
export { selectModelProfile } from "./llm/modelRouter.js";
export type { ModelProfile } from "./llm/modelRouter.js";

export { answerQuestion, RETENTION_NOTICE } from "./agent/answerQuestion.js";
export type {
  AnswerQuestionDependencies,
  AnswerCompletionInput,
  AnswerUsage,
  QuestionInput,
  QuestionLanguage,
  QuestionPersistenceResult,
  QuestionRetrievalInput,
} from "./agent/answerQuestion.js";

export {
  REQUIRED_OFFICIAL_SOURCE_IDS,
  urlMatchesSourceScope,
  validateSourceRegistry,
} from "./knowledge/sourceRegistry.js";
export type {
  CardanoNetwork,
  GithubScope,
  RefreshRate,
  SourceKind,
  SourceRegistryEntry,
  SourceRegistryEnvelope,
  TrustTier,
} from "./knowledge/sourceRegistry.js";
export { validateSourceRegistryEnvelope } from "./knowledge/sourceRegistry.js";

export { extractContent } from "./knowledge/extractContent.js";
export type { ExtractContentInput, ExtractedContent, PdfExtractor } from "./knowledge/extractContent.js";
export { chunkDocument } from "./knowledge/chunkDocument.js";
export type { DocumentChunk } from "./knowledge/chunkDocument.js";
export { PdfExtractorClient, createPdfExtractorClient } from "./knowledge/pdfExtractorClient.js";
export type { PdfExtractorClientConfig } from "./knowledge/pdfExtractorClient.js";
export {
  PDF_EXTRACTOR_PATH,
  PDF_MAX_INPUT_BYTES,
  PDF_MAX_OUTPUT_CHARS,
  PdfExtractorError,
} from "./knowledge/pdfExtractorProtocol.js";
export type { PdfExtractionResult } from "./knowledge/pdfExtractorProtocol.js";

export { fetchGithubSource } from "./knowledge/githubSource.js";
export type {
  GithubSourceDocument,
  GithubSourceInput,
  GithubSourceResult,
} from "./knowledge/githubSource.js";

export { crawlSource, fetchCrawlResponse } from "./knowledge/crawlSource.js";
export type {
  CrawlResponse,
  CrawlSourceInput,
  CrawlSourceResult,
  CrawledDocument,
} from "./knowledge/crawlSource.js";
export { syncSource } from "./knowledge/syncSource.js";
export type { SyncSourceDependencies, SyncSourceInput } from "./knowledge/syncSource.js";
export { indexDocument, indexCrawlResult } from "./knowledge/indexDocument.js";
export type {
  EmbeddingProvider,
  IndexCrawlInput,
  IndexCrawlSummary,
  IndexDocumentDependencies,
  IndexDocumentInput,
  IndexDocumentRepository,
  IndexedDocument,
} from "./knowledge/indexDocument.js";

export { KnowledgeRepository } from "./knowledge/knowledgeRepository.js";
export type {
  GithubEndpoint,
  GithubEndpointState,
  GithubEndpointStateUpdate,
  KnowledgeChunkInput,
  KnowledgeVersion,
  RepositoryOperationOptions,
  StoreVersionInput,
} from "./knowledge/knowledgeRepository.js";
export { PromotionAuditRepository } from "./knowledge/promotionAudit.js";
export type {
  PromotionClaim,
  PromotionClaimInput,
  PromotionCompletion,
  PromotionOutcome,
} from "./knowledge/promotionAudit.js";

export { retrieveEvidence } from "./knowledge/retrieveEvidence.js";
export type {
  Evidence,
  RetrieveEvidenceDependencies,
  RetrieveEvidenceInput,
} from "./knowledge/retrieveEvidence.js";

export { SearxngClient } from "./knowledge/searxng.js";
export type { SearxngFetch, SearxngResult } from "./knowledge/searxng.js";
export {
  buildOfficialSearchQuery,
  discoverLiveSources,
  promoteQuestionSources,
  promoteDiscoveredLink,
} from "./knowledge/liveDiscovery.js";
export type {
  DiscoveredLink,
  DiscoverLiveSourcesInput,
  LiveDiscoverySearch,
  PromoteQuestionSourcesInput,
  PromoteDiscoveredLinkInput,
  PromotedDiscoveredLink,
} from "./knowledge/liveDiscovery.js";
