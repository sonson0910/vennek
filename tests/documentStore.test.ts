import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveProposalDocument } from "@vennek/cardano-governance-skills";

const now = new Date("2026-07-04T00:00:00.000Z");

describe("document store resolution", () => {
  it("resolves fixtures only when explicitly enabled", async () => {
    await expect(resolveProposalDocument("catalyst-review-workbench", { enableFixtures: true, now })).resolves.toMatchObject({ id: "catalyst-review-workbench" });
    const fallback = await resolveProposalDocument("catalyst-review-workbench", { enableFixtures: false, now });
    expect(fallback.sourceType).toBe("user-provided");
    expect(fallback.title).toBe("catalyst-review-workbench");
  });

  it("rejects empty input", async () => {
    await expect(resolveProposalDocument("   ")).rejects.toThrow(/Missing proposal id/);
  });

  it("does not read local files unless explicitly allowed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vennek-doc-"));
    const file = join(dir, "proposal.json");
    writeFileSync(file, JSON.stringify({
      id: "local-doc",
      sourceType: "user-provided",
      title: "Local Doc",
      body: "Local body with enough text for citations",
      metadata: {},
      citations: [{ id: "L1", url: "file://local", snippet: "local snippet", retrievedAt: now.toISOString() }],
      retrievedAt: now.toISOString()
    }));

    const untrusted = await resolveProposalDocument(file, { enableFixtures: false, now });
    expect(untrusted.title).not.toBe("Local Doc");

    await expect(resolveProposalDocument(file, { allowLocalFiles: true, allowedFileRoot: tmpdir(), enableFixtures: false, now })).resolves.toMatchObject({ id: "local-doc" });
    await expect(resolveProposalDocument(file, { allowLocalFiles: true, allowedFileRoot: join(dir, "nested"), enableFixtures: false, now })).rejects.toThrow(/outside the allowed file root/);
  });
});
