import { describe, expect, it } from "vitest";
import {
  PRIVATE_DOCUMENT_MAX_BYTES,
  PRIVATE_DOCUMENT_MAX_CODE_POINTS,
  PRIVATE_DOCUMENT_MAX_TEXT_BYTES,
  PRIVATE_DOCUMENT_PATH,
  PRIVATE_DOCUMENT_TIMEOUT_MS,
  validatePrivateDocumentToken,
  validatePrivateExtractionResult,
} from "@vennek/cardano-agent";

describe("private document protocol", () => {
  it("pins the transport limits and endpoint", () => {
    expect(PRIVATE_DOCUMENT_MAX_BYTES).toBe(20 * 1024 * 1024);
    expect(PRIVATE_DOCUMENT_MAX_CODE_POINTS).toBe(2_000_000);
    expect(PRIVATE_DOCUMENT_MAX_TEXT_BYTES).toBe(8_000_000);
    expect(PRIVATE_DOCUMENT_PATH).toBe("/v1/extract/private-document");
    expect(PRIVATE_DOCUMENT_TIMEOUT_MS).toBe(30_000);
  });

  it("accepts the exact Unicode output boundary and returns a frozen exact result", () => {
    const text = "😀".repeat(PRIVATE_DOCUMENT_MAX_CODE_POINTS);
    const result = validatePrivateExtractionResult({ type: "text", title: "a.md", text });

    expect(result).toEqual({ type: "text", title: "a.md", text });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.keys(result)).toEqual(["type", "title", "text"]);
  });

  it("rejects output beyond either Unicode or UTF-8 boundary", () => {
    expect(() => validatePrivateExtractionResult({
      type: "text",
      title: "x",
      text: "a".repeat(PRIVATE_DOCUMENT_MAX_CODE_POINTS + 1),
    })).toThrow();
    expect(() => validatePrivateExtractionResult({
      type: "text",
      title: "x",
      text: "😀".repeat(PRIVATE_DOCUMENT_MAX_TEXT_BYTES / 4 + 1),
    })).toThrow();
  });

  it("requires a canonical 32-byte base64url service token", () => {
    const token = Buffer.alloc(32, 7).toString("base64url");
    expect(validatePrivateDocumentToken(token)).toEqual(Buffer.alloc(32, 7));
    for (const value of ["short", `${token}=`, token.replace(/B/, "+"), `${token.slice(0, -1)}d`]) {
      expect(() => validatePrivateDocumentToken(value)).toThrow();
    }
  });

  it("accepts each supported document type and rejects extra or unsupported fields", () => {
    for (const type of ["pdf", "docx", "text", "markdown"] as const) {
      expect(validatePrivateExtractionResult({ type, title: "safe title", text: "Cardano" }).type).toBe(type);
    }
    for (const value of [
      { type: "spreadsheet", title: "safe", text: "Cardano" },
      { type: "text", title: "safe", text: "Cardano", extra: true },
      { type: "text", title: "", text: "Cardano" },
      { type: "text", title: "\n", text: "Cardano" },
      { type: "text", title: "x".repeat(301), text: "Cardano" },
      { type: "text", title: "safe", text: "" },
      { type: "text", title: "safe", text: "\ud800" },
      null,
      [],
    ]) {
      expect(() => validatePrivateExtractionResult(value)).toThrow();
    }
  });

  it("rejects wallet secrets in extracted output", () => {
    const mnemonic = Array.from({ length: 11 }, () => "abandon").concat("about").join(" ");
    expect(() => validatePrivateExtractionResult({ type: "text", title: "safe", text: mnemonic })).toThrow();
    expect(() => validatePrivateExtractionResult({
      type: "text",
      title: "safe",
      text: '{"type":"PaymentSigningKeyShelley_ed25519","cborHex":"5820abcdef"}',
    })).toThrow();
  });
});
