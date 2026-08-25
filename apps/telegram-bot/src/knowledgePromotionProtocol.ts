import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { findWalletSecret } from "@vennek/cardano-agent";

export const KNOWLEDGE_PROMOTION_PATH = "/internal/knowledge/promote";
export const KNOWLEDGE_PROMOTION_MAX_BODY_BYTES = 64 * 1024;
export const KNOWLEDGE_PROMOTION_MAX_QUERY_CODE_POINTS = 4_096;
export const KNOWLEDGE_PROMOTION_MAX_QUERY_BYTES = 16 * 1024;
export const KNOWLEDGE_PROMOTION_CLOCK_SKEW_SECONDS = 60;

export type PromotionIdentity = Readonly<{
  keyId: string;
  key: Buffer;
}>;

export type AuthenticatedPromotion = Readonly<{
  requestId: string;
  nonceDigest: Buffer;
}>;

export type SignedPromotionQuestion = Readonly<{
  body: string;
  headers: Readonly<Record<string, string>>;
}>;

export type PromotionSigningOptions = Readonly<{
  now?: Date;
  requestId?: string;
  nonce?: Uint8Array;
}>;

export type PromotionAuthenticationInput = Readonly<{
  method: string;
  path: string;
  headers: Headers;
  body: Buffer;
  identity: PromotionIdentity;
  now?: Date;
}>;

const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const KEY_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/u;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const PROMOTION_SECURITY_HEADERS = new Set([
  "x-vennek-key-id",
  "x-vennek-request-id",
  "x-vennek-timestamp",
  "x-vennek-nonce",
  "x-vennek-signature",
]);

export function validatePromotionQuestion(value: unknown): string {
  if (typeof value !== "string") throw new Error("Promotion question is invalid.");
  const question = value.normalize("NFC").trim();
  if (
    question.length === 0 ||
    Array.from(question).length > KNOWLEDGE_PROMOTION_MAX_QUERY_CODE_POINTS ||
    Buffer.byteLength(question, "utf8") > KNOWLEDGE_PROMOTION_MAX_QUERY_BYTES ||
    /[\p{Cc}\p{Cs}]/u.test(question) ||
    /\bsite\s*:/iu.test(question) ||
    findWalletSecret(question) !== undefined
  ) {
    throw new Error("Promotion question is invalid.");
  }
  return question;
}

export function parsePromotionIdentity(keyIdValue: unknown, keyValue: unknown): PromotionIdentity {
  if (typeof keyIdValue !== "string" || !KEY_ID_PATTERN.test(keyIdValue)) {
    throw new Error("Knowledge promotion key ID is invalid.");
  }
  if (
    typeof keyValue !== "string" ||
    !BASE64_PATTERN.test(keyValue) ||
    keyValue.length % 4 !== 0
  ) {
    throw new Error("Knowledge promotion key must be canonical base64.");
  }
  const key = Buffer.from(keyValue, "base64");
  if (key.byteLength !== 32 || key.toString("base64") !== keyValue) {
    throw new Error("Knowledge promotion key must decode to 32 bytes.");
  }
  return Object.freeze({ keyId: keyIdValue, key: Buffer.from(key) });
}

export function parsePromotionOrigin(value: unknown): URL {
  let origin: URL;
  try {
    if (value instanceof URL) origin = new URL(value.href);
    else if (typeof value === "string") origin = new URL(value);
    else throw new TypeError("origin");
  } catch {
    throw new Error("Knowledge promotion origin is invalid.");
  }
  if (
    (origin.protocol !== "http:" && origin.protocol !== "https:") ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  ) {
    throw new Error("Knowledge promotion origin is invalid.");
  }
  return origin;
}

export function signPromotionQuestion(
  value: unknown,
  identity: PromotionIdentity,
  options: PromotionSigningOptions = {},
): SignedPromotionQuestion {
  const question = validatePromotionQuestion(value);
  const checkedIdentity = copyPromotionIdentity(identity);
  const now = options.now ?? new Date();
  const timestamp = unixSeconds(now);
  const requestId = options.requestId ?? randomUUID();
  if (!REQUEST_ID_PATTERN.test(requestId)) throw new Error("Knowledge promotion request ID is invalid.");
  const nonce = options.nonce === undefined ? randomBytes(16) : Buffer.from(options.nonce);
  if (nonce.byteLength !== 16) throw new Error("Knowledge promotion nonce is invalid.");
  const nonceText = encodeBase64Url(nonce);
  const body = Buffer.from(JSON.stringify({ question }), "utf8");
  const signature = createHmac("sha256", checkedIdentity.key)
    .update(canonicalSignature({
      keyId: checkedIdentity.keyId,
      requestId,
      timestamp: String(timestamp),
      nonce: nonceText,
      body,
    }))
    .digest("base64url");
  return {
    body: body.toString("utf8"),
    headers: {
      "Content-Type": "application/json",
      "X-Vennek-Key-Id": checkedIdentity.keyId,
      "X-Vennek-Request-Id": requestId,
      "X-Vennek-Timestamp": String(timestamp),
      "X-Vennek-Nonce": nonceText,
      "X-Vennek-Signature": signature,
    },
  };
}

