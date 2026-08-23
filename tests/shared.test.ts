import { describe, expect, it } from "vitest";
import { canonicalJson, createCitation, hasUsableCitations, isProposalDocument, sha256Hex, sha256Uri } from "@vennek/shared";

describe("shared utilities", () => {
  it("computes stable SHA-256 hashes", () => {
    expect(sha256Hex("vennek")).toHaveLength(64);
    expect(sha256Uri("vennek")).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("canonicalizes object key order", () => {
    expect(canonicalJson({ b: 2, a: 1 })).toBe(canonicalJson({ a: 1, b: 2 }));
  });

  it("detects usable citations", () => {
    const citation = createCitation({
      id: "T1",
      url: "https://example.com",
      snippet: "A useful source snippet",
      retrievedAt: "2026-07-04T00:00:00.000Z"
    });
    expect(hasUsableCitations([citation])).toBe(true);
    expect(hasUsableCitations([])).toBe(false);
  });

  it("accepts only structurally valid proposal documents", () => {
    const document = {
      id: "proposal-1",
      sourceType: "user-provided",
      url: "https://example.com/proposal-1",
      title: "Proposal",
      body: "Body",
      metadata: {},
      citations: [createCitation({
        id: "C1",
        url: "https://example.com/source",
        snippet: "Snippet",
        retrievedAt: "2026-07-04T00:00:00.000Z"
      })],
      retrievedAt: "2026-07-04T00:00:00.000Z"
    };

    expect(isProposalDocument(document)).toBe(true);
    expect(isProposalDocument({ ...document, sourceType: "other" })).toBe(false);
    expect(isProposalDocument({ ...document, metadata: null })).toBe(false);
    expect(isProposalDocument({ ...document, citations: [{ ...document.citations[0], retrievedAt: 1 }] })).toBe(false);
    expect(isProposalDocument({ ...document, citations: [{ id: "C1" }] })).toBe(false);
    expect(isProposalDocument([document])).toBe(false);
  });
});
