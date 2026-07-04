import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { routeTelegramCommand } from "@vennek/telegram-bot";
import { ensureStoreDirectories } from "@vennek/cardano-governance-skills";

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
