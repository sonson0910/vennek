import { describe, expect, it } from "vitest";
import { performance } from "node:perf_hooks";
import {
  decryptText,
  encryptText,
  findWalletSecret,
  type EncryptedText,
} from "@vennek/cardano-agent";

const encryptionKey = Buffer.alloc(32, 7);

function expectErrorWithoutSecrets(action: () => unknown, ...secrets: string[]) {
  let thrown = false;
  try {
    action();
  } catch (error) {
    thrown = true;
    const message = error instanceof Error ? error.message : String(error);
    for (const secret of secrets) {
      expect(message).not.toContain(secret);
    }
  }
  expect(thrown).toBe(true);
}

function alteredBase64(value: string): string {
  return `${value[0] === "A" ? "B" : "A"}${value.slice(1)}`;
}

describe("wallet secret detection", () => {
  it("detects Cardano signing-key JSON within a bounded span", () => {
    expect(
      findWalletSecret(
        '{"TYPE":"paymentsigningkeyshelley_ed25519","description":"wallet","BYTES":"5820abcdef"}',
      ),
    ).toBe("signing-key");
  });

  it("detects Bech32-like private signing keys", () => {
    expect(findWalletSecret("addr_xsk1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq")).toBe(
      "signing-key",
    );
    expect(findWalletSecret("custom_sk1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq")).toBe(
      "signing-key",
    );
  });

  it("does not flag public Cardano addresses or public keys", () => {
    expect(findWalletSecret("addr1qxy3w4l9k7m4z2x9c8v7b6n5m4l3k2j1h0g9f8")).toBeUndefined();
    expect(findWalletSecret("stake_vk1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq")).toBeUndefined();
    expect(findWalletSecret("pool_vk1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq")).toBeUndefined();
    expect(findWalletSecret("drep_vk1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq")).toBeUndefined();
  });

  it("detects a 24-token recovery phrase candidate", () => {
    const candidate = Array.from({ length: 24 }, (_, index) => `word${index + 1}`).join(" ");
    expect(findWalletSecret(candidate)).toBe("recovery-phrase");
  });

  it("detects a valid mnemonic embedded in surrounding text and punctuation", () => {
    const mnemonic = Array.from({ length: 11 }, () => "abandon").concat("about").join(" ");
    expect(findWalletSecret(`my recovery phrase is: ${mnemonic}. do not share`)).toBe(
      "recovery-phrase",
    );
  });

  it("detects signing-key JSON when type and material are far apart", () => {
    const signingKey = JSON.stringify({
      type: "PaymentSigningKeyShelley_ed25519",
      description: "x".repeat(700),
      cborHex: "5820abcdef",
    });
    expect(findWalletSecret(signingKey)).toBe("signing-key");
  });

  it("bounds oversized repeated mnemonic scans and fails closed", () => {
    const oversizedInput = "abandon ".repeat(4096);
    const startedAt = performance.now();
    const result = findWalletSecret(oversizedInput);
    const elapsedMs = performance.now() - startedAt;

    expect(result).toBe("recovery-phrase");
    expect(elapsedMs).toBeLessThan(250);
  });

  it("uses a global checksum budget across overlapping wordlists and runs", () => {
    const segment = `${Array.from({ length: 24 }, () => "的").join(" ")} zzzzzzzzzz `;
    const segmentedInput = segment.repeat(240);
    const startedAt = performance.now();
    const result = findWalletSecret(segmentedInput);
    const elapsedMs = performance.now() - startedAt;

    expect(segmentedInput.length).toBeLessThan(16_384);
    expect(result).toBe("recovery-phrase");
    expect(elapsedMs).toBeLessThan(250);
  });

  it("detects escaped signing-key JSON in a code fence", () => {
    const escapedJson = String.raw`{"ty\u0070e":"PaymentSigningKeyShelley_\u0065d25519","cbor\u0048ex":"5820abcdef"}`;
    expect(findWalletSecret(`\`\`\`json\n${escapedJson}\n\`\`\``)).toBe("signing-key");
  });

  it("detects malformed raw and fenced signing-key envelopes with Unicode escapes", () => {
    const malformedJson = String.raw`{"ty\u0070e":"PaymentSigningKeyShelley_\u0065d25519","cbor\u0048ex":"5820abcdef",}`;

    expect(findWalletSecret(malformedJson)).toBe("signing-key");
    expect(findWalletSecret(`\`\`\`json\n${malformedJson}\n\`\`\``)).toBe("signing-key");
  });

  it("does not classify ordinary malformed JSON as a signing key", () => {
    expect(findWalletSecret('{"type":"ordinary","note":"not a wallet key",}')).toBeUndefined();
  });

  it("fails closed when escaped signing-key JSON exceeds the depth limit", () => {
    let nested = String.raw`{"cbor\u0048ex":"5820abcdef"}`;
    for (let depth = 0; depth < 10; depth += 1) {
      nested = `{"nested":${nested}}`;
    }
    const escapedJson = String.raw`{"ty\u0070e":"PaymentSigningKeyShelley_\u0065d25519","nested":${nested}}`;

    expect(findWalletSecret(escapedJson)).toBe("signing-key");
  });

  it("fails closed when an escaped signing-key envelope follows the candidate limit", () => {
    const harmlessObjects = Array.from({ length: 32 }, () => '{"_":0}').join(" ");
    const escapedJson = String.raw`{"ty\u0070e":"PaymentSigningKeyShelley_\u0065d25519","cbor\u0048ex":"5820abcdef"}`;

    expect(findWalletSecret(`${harmlessObjects} ${escapedJson}`)).toBe("signing-key");
  });

  it("fails closed when a JSON candidate exceeds the node limit", () => {
    const harmlessNodes = Array.from({ length: 260 }, (_, index) => `{"safe":${index}}`).join(",");
    const escapedJson = String.raw`{"items":[${harmlessNodes}],"nested":{"ty\u0070e":"PaymentSigningKeyShelley_\u0065d25519","cbor\u0048ex":"5820abcdef"}}`;

    expect(findWalletSecret(escapedJson)).toBe("signing-key");
  });

  it("does not flag blank or ordinary short text", () => {
    expect(findWalletSecret(" \t\n")).toBeUndefined();
    expect(findWalletSecret("please summarize this conversation for me")).toBeUndefined();
  });
});

