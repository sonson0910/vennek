export type SourceType = "catalyst" | "governance-action" | "user-provided";

export type SourceStatus = "available" | "partial" | "unavailable";

export type Stance = "support" | "oppose" | "abstain";

export type Citation = {
  id: string;
  url: string;
  title?: string;
  snippet: string;
  retrievedAt: string;
};

export type ProposalDocument = {
  id: string;
  sourceType: SourceType;
  url?: string;
  title: string;
  body: string;
  metadata: Record<string, unknown>;
  citations: Citation[];
  retrievedAt: string;
};

export type CommandContext = {
  now?: Date;
  sampleRoot?: string;
  documents?: ProposalDocument[];
  /** Enable bundled sample fixtures. Demo/tests opt in; production Telegram routes default off. */
  enableFixtures?: boolean;
  /** Enable reading ProposalDocument JSON files from disk. Never enable for untrusted chat input. */
  allowLocalFiles?: boolean;
  /** Required root directory when allowLocalFiles is true. Paths must resolve inside this root. */
  allowedFileRoot?: string;
  /** Optional durable runtime data directory for audit logs, source cache, and proof receipts. */
  persistenceRoot?: string;
  /** Optional Blockfrost project id for payload-only proof tx verification. */
  blockfrostProjectId?: string;
  /** Optional Blockfrost network; defaults to mainnet. */
  blockfrostNetwork?: "mainnet" | "preprod" | "preview";
};

export type CommandAuditLogEntry = {
  id: string;
  createdAt: string;
  command: string;
  ok: boolean;
  sourceStatus: SourceStatus;
  inputHash: string;
  inputPreview: string;
  outputHash: string;
  outputPreview: string;
  citationIds: string[];
  warnings: string[];
};

export type SourceCacheRecord = {
  id: string;
  documentHash: string;
  cachedAt: string;
  document: ProposalDocument;
};

export type CommandResult = {
  command: string;
  ok: boolean;
  text: string;
  citations: Citation[];
  sourceStatus: SourceStatus;
  warnings: string[];
  data?: unknown;
};

export type ProofPayload = {
  schema: "vennek.proof.v1";
  content_hash: string;
  source_refs: string[];
  created_at: string;
  agent_version: string;
  report_id?: string;
};

export type ProofReceipt = {
  payload: ProofPayload;
  local_id: string;
  status: "payload-only" | "pending-external-verification" | "verified" | "failed";
  external_tx_hash?: string;
};

export type SourceValidationResult = {
  id: string;
  sourceType: SourceType;
  url?: string;
  ok: boolean;
  citationCount: number;
  normalizedId?: string;
  reason?: string;
};
