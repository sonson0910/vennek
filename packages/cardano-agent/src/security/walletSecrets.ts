export type WalletSecretKind = "signing-key" | "recovery-phrase";

const SIGNING_KEY_JSON_SPAN = 512;
const signingKeyType = /["']?type["']?\s*:\s*["'][^"']*signingkey[^"']*ed25519[^"']*["']/i;
const keyMaterial = /["']?(?:cborhex|bytes)["']?\s*:\s*["'][^"']+["']/i;
const signingKeyJson = new RegExp(
  `(?:${signingKeyType.source}[\\s\\S]{0,${SIGNING_KEY_JSON_SPAN}}${keyMaterial.source}|${keyMaterial.source}[\\s\\S]{0,${SIGNING_KEY_JSON_SPAN}}${signingKeyType.source})`,
  "i",
);
const privateBech32Key =
  /\b[a-z][a-z0-9_-]*_(?:xsk|sk)1[023456789ac-hj-np-z]{20,}(?![0-9a-z])/i;
const wordLike = /^[\p{L}\p{N}]+(?:['-][\p{L}\p{N}]+)*$/u;
const recoveryPhraseLengths = new Set([12, 15, 18, 21, 24]);

export function findWalletSecret(input: string): WalletSecretKind | undefined {
  if (typeof input !== "string" || !input.trim()) return undefined;

  if (signingKeyJson.test(input) || privateBech32Key.test(input)) {
    return "signing-key";
  }

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
