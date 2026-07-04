import { describe, expect, it } from "vitest";
import { verifyProofTxWithBlockfrost } from "@vennek/cardano-governance-skills";

const required = [
  "BLOCKFROST_PROJECT_ID",
  "BLOCKFROST_TEST_TX_HASH",
  "BLOCKFROST_TEST_CONTENT_HASH"
] as const;

const hasEnv = required.every((name) => Boolean(process.env[name]));

(hasEnv ? describe : describe.skip)("Blockfrost live integration", () => {
  it("verifies a known vennek.proof.v1 transaction metadata payload", async () => {
    const result = await verifyProofTxWithBlockfrost({
      txHash: process.env.BLOCKFROST_TEST_TX_HASH!,
      expectedContentHash: process.env.BLOCKFROST_TEST_CONTENT_HASH!,
      options: {
        projectId: process.env.BLOCKFROST_PROJECT_ID!,
        network: parseNetwork(process.env.BLOCKFROST_NETWORK)
      }
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("verified");
  });
});

function parseNetwork(value: string | undefined): "mainnet" | "preprod" | "preview" | undefined {
  return value === "mainnet" || value === "preprod" || value === "preview" ? value : undefined;
}
