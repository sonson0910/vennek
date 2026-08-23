import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  canonicalJson,
  isProposalDocument,
  sha256Hex,
  type CommandAuditLogEntry,
  type CommandContext,
  type CommandResult,
  type PersistenceLimits,
  type ProofReceipt,
  type ProposalDocument,
  type SourceCacheRecord
} from "@vennek/shared";

const DEFAULT_LIMITS: PersistenceLimits = {
  auditBytes: 10 * 1024 * 1024,
  sourceFiles: 500,
  proofFiles: 500
};

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
  const limits = resolvePersistenceLimits(input.context?.persistenceLimits);

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
  appendJsonLine(join(directories.auditLogs, "commands.jsonl"), entry, limits.auditBytes);
  for (const document of extractDocuments(input.result.data)) {
    putSourceDocument(root, document, createdAt, limits);
  }
  const proof = extractProofReceipt(input.result.data);
  if (proof) {
    putProofReceipt(root, proof, createdAt, limits);
  }

  return entry;
}

export function putSourceDocument(
  root: string,
  document: ProposalDocument,
  cachedAt = new Date().toISOString(),
  persistenceLimits?: Partial<PersistenceLimits>
): SourceCacheRecord | undefined {
  const limits = resolvePersistenceLimits(persistenceLimits);
  if (!isProposalDocument(document) || !isPersistableDocument(document)) {
    return undefined;
  }

  const directories = ensureStoreDirectories(root);
  const storedDocument = sanitizeDocument(document);
  const documentHash = sha256Hex(canonicalJson(storedDocument));
  const record: SourceCacheRecord = {
    id: storedDocument.id,
    documentHash: `sha256:${documentHash}`,
    cachedAt,
    document: storedDocument
  };
  const path = join(directories.sourceCache, `${safeFileName(storedDocument.id)}-${documentHash.slice(0, 12)}.json`);
  writeJson(path, record);
  pruneRegularFiles(directories.sourceCache, limits.sourceFiles, path);
  return record;
}

export function putProofReceipt(
  root: string,
  receipt: ProofReceipt,
  cachedAt = new Date().toISOString(),
  persistenceLimits?: Partial<PersistenceLimits>
): void {
  const limits = resolvePersistenceLimits(persistenceLimits);
  const directories = ensureStoreDirectories(root);
  const path = join(directories.proofReceipts, `${safeFileName(receipt.local_id)}.json`);
  writeJson(path, {
    cachedAt,
    receipt
  });
  pruneRegularFiles(directories.proofReceipts, limits.proofFiles, path);
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
    const metadata = lstatSync(directory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error(`Persistence path must be a real directory, not a symbolic link: ${directory}`);
    }
  }
  for (const directory of Object.values(directories)) {
    chmodSync(directory, 0o700);
  }
  return directories;
}

function appendJsonLine(path: string, value: unknown, maxBytes: number): void {
  const line = `${JSON.stringify(value)}\n`;
  const incomingBytes = Buffer.byteLength(line, "utf8");
  if (incomingBytes > maxBytes) {
    throw new Error(`Serialized audit entry exceeds audit limit of ${maxBytes} bytes.`);
  }
  rotateAuditLog(path, incomingBytes, maxBytes);
  appendFileSync(path, line, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}

function rotateAuditLog(path: string, incomingBytes: number, maxBytes: number): void {
  if (!existsSync(path) || statSync(path).size + incomingBytes <= maxBytes) {
    return;
  }

  const rotated = `${path}.1`;
  if (existsSync(rotated)) {
    unlinkSync(rotated);
  }
  renameSync(path, rotated);
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}

function pruneRegularFiles(directory: string, maxFiles: number, justWrittenPath: string): void {
  const files = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => ({
      name: entry.name,
      path: join(directory, entry.name),
      mtimeMs: statSync(join(directory, entry.name)).mtimeMs
    }));

  const justWritten = files.find((file) => file.path === justWrittenPath);
  const newestOtherMtime = files.reduce((newest, file) => file.path === justWrittenPath ? newest : Math.max(newest, file.mtimeMs), -Infinity);
  if (justWritten && justWritten.mtimeMs <= newestOtherMtime) {
    const mtime = new Date(newestOtherMtime + 1);
    utimesSync(justWritten.path, mtime, mtime);
    justWritten.mtimeMs = mtime.getTime();
  }

  files.sort((left, right) => left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name));
  for (const file of files.slice(0, Math.max(0, files.length - maxFiles))) {
    unlinkSync(file.path);
  }
}

function resolvePersistenceLimits(input: Partial<PersistenceLimits> = {}): PersistenceLimits {
  const limits = { ...DEFAULT_LIMITS, ...input };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`Invalid persistence limit ${name}; expected a positive integer.`);
    }
  }
  return limits;
}

function extractDocuments(data: unknown): ProposalDocument[] {
  if (!data || typeof data !== "object") {
    return [];
  }

  const maybe = data as Record<string, unknown>;
  return [maybe.document, maybe.left, maybe.right]
    .filter(isProposalDocument)
    .filter(isPersistableDocument);
}

function isPersistableDocument(document: ProposalDocument): boolean {
  return !(document.sourceType === "user-provided" && document.url?.startsWith("user-provided:"));
}

function sanitizeDocument(document: ProposalDocument): ProposalDocument {
  return {
    ...document,
    ...(document.url === undefined ? {} : { url: redactSensitive(document.url) }),
    title: redactSensitive(document.title),
    body: redactSensitive(document.body),
    metadata: redactNestedStrings(document.metadata) as Record<string, unknown>,
    citations: document.citations.map((citation) => ({
      ...citation,
      url: redactSensitive(citation.url),
      ...(citation.title === undefined ? {} : { title: redactSensitive(citation.title) }),
      snippet: redactSensitive(citation.snippet)
    }))
  };
}

function redactNestedStrings(value: unknown): unknown {
  if (typeof value === "string") {
    return redactSensitive(value);
  }
  if (Array.isArray(value)) {
    return value.map(redactNestedStrings);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, redactNestedStrings(nested)]));
  }
  return value;
}

function extractProofReceipt(data: unknown): ProofReceipt | undefined {
  if (!data || typeof data !== "object") {
    return undefined;
  }
  const maybe = data as Partial<ProofReceipt>;
  return typeof maybe.local_id === "string" && maybe.payload?.schema === "vennek.proof.v1" ? (maybe as ProofReceipt) : undefined;
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
