import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex, type ProposalDocument } from "@vennek/shared";
import { routeTelegramCommand } from "@vennek/telegram-bot";
import { ensureStoreDirectories, putSourceDocument } from "@vennek/cardano-governance-skills";

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

  it("recursively redacts public source fields without mutating the source object", () => {
    const root = mkdtempSync(join(tmpdir(), "vennek-store-"));
    const document: ProposalDocument = {
      id: "public-sensitive-source",
      sourceType: "user-provided",
      url: "https://example.com/public-source",
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

    const cacheFile = readdirSync(join(root, "source-cache"))[0];
    const cached = JSON.parse(readFileSync(join(root, "source-cache", cacheFile), "utf8"));
    const serialized = JSON.stringify(cached.document);
    for (const secret of [
      "TITLE_REVIEW_SECRET",
      "BODY_REVIEW_SECRET",
      "METADATA_REVIEW_SECRET",
      "PRIVATE_REVIEW_SECRET",
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
});

function statMode(path: string): string {
  return (statSync(path).mode & 0o777).toString(8);
}

function readAllFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? readAllFiles(path) : [readFileSync(path, "utf8")];
  });
}
