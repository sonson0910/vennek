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

const signingKeyTypeField = /["']?type["']?\s*:\s*["']([^"']+)["']/gi;
const keyMaterialField = /["']?(?:cborhex|bytes)["']?\s*:\s*["']([^"']+)["']/i;
const privateBech32Key =
  /\b[a-z][a-z0-9_-]*_(?:xsk|sk)1[023456789ac-hj-np-z]{20,}(?![0-9a-z])/i;
const wordLike = /^[\p{L}\p{N}]+(?:['-][\p{L}\p{N}]+)*$/u;
const recoveryPhraseLengths = new Set([12, 15, 18, 21, 24]);
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
const wordToken = /[\p{L}\p{M}\p{N}]+/gu;

function hasSigningKeyJson(input: string): boolean {
  for (const match of input.matchAll(signingKeyTypeField)) {
    const type = match[1]!.toLowerCase();
    if (type.includes("signingkey") && type.includes("ed25519")) {
      return keyMaterialField.test(input);
    }
  }
  return false;
}

function hasValidRecoveryPhrase(input: string): boolean {
  const tokens = input.normalize("NFKD").toLowerCase().match(wordToken) ?? [];

  for (const length of recoveryPhraseLengths) {
    for (let start = 0; start + length <= tokens.length; start += 1) {
      const candidate = tokens.slice(start, start + length);
      for (let listIndex = 0; listIndex < bip39Wordlists.length; listIndex += 1) {
        if (!candidate.every((word) => bip39WordSets[listIndex]!.has(word))) continue;
        if (validateMnemonic(candidate.join(" "), bip39Wordlists[listIndex]!)) return true;
      }
    }
  }
  return false;
}

export function findWalletSecret(input: string): WalletSecretKind | undefined {
  if (typeof input !== "string" || !input.trim()) return undefined;

  if (hasSigningKeyJson(input) || privateBech32Key.test(input)) {
    return "signing-key";
  }

  if (hasValidRecoveryPhrase(input)) return "recovery-phrase";

  const tokens = input.trim().split(/\s+/);
  // ponytail: exact word-count matching intentionally accepts false positives at this trust boundary.
  if (
    recoveryPhraseLengths.has(tokens.length) &&
    tokens.every((token) => wordLike.test(token))
  ) {
    return "recovery-phrase";
  }

  return undefined;
}
