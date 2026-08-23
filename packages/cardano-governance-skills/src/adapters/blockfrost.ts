import type { ProofPayload, ProofReceipt } from "@vennek/shared";

export type BlockfrostNetwork = "mainnet" | "preprod" | "preview";

export type BlockfrostVerificationResult = {
  ok: boolean;
  status: ProofReceipt["status"];
  txHash: string;
  matchedPayload?: unknown;
  reason: string;
};

export type BlockfrostClientOptions = {
  projectId: string;
  network?: BlockfrostNetwork;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
};

type BlockfrostMetadataEntry = {
  label?: string;
  json_metadata?: unknown;
  cip25_metadata?: unknown;
};

const BASE_URLS: Record<BlockfrostNetwork, string> = {
  mainnet: "https://cardano-mainnet.blockfrost.io/api/v0",
  preprod: "https://cardano-preprod.blockfrost.io/api/v0",
  preview: "https://cardano-preview.blockfrost.io/api/v0"
};

export async function verifyProofTxWithBlockfrost(input: {
  txHash: string;
  expectedContentHash: string;
  options: BlockfrostClientOptions;
}): Promise<BlockfrostVerificationResult> {
  if (!/^[0-9a-f]{64}$/i.test(input.txHash)) {
    return {
      ok: false,
      status: "failed",
      txHash: input.txHash,
      reason: "Invalid transaction hash format."
    };
  }
  const normalizedExpectedContentHash = normalizeContentHash(input.expectedContentHash);
  if (!normalizedExpectedContentHash) {
    return {
      ok: false,
      status: "failed",
      txHash: input.txHash,
      reason: "Expected content hash must be a SHA-256 hex value."
    };
  }
  if (!input.options.projectId.trim()) {
    return {
      ok: false,
      status: "failed",
      txHash: input.txHash,
      reason: "BLOCKFROST_PROJECT_ID is required for Blockfrost verification."
    };
  }

  const fetchImpl = input.options.fetchImpl ?? fetch;
  const network = input.options.network ?? "mainnet";
  const url = `${BASE_URLS[network]}/txs/${input.txHash.toLowerCase()}/metadata`;
  let response: Response;
  try {
    response = await fetchBlockfrostWithRetry({
      fetchImpl,
      url,
      projectId: input.options.projectId,
      timeoutMs: input.options.timeoutMs ?? 8_000,
      maxRetries: input.options.maxRetries ?? 1,
      retryDelayMs: input.options.retryDelayMs ?? 250
    });
  } catch (error) {
    return {
      ok: false,
      status: "failed",
      txHash: input.txHash,
      reason: `Blockfrost metadata request failed: ${error instanceof Error ? error.message : String(error)}.`
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      status: "failed",
      txHash: input.txHash,
      reason: `Blockfrost metadata request failed with HTTP ${response.status}.`
    };
  }

  let metadata: unknown[];
  try {
    const parsed = await response.json();
    if (!Array.isArray(parsed)) {
      throw new Error("metadata response is not an array");
    }
    metadata = parsed;
  } catch (error) {
    return {
      ok: false,
      status: "failed",
      txHash: input.txHash,
      reason: `Blockfrost metadata response was invalid JSON/shape: ${error instanceof Error ? error.message : String(error)}.`
    };
  }
  const proofPayloads = metadata
    .map((entry) => (entry && typeof entry === "object" ? (entry as BlockfrostMetadataEntry).json_metadata : undefined))
    .filter(isVennekProofPayload);
  const matchedPayload = proofPayloads.find((payload) => normalizeContentHash(payload.content_hash) === normalizedExpectedContentHash);
  if (!matchedPayload) {
    if (proofPayloads.length > 0) {
      return {
        ok: false,
        status: "failed",
        txHash: input.txHash,
        matchedPayload: proofPayloads[0],
        reason: "vennek.proof.v1 payload found, but content_hash does not match expected value."
      };
    }
    return {
      ok: false,
      status: "failed",
      txHash: input.txHash,
      reason: "No vennek.proof.v1 metadata payload found on transaction."
    };
  }

  return {
    ok: true,
    status: "verified",
    txHash: input.txHash,
    matchedPayload,
    reason: "vennek.proof.v1 metadata payload verified via Blockfrost."
  };
}

async function fetchBlockfrostWithRetry(input: {
  fetchImpl: typeof fetch;
  url: string;
  projectId: string;
  timeoutMs: number;
  maxRetries: number;
  retryDelayMs: number;
}): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= input.maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
    try {
      const response = await input.fetchImpl(input.url, {
        headers: { project_id: input.projectId },
        signal: controller.signal
      });
      if (!isRetryableStatus(response.status) || attempt === input.maxRetries) {
        return response;
      }
    } catch (error) {
      lastError = error;
      if (attempt === input.maxRetries) {
        throw error;
      }
    } finally {
      clearTimeout(timeout);
    }
    await sleep(input.retryDelayMs);
  }
  throw lastError instanceof Error ? lastError : new Error("Blockfrost request failed after retries");
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function sleep(milliseconds: number): Promise<void> {
  return milliseconds <= 0 ? Promise.resolve() : new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

const SHA256_PATTERN = /^(?:sha256:)?[0-9a-f]{64}$/i;

function isVennekProofPayload(value: unknown): value is ProofPayload {
  if (!value || typeof value !== "object") {
    return false;
  }
  const payload = value as Partial<ProofPayload>;
  return (
    payload.schema === "vennek.proof.v1" &&
    typeof payload.content_hash === "string" &&
    SHA256_PATTERN.test(payload.content_hash) &&
    Array.isArray(payload.source_refs) &&
    payload.source_refs.every((reference) => typeof reference === "string") &&
    typeof payload.created_at === "string" &&
    !Number.isNaN(Date.parse(payload.created_at)) &&
    typeof payload.agent_version === "string" &&
    payload.agent_version.trim().length > 0 &&
    (payload.report_id === undefined || typeof payload.report_id === "string")
  );
}

function normalizeContentHash(value: string): string | undefined {
  if (!SHA256_PATTERN.test(value)) {
    return undefined;
  }
  return value.replace(/^sha256:/i, "").toLowerCase();
}
