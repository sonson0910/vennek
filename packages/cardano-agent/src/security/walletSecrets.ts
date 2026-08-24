import { validateMnemonic } from "@scure/bip39";
import { wordlist as czech } from "@scure/bip39/wordlists/czech.js";
import { wordlist as english } from "@scure/bip39/wordlists/english.js";
import { wordlist as french } from "@scure/bip39/wordlists/french.js";
import { wordlist as italian } from "@scure/bip39/wordlists/italian.js";
import { wordlist as japanese } from "@scure/bip39/wordlists/japanese.js";
import { wordlist as korean } from "@scure/bip39/wordlists/korean.js";
import { wordlist as portuguese } from "@scure/bip39/wordlists/portuguese.js";
import { wordlist as simplifiedChinese } from "@scure/bip39/wordlists/simplified-chinese.js";
import { wordlist as spanish } from "@scure/bip39/wordlists/spanish.js";
import { wordlist as traditionalChinese } from "@scure/bip39/wordlists/traditional-chinese.js";

export type WalletSecretKind = "signing-key" | "recovery-phrase";

const MAX_WALLET_SCAN_CHARS = 16_384;
// JSON parser limits fail closed because skipped structure may contain a secret.
const MAX_JSON_CANDIDATE_CHARS = 16_384;
const MAX_JSON_CANDIDATES = 32;
const MAX_JSON_DEPTH = 8;
const MAX_JSON_NODES = 256;
const MAX_JSON_FALLBACK_WORK = 16_384;
// Global per-message checksum cap; exhaustion is classified as recovery-like.
const MAX_MNEMONIC_VALIDATIONS = 64;
const signingKeyTypeField = /["']?type["']?\s*:\s*["']([^"']+)["']/gi;
const keyMaterialField = /["']?(?:cborhex|bytes)["']?\s*:\s*["']([^"']+)["']/i;
const privateBech32Key =
  /\b[a-z][a-z0-9_-]*_(?:xsk|sk)1[023456789ac-hj-np-z]{20,}(?![0-9a-z])/i;
const wordLike = /^[\p{L}\p{N}]+(?:['-][\p{L}\p{N}]+)*$/u;
const wordToken = /[\p{L}\p{M}\p{N}]+/gu;
const recoveryPhraseLengths = [12, 15, 18, 21, 24];
const bip39Wordlists = [
  czech,
  english,
  french,
  italian,
  japanese,
  korean,
  portuguese,
  simplifiedChinese,
  spanish,
  traditionalChinese,
];
const bip39WordSets = bip39Wordlists.map(
  (wordlist) => new Set(wordlist.map((word) => word.normalize("NFKD").toLowerCase())),
);

interface JsonInspection {
  hasSigningKeyType: boolean;
  hasKeyMaterial: boolean;
  nodes: number;
  exhausted: boolean;
}

type JsonCandidateResult = "found" | "clean" | "exhausted";

function hasIndependentSigningKeyHints(input: string): boolean {
  for (const match of input.matchAll(signingKeyTypeField)) {
    const type = match[1]!.toLowerCase();
    if (type.includes("signingkey") && type.includes("ed25519")) {
      return keyMaterialField.test(input);
    }
  }
  return false;
}

function decodeJsonUnicodeEscapes(input: string):
  | { decoded: string; exhausted: false }
  | { decoded?: undefined; exhausted: true } {
  const decoded: string[] = [];
  let inString = false;
  let escaped = false;

  for (let index = 0; index < input.length; index += 1) {
    if (index >= MAX_JSON_FALLBACK_WORK) return { exhausted: true };
    const character = input[index]!;

    if (inString && escaped) {
      decoded.push(character);
      escaped = false;
      continue;
    }

    if (inString && character === "\\") {
      const unicode = input.slice(index + 2, index + 6);
      if (input[index + 1] === "u" && /^[0-9a-f]{4}$/i.test(unicode)) {
        decoded.push(String.fromCharCode(Number.parseInt(unicode, 16)));
        index += 5;
        continue;
      }
      decoded.push("\\");
      escaped = true;
      continue;
    }

    if (character === '"') inString = !inString;
    decoded.push(character);
  }

  return { decoded: decoded.join(""), exhausted: false };
}

function inspectJson(value: unknown, depth: number, inspection: JsonInspection): void {
  if (inspection.exhausted) return;
  if (inspection.nodes >= MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
    inspection.exhausted = true;
    return;
  }
  inspection.nodes += 1;

  if (typeof value === "string") return;
  if (!value || typeof value !== "object") return;

  if (Array.isArray(value)) {
    for (const child of value) {
      inspectJson(child, depth + 1, inspection);
      if (inspection.exhausted) break;
    }
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();
    if (normalizedKey === "type" && typeof child === "string") {
      const normalizedType = child.toLowerCase();
      inspection.hasSigningKeyType ||=
        normalizedType.includes("signingkey") && normalizedType.includes("ed25519");
    }
    if (
      (normalizedKey === "cborhex" || normalizedKey === "bytes") &&
      typeof child === "string" &&
      child.length > 0
    ) {
      inspection.hasKeyMaterial = true;
    }
    inspectJson(child, depth + 1, inspection);
    if (inspection.exhausted) break;
  }
}

function inspectJsonCandidate(candidate: string): JsonCandidateResult {
  if (candidate.length > MAX_JSON_CANDIDATE_CHARS) return "exhausted";

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    const fallback = decodeJsonUnicodeEscapes(candidate);
    if (fallback.exhausted) return "exhausted";
    return hasIndependentSigningKeyHints(fallback.decoded) ? "found" : "clean";
  }

  const inspection: JsonInspection = {
    hasSigningKeyType: false,
    hasKeyMaterial: false,
    nodes: 0,
    exhausted: false,
  };
  inspectJson(parsed, 0, inspection);
  if (inspection.exhausted) return "exhausted";
  return inspection.hasSigningKeyType && inspection.hasKeyMaterial ? "found" : "clean";
}

function objectCandidateAt(input: string, start: number): string | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < input.length; index += 1) {
    if (index - start >= MAX_JSON_CANDIDATE_CHARS) return undefined;
    const character = input[index]!;

    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }

    if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return input.slice(start, index + 1);
  }
  return undefined;
}

function hasParsedSigningKeyJson(input: string): boolean {
  const trimmed = input.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const result = inspectJsonCandidate(trimmed);
    if (result !== "clean") return true;
  }

  const codeFence = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (const match of input.matchAll(codeFence)) {
    if (inspectJsonCandidate(match[1]!.trim()) !== "clean") return true;
  }

  let candidates = 0;
  for (let index = 0; index < input.length && candidates <= MAX_JSON_CANDIDATES; index += 1) {
    if (input[index] !== "{") continue;
    candidates += 1;
    if (candidates > MAX_JSON_CANDIDATES) return true;
    const candidate = objectCandidateAt(input, index);
    if (!candidate) return true;
    if (inspectJsonCandidate(candidate) !== "clean") return true;
  }
  return false;
}

function hasSigningKeyJson(input: string): boolean {
  if (hasParsedSigningKeyJson(input)) return true;
  return hasIndependentSigningKeyHints(input);
}

function hasValidRecoveryPhrase(input: string): boolean {
  const tokens = input.normalize("NFKD").toLowerCase().match(wordToken) ?? [];
  let mnemonicValidations = 0;

  const validateWindow = (candidate: string[], wordlist: string[]): boolean => {
    if (mnemonicValidations >= MAX_MNEMONIC_VALIDATIONS) return true;
    mnemonicValidations += 1;
    return validateMnemonic(candidate.join(" "), wordlist);
  };

  for (let listIndex = 0; listIndex < bip39Wordlists.length; listIndex += 1) {
    const wordlist = bip39Wordlists[listIndex]!;
    const wordSet = bip39WordSets[listIndex]!;
    let run: string[] = [];

    const inspectRun = (): boolean => {
      if (run.length > 24) return true;
      if (run.length < 12) return false;

      for (const length of recoveryPhraseLengths) {
        for (let start = 0; start + length <= run.length; start += 1) {
          if (validateWindow(run.slice(start, start + length), wordlist)) return true;
        }
      }
      return false;
    };

    for (const token of tokens) {
      if (wordSet.has(token)) {
        run.push(token);
      } else {
        if (inspectRun()) return true;
        run = [];
      }
    }
    if (inspectRun()) return true;
  }
  return false;
}

export function findWalletSecret(input: string): WalletSecretKind | undefined {
  if (typeof input !== "string" || !input.trim()) return undefined;
  // Telegram text is normally <=4 KiB; oversized content is treated as secret-like to bound CPU.
  if (input.length > MAX_WALLET_SCAN_CHARS) return "recovery-phrase";

  if (hasSigningKeyJson(input) || privateBech32Key.test(input)) {
    return "signing-key";
  }

  if (hasValidRecoveryPhrase(input)) return "recovery-phrase";

  const tokens = input.trim().split(/\s+/);
  // ponytail: exact word-count matching intentionally accepts false positives at this trust boundary.
  if (
    recoveryPhraseLengths.includes(tokens.length) &&
    tokens.every((token) => wordLike.test(token))
  ) {
    return "recovery-phrase";
  }

  return undefined;
}