describe("conversation text encryption", () => {
  it("round-trips UTF-8 text", () => {
    const plaintext = "Keep this wallet note private — こんにちは";
    const encrypted = encryptText(plaintext, encryptionKey);

    expect(decryptText(encrypted, encryptionKey)).toBe(plaintext);
  });

  it("serializes without plaintext and uses a fresh IV", () => {
    const plaintext = "very secret conversation";
    const first = encryptText(plaintext, encryptionKey);
    const second = encryptText(plaintext, encryptionKey);

    expect(JSON.stringify(first)).not.toContain(plaintext);
    expect(second.iv).not.toBe(first.iv);
    expect(second.ciphertext).not.toBe(first.ciphertext);
  });

  it("rejects ciphertext and authentication-tag tampering", () => {
    const encrypted = encryptText("tamper me", encryptionKey);
    const tamperedCiphertext: EncryptedText = {
      ...encrypted,
      ciphertext: alteredBase64(encrypted.ciphertext),
    };
    const tamperedTag: EncryptedText = {
      ...encrypted,
      tag: alteredBase64(encrypted.tag),
    };

    expect(() => decryptText(tamperedCiphertext, encryptionKey)).toThrow();
    expect(() => decryptText(tamperedTag, encryptionKey)).toThrow();
  });

  it("rejects invalid keys and malformed envelopes without echoing secrets", () => {
    const plaintext = "do not echo this plaintext";
    const encodedField = "not-base64!";

    expectErrorWithoutSecrets(
      () => encryptText(plaintext, Buffer.alloc(31)),
      plaintext,
    );
    expectErrorWithoutSecrets(
      () => decryptText({ ciphertext: encodedField, iv: encodedField, tag: encodedField }, encryptionKey),
      plaintext,
      encodedField,
    );
    expectErrorWithoutSecrets(
      () => decryptText({ ciphertext: "", iv: "", tag: "" }, Buffer.alloc(31)),
      plaintext,
    );
  });
});
