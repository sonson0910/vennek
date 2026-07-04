import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  canonicalJson,
  sha256Hex,
  type CommandAuditLogEntry,
  type CommandContext,
  type CommandResult,
  type ProofReceipt,
  type ProposalDocument,
  type SourceCacheRecord
} from "@vennek/shared";

export function persistCommandResult(input: {
  rawInput: string;
  result: CommandResult;
  context?: CommandContext;
  now?: Date;
}): CommandAuditLogEntry | undefined {
  const root = input.context?.persistenceRoot;
  if (!root) {
    return undefined;
  }

  const createdAt = (input.now ?? input.context?.now ?? new Date()).toISOString();
  const outputText = input.result.text;
  const entry: CommandAuditLogEntry = {
    id: `audit-${sha256Hex(`${createdAt}\n${input.rawInput}\n${outputText}`).slice(0, 16)}`,
    createdAt,
    command: input.result.command,
    ok: input.result.ok,
    sourceStatus: input.result.sourceStatus,
    inputHash: `sha256:${sha256Hex(input.rawInput)}`,
    inputPreview: safePreview(input.rawInput, input.result.command),
    outputHash: `sha256:${sha256Hex(outputText)}`,
    outputPreview: safePreview(outputText, input.result.command, 240),
    citationIds: input.result.citations.map((citation) => citation.id),
    warnings: input.result.warnings
  };

  const directories = ensureStoreDirectories(root);
  appendJsonLine(join(directories.auditLogs, "commands.jsonl"), entry);
  for (const document of extractDocuments(input.result.data)) {
    putSourceDocument(root, document, createdAt);
  }
  const proof = extractProofReceipt(input.result.data);
  if (proof) {
    putProofReceipt(root, proof, createdAt);
  }

  return entry;
}

export function putSourceDocument(root: string, document: ProposalDocument, cachedAt = new Date().toISOString()): SourceCacheRecord {
  const directories = ensureStoreDirectories(root);
  const documentHash = sha256Hex(canonicalJson(document));
  const record: SourceCacheRecord = {
    id: document.id,
    documentHash: `sha256:${documentHash}`,
    cachedAt,
    document
  };
  writeJson(join(directories.sourceCache, `${safeFileName(document.id)}-${documentHash.slice(0, 12)}.json`), record);
  return record;
}

export function putProofReceipt(root: string, receipt: ProofReceipt, cachedAt = new Date().toISOString()): void {
  const directories = ensureStoreDirectories(root);
  writeJson(join(directories.proofReceipts, `${safeFileName(receipt.local_id)}.json`), {
    cachedAt,
    receipt
  });
}

export function ensureStoreDirectories(root: string): {
  root: string;
  auditLogs: string;
  sourceCache: string;
  proofReceipts: string;
  watchItems: string;
} {
  const absoluteRoot = resolve(root);
  const directories = {
    root: absoluteRoot,
    auditLogs: join(absoluteRoot, "audit-logs"),
    sourceCache: join(absoluteRoot, "source-cache"),
    proofReceipts: join(absoluteRoot, "proof-receipts"),
    watchItems: join(absoluteRoot, "watch-items")
  };
  for (const directory of Object.values(directories)) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
  }
  return directories;
}

function appendJsonLine(path: string, value: unknown): void {
  appendFileSync(path, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}

function extractDocuments(data: unknown): ProposalDocument[] {
  if (!data || typeof data !== "object") {
    return [];
  }

  const maybe = data as Record<string, unknown>;
  return [maybe.document, maybe.left, maybe.right].filter(isProposalDocument);
}

function extractProofReceipt(data: unknown): ProofReceipt | undefined {
  if (!data || typeof data !== "object") {
    return undefined;
  }
  const maybe = data as Partial<ProofReceipt>;
  return typeof maybe.local_id === "string" && maybe.payload?.schema === "vennek.proof.v1" ? (maybe as ProofReceipt) : undefined;
}

function isProposalDocument(value: unknown): value is ProposalDocument {
  if (!value || typeof value !== "object") {
    return false;
  }
  const maybe = value as Partial<ProposalDocument>;
  return typeof maybe.id === "string" && typeof maybe.title === "string" && typeof maybe.body === "string" && Array.isArray(maybe.citations);
}

function safePreview(value: string, command = "", maxLength = 120): string {
  if (command === "proof") {
    return "[redacted: proof command content]";
  }

  const normalized = redactSensitive(value.replace(/\s+/g, " ").trim());
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}

function redactSensitive(value: string): string {
  const sensitivePatterns = [
    /\b(seed|recovery) phrase\b[^.\n]*/gi,
    /\b(private key|password|api key|token|secret)\b[^.\n]*/gi,
    /\b[a-z0-9]{24,}\b/gi
  ];
  return sensitivePatterns.reduce((current, pattern) => current.replace(pattern, "[redacted]"), value);
}

function safeFileName(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, "_").slice(0, 120) || "record";
}
