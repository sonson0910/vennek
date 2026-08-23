import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
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

  it("rejects a local-file symlink before reading its outside target", async () => {
    const root = mkdtempSync(join(tmpdir(), "vennek-doc-root-"));
    const external = mkdtempSync(join(tmpdir(), "vennek-doc-external-"));
    const outside = join(external, "proposal.json");
    writeFileSync(outside, JSON.stringify(validDocument("outside-target")));
    const link = join(root, "proposal.json");
    symlinkSync(outside, link);

    await expect(resolveProposalDocument(link, {
      allowLocalFiles: true,
      allowedFileRoot: root,
      enableFixtures: false,
      now
    })).rejects.toThrow(/symbolic link/);
  });

  it("rejects a dangling local-file symlink instead of treating it as pasted text", async () => {
    const root = mkdtempSync(join(tmpdir(), "vennek-doc-root-"));
    const link = join(root, "dangling.json");
    symlinkSync(join(root, "missing.json"), link);

    await expect(resolveProposalDocument(link, {
      allowLocalFiles: true,
      allowedFileRoot: root,
      enableFixtures: false,
      now
    })).rejects.toThrow(/symbolic link/);
  });

  it("rejects a parent symlink that canonicalizes outside the allowed root", async () => {
    const root = mkdtempSync(join(tmpdir(), "vennek-doc-root-"));
    const external = mkdtempSync(join(tmpdir(), "vennek-doc-external-"));
    writeFileSync(join(external, "proposal.json"), JSON.stringify(validDocument("outside-parent")));
    symlinkSync(external, join(root, "linked"), "dir");

    await expect(resolveProposalDocument(join(root, "linked", "proposal.json"), {
      allowLocalFiles: true,
      allowedFileRoot: root,
      enableFixtures: false,
      now
    })).rejects.toThrow(/outside the allowed file root/);
  });

  it("rejects non-regular and oversized local files before parsing", async () => {
    const root = mkdtempSync(join(tmpdir(), "vennek-doc-root-"));
    const directory = join(root, "directory");
    mkdirSync(directory);
    await expect(resolveProposalDocument(directory, {
      allowLocalFiles: true,
      allowedFileRoot: root,
      enableFixtures: false,
      now
    })).rejects.toThrow(/regular file/);

    const oversized = join(root, "oversized.json");
    writeFileSync(oversized, Buffer.alloc(2 * 1024 * 1024 + 1, 120));
    await expect(resolveProposalDocument(oversized, {
      allowLocalFiles: true,
      allowedFileRoot: root,
      enableFixtures: false,
      now
    })).rejects.toThrow(/2 MiB/);
  });

  it("rejects a regular file as the allowed local-file root", async () => {
    const root = mkdtempSync(join(tmpdir(), "vennek-doc-root-"));
    const file = join(root, "proposal.json");
    writeFileSync(file, JSON.stringify(validDocument("root-file")));

    await expect(resolveProposalDocument(file, {
      allowLocalFiles: true,
      allowedFileRoot: file,
      enableFixtures: false,
      now
    })).rejects.toThrow(/allowed file root.*directory/i);
  });

  it("does not use the allowed root directory itself as a local document", async () => {
    const root = mkdtempSync(join(tmpdir(), "vennek-doc-root-"));

    await expect(resolveProposalDocument(root, {
      allowLocalFiles: true,
      allowedFileRoot: root,
      enableFixtures: false,
      now
    })).rejects.toThrow(/regular file inside the allowed file root/);
  });

  it.each([
    ["missing fields", { id: "missing-fields" }],
    ["bad source type", { ...validDocument("bad-source"), sourceType: "unknown" }],
    ["single-file array", [validDocument("array-document")]],
    ["malformed citation", { ...validDocument("bad-citation"), citations: [{ id: "C1" }] }],
    ["malformed metadata", { ...validDocument("bad-metadata"), metadata: [] }]
  ])("rejects local files with %s as Invalid ProposalDocument", async (_name, content) => {
    const root = mkdtempSync(join(tmpdir(), "vennek-doc-root-"));
    const file = join(root, "proposal.json");
    writeFileSync(file, JSON.stringify(content));

    await expect(resolveProposalDocument(file, {
      allowLocalFiles: true,
      allowedFileRoot: root,
      enableFixtures: false,
      now
    })).rejects.toThrow(/Invalid ProposalDocument/);
  });
});

function validDocument(id: string) {
  return {
    id,
    sourceType: "user-provided",
    title: "Local document",
    body: "Local body",
    metadata: {},
    citations: [],
    retrievedAt: now.toISOString()
  };
}