export function authenticatePromotionRequest(input: PromotionAuthenticationInput): AuthenticatedPromotion {
  const identity = copyPromotionIdentity(input.identity);
  if (input.method !== "POST" || input.path !== KNOWLEDGE_PROMOTION_PATH) {
    throw new Error("Knowledge promotion request is invalid.");
  }
  if (!(input.body instanceof Buffer)) throw new Error("Knowledge promotion request is invalid.");
  if (input.headers.get("content-type") !== "application/json") {
    throw new Error("Knowledge promotion request is invalid.");
  }
  const keyId = requiredHeader(input.headers, "x-vennek-key-id");
  const requestId = requiredHeader(input.headers, "x-vennek-request-id");
  const timestampText = requiredHeader(input.headers, "x-vennek-timestamp");
  const nonceText = requiredHeader(input.headers, "x-vennek-nonce");
  const signatureText = requiredHeader(input.headers, "x-vennek-signature");
  for (const [name] of input.headers) {
    if (name.startsWith("x-vennek-") && !PROMOTION_SECURITY_HEADERS.has(name)) {
      throw new Error("Knowledge promotion request is invalid.");
    }
  }
  if (keyId !== identity.keyId || !KEY_ID_PATTERN.test(keyId) || !REQUEST_ID_PATTERN.test(requestId)) {
    throw new Error("Knowledge promotion request is invalid.");
  }
  const timestamp = parseUnixSeconds(timestampText);
  const now = unixSeconds(input.now ?? new Date());
  if (Math.abs(now - timestamp) > KNOWLEDGE_PROMOTION_CLOCK_SKEW_SECONDS) {
    throw new Error("Knowledge promotion request is invalid.");
  }
  const nonce = decodeBase64Url(nonceText, 16);
  const signature = decodeBase64Url(signatureText, 32);
  const expected = createHmac("sha256", identity.key)
    .update(canonicalSignature({
      keyId,
      requestId,
      timestamp: timestampText,
      nonce: nonceText,
      body: input.body,
    }))
    .digest();
  if (!timingSafeEqual(signature, expected)) throw new Error("Knowledge promotion request is invalid.");
  return Object.freeze({
    requestId,
    nonceDigest: createHash("sha256").update(nonce).digest(),
  });
}

export function validatePromotionBody(body: Buffer): { question: string } {
  if (!(body instanceof Buffer) || body.byteLength > KNOWLEDGE_PROMOTION_MAX_BODY_BYTES) {
    throw new Error("Knowledge promotion body is invalid.");
  }
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new Error("Knowledge promotion body is invalid.");
  }
  let value: unknown;
  try {
    value = JSON.parse(decoded);
  } catch {
    throw new Error("Knowledge promotion body is invalid.");
  }
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).length !== 1 ||
    !Object.prototype.hasOwnProperty.call(value, "question")
  ) {
    throw new Error("Knowledge promotion body is invalid.");
  }
  return { question: validatePromotionQuestion((value as { question: unknown }).question) };
}

function canonicalSignature(input: {
  keyId: string;
  requestId: string;
  timestamp: string;
  nonce: string;
  body: Buffer;
}): string {
  return [
    "VENNEK-PROMOTION-V1",
    "POST",
    KNOWLEDGE_PROMOTION_PATH,
    input.keyId,
    input.requestId,
    input.timestamp,
    input.nonce,
    createHash("sha256").update(input.body).digest("base64url"),
  ].join("\n");
}

function copyPromotionIdentity(identity: PromotionIdentity): PromotionIdentity {
  if (
    identity === null ||
    typeof identity !== "object" ||
    typeof identity.keyId !== "string" ||
    !KEY_ID_PATTERN.test(identity.keyId) ||
    !(identity.key instanceof Buffer) ||
    identity.key.byteLength !== 32
  ) {
    throw new Error("Knowledge promotion identity is invalid.");
  }
  return { keyId: identity.keyId, key: Buffer.from(identity.key) };
}

function requiredHeader(headers: Headers, name: string): string {
  const value = headers.get(name);
  if (value === null || value.length === 0 || value.trim() !== value) {
    throw new Error("Knowledge promotion request is invalid.");
  }
  return value;
}

function parseUnixSeconds(value: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) throw new Error("Knowledge promotion request is invalid.");
  const timestamp = Number(value);
  if (!Number.isSafeInteger(timestamp)) throw new Error("Knowledge promotion request is invalid.");
  return timestamp;
}

function unixSeconds(value: Date): number {
  const milliseconds = value.getTime();
  if (!Number.isFinite(milliseconds)) throw new Error("Knowledge promotion timestamp is invalid.");
  return Math.floor(milliseconds / 1000);
}

function encodeBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function decodeBase64Url(value: string, expectedBytes: number): Buffer {
  if (!BASE64URL_PATTERN.test(value)) throw new Error("Knowledge promotion request is invalid.");
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength !== expectedBytes || encodeBase64Url(decoded) !== value) {
    throw new Error("Knowledge promotion request is invalid.");
  }
  return decoded;
}
