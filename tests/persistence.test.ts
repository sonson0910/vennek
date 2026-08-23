import { existsSync, readFileSync, readdirSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex, type ProofReceipt, type ProposalDocument } from "@vennek/shared";
import { routeTelegramCommand } from "@vennek/telegram-bot";
import { ensureStoreDirectories, persistCommandResult, putProofReceipt, putSourceDocument } from "@vennek/cardano-governance-skills";

const now = new Date("2026-07-04T00:00:00.000Z");

describe("file-backed persistence", () => {
  it("creates durable store directories", () => {
    const root = mkdtempSync(join(tmpdir(), "vennek-store-"));
    const directories = ensureStoreDirectories(root);
    expect(existsSync(directories.auditLogs)).toBe(true);
    expect(existsSync(directories.sourceCache)).toBe(true);
    expect(existsSync(directories.proofReceipts)).toBe(true);
    expect(existsSync(directories.watchItems)).toBe(true);
    expect(statMode(directories.auditLogs)).toBe("700");
  });

  it("persists command audit logs and source cache without raw full output dependency", async () => {
    const root = mkdtempSync(join(tmpdir(), "vennek-store-"));
    await routeTelegramCommand("/proposal catalyst-review-workbench", { persistenceRoot: root, enableFixtures: true, now });

    const auditLog = readFileSync(join(root, "audit-logs", "commands.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(auditLog).toHaveLength(1);
    expect(auditLog[0]).toMatchObject({ command: "proposal", ok: true, sourceStatus: "available" });
    expect(auditLog[0].inputHash).toMatch(/^sha256:/);
    expect(auditLog[0].outputHash).toMatch(/^sha256:/);
    expect(statMode(join(root, "audit-logs", "commands.jsonl"))).toBe("600");

    const cacheFiles = readdirSync(join(root, "source-cache"));
    expect(cacheFiles.length).toBeGreaterThan(0);
    const cached = JSON.parse(readFileSync(join(root, "source-cache", cacheFiles[0]), "utf8"));
    expect(cached.document.title).toBe("Catalyst Reviewer Workbench");
  });

  it("does not persist pasted proposal text in the source cache", async () => {
    const root = mkdtempSync(join(tmpdir(), "vennek-store-"));
    const pasted = `${"Project rationale and milestones. ".repeat(20)}password=REVIEW_SECRET_SENTINEL`;

    await routeTelegramCommand(`/proposal ${pasted}`, { persistenceRoot: root, enableFixtures: false, now });

    expect(readdirSync(join(root, "source-cache"))).toHaveLength(0);
    expect(readAllFiles(root).join("\n")).not.toContain("REVIEW_SECRET_SENTINEL");
  });

  it("does not persist pasted documents through the direct source sink", () => {
    const root = mkdtempSync(join(tmpdir(), "vennek-store-"));
    const directories = ensureStoreDirectories(root);
    const document: ProposalDocument = {
      id: "direct-pasted-source",
      sourceType: "user-provided",
      url: "user-provided:direct-pasted-source",
      title: "Pasted password=DIRECT_REVIEW_SECRET_SENTINEL",
      body: "Pasted password=DIRECT_REVIEW_SECRET_SENTINEL",
      metadata: {},
      citations: [],
      retrievedAt: now.toISOString()
    };

    const record = putSourceDocument(root, document, now.toISOString());

    expect(record).toBeUndefined();
    expect(readdirSync(directories.sourceCache)).toHaveLength(0);
    expect(readAllFiles(root).join("\n")).not.toContain("DIRECT_REVIEW_SECRET_SENTINEL");
  });

  it("does not persist structurally malformed documents through the direct source sink", () => {
    const root = mkdtempSync(join(tmpdir(), "vennek-store-"));

    const record = putSourceDocument(root, {
      ...sourceDocument("malformed-source"),
      sourceType: "not-a-source" as ProposalDocument["sourceType"]
    });

    expect(record).toBeUndefined();
    expect(existsSync(join(root, "source-cache"))).toBe(false);
  });

  it("recursively redacts public source fields without mutating the source object", () => {
    const root = mkdtempSync(join(tmpdir(), "vennek-store-"));
    const document: ProposalDocument = {
      id: "public-sensitive-source",
      sourceType: "user-provided",
      url: "https://example.com/source?token=URL_REVIEW_SECRET_SENTINEL",
      title: "Public title password=TITLE_REVIEW_SECRET",
      body: "Public body token=BODY_REVIEW_SECRET",
      metadata: {
        nested: ["metadata secret=METADATA_REVIEW_SECRET", { deeper: "private key=PRIVATE_REVIEW_SECRET" }]
      },
      citations: [
        {
          id: "S1",
          url: "https://example.com/public-source?password=CITATION_URL_REVIEW_SECRET",
          title: "Citation api key=CITATION_TITLE_REVIEW_SECRET",
          snippet: "Citation snippet token=CITATION_SNIPPET_REVIEW_SECRET",
          retrievedAt: now.toISOString()
        }
      ],
      retrievedAt: now.toISOString()
    };
    const original = structuredClone(document);

    const record = putSourceDocument(root, document, now.toISOString());
    if (!record) {
      throw new Error("Expected public source document to be persisted");
    }

    const cacheFile = readdirSync(join(root, "source-cache"))[0];
    const cached = JSON.parse(readFileSync(join(root, "source-cache", cacheFile), "utf8"));
    const serialized = JSON.stringify(cached.document);
    for (const secret of [
      "TITLE_REVIEW_SECRET",
      "BODY_REVIEW_SECRET",
      "METADATA_REVIEW_SECRET",
      "PRIVATE_REVIEW_SECRET",
      "URL_REVIEW_SECRET_SENTINEL",
      "CITATION_URL_REVIEW_SECRET",
      "CITATION_TITLE_REVIEW_SECRET",
      "CITATION_SNIPPET_REVIEW_SECRET"
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(document).toEqual(original);
    expect(record.documentHash).toBe(`sha256:${sha256Hex(canonicalJson(cached.document))}`);
  });

  it("persists proof receipts separately and redacts proof previews", async () => {
    const root = mkdtempSync(join(tmpdir(), "vennek-store-"));
    await routeTelegramCommand("/proof secret recovery phrase alpha beta gamma", { persistenceRoot: root, now });
    const receipts = readdirSync(join(root, "proof-receipts"));
    expect(receipts).toHaveLength(1);
    const proof = JSON.parse(readFileSync(join(root, "proof-receipts", receipts[0]), "utf8"));
    expect(proof.receipt.payload.schema).toBe("vennek.proof.v1");

    const auditLog = readFileSync(join(root, "audit-logs", "commands.jsonl"), "utf8");
    expect(auditLog).toContain("[redacted: proof command content]");
    expect(auditLog).not.toContain("alpha beta gamma");
  });

  it("does not fail valid command responses when persistence fails", async () => {
    const result = await routeTelegramCommand("/proof governance rationale text", { persistenceRoot: "/dev/null", now });
    expect(result.ok).toBe(true);
    expect(result.command).toBe("proof");
  });

  it("rotates audit logs and keeps the current entry valid", async () => {
    const root = mkdtempSync(join(tmpdir(), "vennek-store-"));
    const context = { persistenceRoot: root, persistenceLimits: { auditBytes: 700 } };

    for (let index = 0; index < 4; index += 1) {
      await routeTelegramCommand(`/proof audit-entry-${index}`, { ...context, now });
    }

    const auditDirectory = join(root, "audit-logs");
    expect(readdirSync(auditDirectory).sort()).toEqual(["commands.jsonl", "commands.jsonl.1"]);
    const currentLines = readFileSync(join(auditDirectory, "commands.jsonl"), "utf8").trim().split("\n");
    expect(currentLines).toHaveLength(1);
    expect(() => JSON.parse(currentLines[0])).not.toThrow();
  });

  it("keeps only the newest source cache files", () => {
    const root = mkdtempSync(join(tmpdir(), "vennek-store-"));

    for (let index = 0; index < 4; index += 1) {
      const record = putSourceDocument(root, sourceDocument(`source-${index}`), now.toISOString(), { sourceFiles: 2 });
      expect(record).toBeDefined();
    }

    const files = readdirSync(join(root, "source-cache"));
    expect(files).toHaveLength(2);
    expect(files.map((file) => JSON.parse(readFileSync(join(root, "source-cache", file), "utf8")).document.id).sort()).toEqual(["source-2", "source-3"]);
  });

  it("keeps only the newest proof receipt files", () => {
    const root = mkdtempSync(join(tmpdir(), "vennek-store-"));

    for (let index = 0; index < 4; index += 1) {
      putProofReceipt(root, proofReceipt(`proof-${index}`), now.toISOString(), { proofFiles: 2 });
    }

    const files = readdirSync(join(root, "proof-receipts"));
    expect(files).toHaveLength(2);
    expect(files.map((file) => JSON.parse(readFileSync(join(root, "proof-receipts", file), "utf8")).receipt.local_id).sort()).toEqual(["proof-2", "proof-3"]);
  });

  it("rejects invalid persistence limits before creating the target store", () => {
    const invalidValues = [0, -1, 1.5, Number.NaN];

    for (const value of invalidValues) {
      const sourceRoot = mkdtempSync(join(tmpdir(), "vennek-store-"));
      expect(() => putSourceDocument(sourceRoot, sourceDocument("invalid-source"), now.toISOString(), { sourceFiles: value })).toThrow();
      expect(existsSync(join(sourceRoot, "source-cache"))).toBe(false);

      const proofRoot = mkdtempSync(join(tmpdir(), "vennek-store-"));
      expect(() => putProofReceipt(proofRoot, proofReceipt("invalid-proof"), now.toISOString(), { proofFiles: value })).toThrow();
      expect(existsSync(join(proofRoot, "proof-receipts"))).toBe(false);
    }
  });

  it("rejects a symlinked source cache without touching its target", () => {
    const root = mkdtempSync(join(tmpdir(), "vennek-store-"));
    const external = mkdtempSync(join(tmpdir(), "vennek-external-"));
    const victim = join(external, "victim.json");
    writeFileSync(victim, "keep me");
    utimesSync(victim, new Date(0), new Date(0));
    symlinkSync(external, join(root, "source-cache"), "dir");

    expect(() => putSourceDocument(root, sourceDocument("symlink-source"), now.toISOString(), { sourceFiles: 1 })).toThrow(/symbolic link/);
    expect(readFileSync(victim, "utf8")).toBe("keep me");
  });

  it("rejects a symlinked proof receipt directory without touching its target", () => {
    const root = mkdtempSync(join(tmpdir(), "vennek-store-"));
    const external = mkdtempSync(join(tmpdir(), "vennek-external-"));
    const victim = join(external, "victim.json");
    writeFileSync(victim, "keep me");
    utimesSync(victim, new Date(0), new Date(0));
    symlinkSync(external, join(root, "proof-receipts"), "dir");

    expect(() => putProofReceipt(root, proofReceipt("symlink-proof"), now.toISOString(), { proofFiles: 1 })).toThrow(/symbolic link/);
    expect(readFileSync(victim, "utf8")).toBe("keep me");
  });

  it("rejects an oversized audit entry before writing or rotating files", () => {
    const root = mkdtempSync(join(tmpdir(), "vennek-store-"));
    const result = {
      command: "proof",
      ok: true,
      text: "oversized output ".repeat(100),
      citations: [],
      sourceStatus: "available" as const,
      warnings: []
    };

    expect(() => persistCommandResult({
      rawInput: "/proof oversized",
      result,
      context: { persistenceRoot: root, persistenceLimits: { auditBytes: 1 } },
      now
    })).toThrow(/exceeds audit limit/);
    expect(existsSync(join(root, "audit-logs", "commands.jsonl"))).toBe(false);
    expect(existsSync(join(root, "audit-logs", "commands.jsonl.1"))).toBe(false);
  });
});

function sourceDocument(id: string): ProposalDocument {
  return {
    id,
    sourceType: "catalyst",
    url: `https://example.com/${id}`,
    title: id,
    body: `Body for ${id}`,
    metadata: {},
    citations: [],
    retrievedAt: now.toISOString()
  };
}

function proofReceipt(localId: string): ProofReceipt {
  return {
    local_id: localId,
    status: "payload-only",
    payload: {
      schema: "vennek.proof.v1",
      content_hash: `hash-${localId}`,
      source_refs: [],
      created_at: now.toISOString(),
      agent_version: "test"
    }
  };
}

function statMode(path: string): string {
  return (statSync(path).mode & 0o777).toString(8);
}

function readAllFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? readAllFiles(path) : [readFileSync(path, "utf8")];
  });
}
