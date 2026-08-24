import { timingSafeEqual } from "node:crypto";

export const PDF_EXTRACTOR_PATH = "/v1/extract/pdf";
export const PDF_EXTRACTOR_HEALTH_PATH = "/health";
export const PDF_MAX_INPUT_BYTES = 8 * 1024 * 1024;
export const PDF_MAX_OUTPUT_CHARS = 2_000_000;
export const PDF_MAX_WIRE_RESPONSE_BYTES = 8 * 1024 * 1024;
export const PDF_MAX_TITLE_CHARS = 512;
export const PDF_SERVER_TIMEOUT_MS = 15_000;
export const PDF_CLIENT_TIMEOUT_MS = 18_000;

export type PdfExtractionResult = {
  title: string;
  text: string;
};

export class PdfExtractorError extends Error {
  readonly statusCode?: number;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = "PdfExtractorError";
    this.statusCode = statusCode;
  }
}

export function decodePdfExtractorToken(token: string): Buffer | undefined {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
  const bytes = Buffer.from(token, "base64url");
  if (bytes.byteLength !== 32) return undefined;
  return bytes;
}

export function isValidPdfExtractorToken(token: string): boolean {
  return decodePdfExtractorToken(token) !== undefined;
}

export function tokenMatches(expectedToken: string, actualToken: string): boolean {
  const expected = decodePdfExtractorToken(expectedToken);
  const actual = decodePdfExtractorToken(actualToken);
  const safeExpected = expected ?? Buffer.alloc(32);
  const safeActual = actual ?? Buffer.alloc(32);
  const equal = timingSafeEqual(safeExpected, safeActual);
  return expected !== undefined && actual !== undefined && equal;
}

export function validatePdfExtractionResult(value: unknown): PdfExtractionResult {
  if (value === null || typeof value !== "object") {
    throw new PdfExtractorError("Malformed extractor output", 422);
  }
  const record = value as Record<string, unknown>;
  if (typeof record.title !== "string" || record.title.length > PDF_MAX_TITLE_CHARS) {
    throw new PdfExtractorError("Malformed extractor output", 422);
  }
  if (typeof record.text !== "string" || record.text.length === 0 || record.text.length > PDF_MAX_OUTPUT_CHARS) {
    throw new PdfExtractorError("Malformed extractor output", 422);
  }
  return { title: record.title, text: record.text };
}

export function validatePdfInput(bytes: Uint8Array): void {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > PDF_MAX_INPUT_BYTES) {
    throw new PdfExtractorError("PDF body must be between 1 byte and 8 MiB", 413);
  }
}

