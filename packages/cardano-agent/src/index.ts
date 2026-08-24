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
export { selectModelProfile } from "./llm/modelRouter.js";
export type { ModelProfile } from "./llm/modelRouter.js";

export { answerQuestion, RETENTION_NOTICE } from "./agent/answerQuestion.js";
export type {
  AnswerQuestionDependencies,
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
  TrustTier,
} from "./knowledge/sourceRegistry.js";

export { extractContent } from "./knowledge/extractContent.js";
export type { ExtractContentInput, ExtractedContent } from "./knowledge/extractContent.js";

export { KnowledgeRepository } from "./knowledge/knowledgeRepository.js";
export type {
  KnowledgeChunkInput,
  KnowledgeVersion,
  StoreVersionInput,
} from "./knowledge/knowledgeRepository.js";
