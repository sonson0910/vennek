import { describe, expect, it } from "vitest";
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
