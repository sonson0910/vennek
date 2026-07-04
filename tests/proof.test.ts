import { describe, expect, it } from "vitest";
import { createProofPayload, proofCommand, verifyExternalTxHash } from "@vennek/cardano-governance-skills";
import { validateOutput } from "@vennek/cardano-governance-skills";

describe("proof payload", () => {
  it("creates payload-only metadata with no transaction submission", () => {
    const receipt = createProofPayload({
      text: "governance rationale",
      sourceRefs: ["https://example.com/source"],
      now: new Date("2026-07-04T00:00:00.000Z")
    });

    expect(receipt.status).toBe("payload-only");
    expect(receipt.payload.schema).toBe("vennek.proof.v1");
    expect(receipt.payload.content_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(receipt.payload.source_refs).toEqual(["https://example.com/source"]);
  });

  it("validates external tx hash format without signing", () => {
    expect(verifyExternalTxHash("a".repeat(64))).toBe("pending-external-verification");
    expect(verifyExternalTxHash("not-a-hash")).toBe("failed");
  });

  it("/proof output stays source-unavailable and payload-only", () => {
    const result = proofCommand("example rationale", new Date("2026-07-04T00:00:00.000Z"));
    expect(result.text).toContain("Proof payload only");
    expect(result.text).toContain("Source unavailable");
    expect(result.text).not.toMatch(/wallet|connector|seed phrase|private key/i);
    expect(validateOutput(result)).toEqual([]);
  });
});
