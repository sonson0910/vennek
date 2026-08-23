import {
  canonicalJson,
  sha256Hex,
  sha256Uri,
  type CommandResult,
  type ProofPayload,
  type ProofReceipt
} from "@vennek/shared";
import { verifyProofTxWithBlockfrost, type BlockfrostNetwork, type BlockfrostVerificationResult } from "../adapters/blockfrost.js";
import { assertSafeOutput, humanDecisionFrame } from "../safety/outputGuards.js";

const AGENT_VERSION = "0.1.0";
const SHA256_PATTERN = /^(?:sha256:)?[0-9a-f]{64}$/i;

export function createProofPayload(input: {
  text: string;
  sourceRefs?: string[];
  reportId?: string;
  now?: Date;
}): ProofReceipt {
  const payload: ProofPayload = {
    schema: "vennek.proof.v1",
    content_hash: sha256Uri(input.text),
    source_refs: input.sourceRefs ?? [],
    created_at: (input.now ?? new Date()).toISOString(),
    agent_version: AGENT_VERSION,
    report_id: input.reportId
  };
  const local_id = `proof-${sha256Hex(canonicalJson(payload)).slice(0, 12)}`;

  return {
    payload,
    local_id,
    status: "payload-only"
  };
}

export function verifyExternalTxHash(txHash: string): ProofReceipt["status"] {
  if (!/^[0-9a-f]{64}$/i.test(txHash)) {
    return "failed";
  }

  return "pending-external-verification";
}

export function proofCommand(input: string, now?: Date): CommandResult {
  if (!input.trim()) {
    throw new Error("/proof requires text to hash.");
  }

  const receipt = createProofPayload({ text: input, now });
  const text = [
    humanDecisionFrame(),
    "Proof payload only. Submit externally if you choose; Vennek does not sign or submit transactions.",
    "",
    `Local receipt: ${receipt.local_id}`,
    `Status: ${receipt.status}`,
    "",
    "Metadata payload:",
    JSON.stringify(receipt.payload, null, 2),
    "",
    "Source unavailable: proof hashing is based on user-provided text, not a retrieved governance source."
  ].join("\n");

  return assertSafeOutput({
    command: "proof",
    ok: true,
    text,
    citations: [],
    sourceStatus: "unavailable",
    warnings: [],
    data: receipt
  });
}

export async function proofVerifyCommand(input: string, options: {
  projectId?: string;
  network?: BlockfrostNetwork;
  fetchImpl?: typeof fetch;
} = {}): Promise<CommandResult> {
  const [txHash, expectedContentHash, extra] = input.trim().split(/\s+/);
  if (!txHash || !expectedContentHash || extra) {
    throw new Error("/proof-verify requires <tx_hash> <expected_content_hash>.");
  }
  if (!SHA256_PATTERN.test(expectedContentHash)) {
    throw new Error("Expected content hash must be a SHA-256 hex value.");
  }

  const result: BlockfrostVerificationResult = await verifyProofTxWithBlockfrost({
    txHash,
    expectedContentHash,
    options: {
      projectId: options.projectId ?? "",
      network: options.network,
      fetchImpl: options.fetchImpl
    }
  });

  const text = [
    humanDecisionFrame(),
    "Blockfrost verification only. Vennek does not sign, submit, or construct transactions.",
    "",
    `Transaction: ${txHash}`,
    `Status: ${result.status}`,
    `Verified: ${result.ok ? "yes" : "no"}`,
    `Reason: ${result.reason}`,
    expectedContentHash ? `Expected content hash: ${expectedContentHash}` : "Expected content hash: not provided",
    "",
    "Source unavailable: proof verification uses Blockfrost transaction metadata, not a governance source citation."
  ].join("\n");

  return assertSafeOutput({
    command: "proof-verify",
    ok: result.ok,
    text,
    citations: [],
    sourceStatus: "unavailable",
    warnings: result.ok ? [] : [result.reason],
    data: result
  });
}
