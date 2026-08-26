import { findWalletSecret } from "../security/walletSecrets.js";

export const PRIVATE_DOCUMENT_MAX_BYTES = 20 * 1024 * 1024;
export const PRIVATE_DOCUMENT_MAX_CODE_POINTS = 2_000_000;
export const PRIVATE_DOCUMENT_MAX_TEXT_BYTES = 8_000_000;
export const PRIVATE_DOCUMENT_PATH = "/v1/extract/private-document";
export const PRIVATE_DOCUMENT_TIMEOUT_MS = 30_000;
const PRIVATE_DOCUMENT_MAX_TITLE_CODE_POINTS = 300;

export type PrivateDocumentType = "pdf" | "docx" | "text" | "markdown";
export type PrivateDocumentFailureCategory = "unsafe" | "spoofed" | "unsupported" | "text-unavailable";
export type PrivateExtractionResult = Readonly<{
  type: PrivateDocumentType;
  title: string;
  text: string;
}>;

export class PrivateDocumentExtractionError extends Error {
  constructor(readonly category: PrivateDocumentFailureCategory, message: string) {
    super(message);
    this.name = "PrivateDocumentExtractionError";
  }
}

const PRIVATE_DOCUMENT_TYPES = new Set<PrivateDocumentType>(["pdf", "docx", "text", "markdown"]);
const PRIVATE_DOCUMENT_RESULT_KEYS = ["type", "title", "text"];
const PRIVATE_DOCUMENT_FAILURE_CATEGORIES = new Set<PrivateDocumentFailureCategory>([
  "unsafe",
  "spoofed",
  "unsupported",
  "text-unavailable",
]);
const WALLET_SCAN_WINDOW = 32_768;
const WALLET_SCAN_STEP = WALLET_SCAN_WINDOW / 2;
const WALLET_SCAN_FIELD_CARRY = 128;
const SIGNING_KEY_TYPE_FIELD = /["']?type["']?\s*:\s*["']([^"']+)["']/gi;
const KEY_MATERIAL_FIELD = /["']?(?:cborhex|bytes)["']?\s*:\s*["']/i;

export function validatePrivateDocumentToken(value: unknown): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value)) {
    throw new Error("Private extractor token is invalid");
  }
  const token = Buffer.from(value, "base64url");
  if (token.byteLength !== 32 || token.toString("base64url") !== value) {
    throw new Error("Private extractor token is invalid");
  }
  return token;
}

export function isPrivateDocumentFailureCategory(value: unknown): value is PrivateDocumentFailureCategory {
  return typeof value === "string" && PRIVATE_DOCUMENT_FAILURE_CATEGORIES.has(value as PrivateDocumentFailureCategory);
}

export function classifyPrivateDocumentError(value: unknown): PrivateDocumentFailureCategory | undefined {
  if (value !== null && typeof value === "object" && "category" in value && isPrivateDocumentFailureCategory((value as { category?: unknown }).category)) {
    return (value as { category: PrivateDocumentFailureCategory }).category;
  }
  const message = value instanceof Error ? value.message : "";
  if (/Unsafe document|wallet|active annotation|action/u.test(message)) return "unsafe";
  if (/spoofed|type mismatch/u.test(message)) return "unsupported";
  if (/page limit|Text unavailable/u.test(message)) return "text-unavailable";
  return undefined;
}

export function validatePrivateExtractionResult(value: unknown): PrivateExtractionResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Private extractor output is invalid");
  }
  const record = value as Record<string, unknown>;
  if (
    Reflect.ownKeys(record).length !== PRIVATE_DOCUMENT_RESULT_KEYS.length ||
    PRIVATE_DOCUMENT_RESULT_KEYS.some((key) => !Object.hasOwn(record, key))
  ) {
    throw new Error("Private extractor output is invalid");
  }

  const { type, title, text } = record;
  if (
    typeof type !== "string" || !PRIVATE_DOCUMENT_TYPES.has(type as PrivateDocumentType) ||
    typeof title !== "string" || !isSafeTitle(title) ||
    typeof text !== "string" || !isSafeText(text)
  ) {
    throw new Error("Private extractor output is invalid");
  }

  return Object.freeze({
    type: type as PrivateDocumentType,
    title,
    text,
  });
}

function isSafeTitle(value: string): boolean {
  const codePoints = countUnicodeCodePoints(value, PRIVATE_DOCUMENT_MAX_TITLE_CODE_POINTS);
  return (
    value.trim().length > 0 &&
    codePoints !== undefined &&
    !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) &&
    !hasWalletSecret(value)
  );
}

function isSafeText(value: string): boolean {
  const codePoints = countUnicodeCodePoints(value, PRIVATE_DOCUMENT_MAX_CODE_POINTS);
  if (
    value.trim().length === 0 ||
    codePoints === undefined ||
    Buffer.byteLength(value, "utf8") > PRIVATE_DOCUMENT_MAX_TEXT_BYTES
  ) {
    return false;
  }
  return !hasWalletSecret(value);
}

function countUnicodeCodePoints(value: string, maximum: number): number | undefined {
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return undefined;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return undefined;
    }
    count += 1;
    if (count > maximum) return undefined;
  }
  return count;
}

function hasWalletSecret(value: string): boolean {
  if (value.length <= WALLET_SCAN_WINDOW) return findWalletSecret(value) !== undefined;
  let signingKeyTypeSeen = false;
  let keyMaterialSeen = false;
  let carry = "";
  for (let start = 0; start < value.length; start += WALLET_SCAN_STEP) {
    const chunk = value.slice(start, start + WALLET_SCAN_WINDOW);
    if (findWalletSecret(chunk) !== undefined) return true;

    const fieldScan = carry + chunk;
    signingKeyTypeSeen ||= hasSigningKeyType(fieldScan);
    keyMaterialSeen ||= KEY_MATERIAL_FIELD.test(fieldScan);
    if (signingKeyTypeSeen && keyMaterialSeen) return true;
    carry = chunk.slice(-WALLET_SCAN_FIELD_CARRY);
  }
  return false;
}

function hasSigningKeyType(value: string): boolean {
  for (const match of value.matchAll(SIGNING_KEY_TYPE_FIELD)) {
    const type = match[1]!.toLowerCase();
    if (type.includes("signingkey") && type.includes("ed25519")) return true;
  }
  return false;
}
