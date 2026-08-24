import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface EncryptedText {
  ciphertext: string;
  iv: string;
  tag: string;
}

const INVALID_KEY = "Encryption key must be exactly 32 bytes";
const INVALID_ENVELOPE = "Encrypted text envelope is malformed";
const AUTHENTICATION_FAILED = "Encrypted text authentication failed";
const canonicalBase64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
type AssociatedData = string | Uint8Array;

function validateKey(key: Uint8Array): Buffer {
  if (!(key instanceof Uint8Array) || key.byteLength !== 32) {
    throw new Error(INVALID_KEY);
  }
  return Buffer.from(key);
}

function decodeBase64(value: unknown): Buffer {
  if (typeof value !== "string" || !canonicalBase64.test(value)) {
    throw new Error(INVALID_ENVELOPE);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new Error(INVALID_ENVELOPE);
  }
  return decoded;
}

function normalizeAssociatedData(value: AssociatedData | undefined): Buffer | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return Buffer.from(value, "utf8");
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new Error(INVALID_ENVELOPE);
}

export function encryptText(
  value: string,
  key: Uint8Array,
  associatedData?: AssociatedData,
): EncryptedText {
  const encryptionKey = validateKey(key);
  if (typeof value !== "string") {
    throw new Error("Plaintext must be a string");
  }
  const aad = normalizeAssociatedData(associatedData);

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  if (aad) cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);

  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

export function decryptText(
  envelope: EncryptedText,
  key: Uint8Array,
  associatedData?: AssociatedData,
): string {
  const encryptionKey = validateKey(key);
  if (!envelope || typeof envelope !== "object") {
    throw new Error(INVALID_ENVELOPE);
  }

  const ciphertext = decodeBase64(envelope.ciphertext);
  const iv = decodeBase64(envelope.iv);
  const tag = decodeBase64(envelope.tag);
  if (iv.length !== 12 || tag.length !== 16) {
    throw new Error(INVALID_ENVELOPE);
  }
  const aad = normalizeAssociatedData(associatedData);

  try {
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey, iv);
    if (aad) decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new Error(AUTHENTICATION_FAILED);
  }
}
