import { describe, expect, it } from "vitest";
import { canonicalJson, createCitation, hasUsableCitations, sha256Hex, sha256Uri } from "@vennek/shared";

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
});
