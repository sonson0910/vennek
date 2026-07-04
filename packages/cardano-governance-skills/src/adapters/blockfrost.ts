import type { ProofReceipt } from "@vennek/shared";

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
  expectedContentHash?: string;
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

  let metadata: BlockfrostMetadataEntry[];
  try {
    const parsed = await response.json();
    if (!Array.isArray(parsed)) {
      throw new Error("metadata response is not an array");
    }
    metadata = parsed as BlockfrostMetadataEntry[];
  } catch (error) {
    return {
      ok: false,
      status: "failed",
      txHash: input.txHash,
      reason: `Blockfrost metadata response was invalid JSON/shape: ${error instanceof Error ? error.message : String(error)}.`
    };
  }
  const matchedPayload = metadata.map((entry) => entry.json_metadata).find(isVennekProofPayload);
  if (!matchedPayload) {
    return {
      ok: false,
      status: "failed",
      txHash: input.txHash,
      reason: "No vennek.proof.v1 metadata payload found on transaction."
    };
  }

  const contentHash = typeof matchedPayload.content_hash === "string" ? matchedPayload.content_hash : undefined;
  if (input.expectedContentHash && contentHash !== input.expectedContentHash) {
    return {
      ok: false,
      status: "failed",
      txHash: input.txHash,
      matchedPayload,
      reason: "vennek.proof.v1 payload found, but content_hash does not match expected value."
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

function isVennekProofPayload(value: unknown): value is { schema: "vennek.proof.v1"; content_hash?: string } {
  return Boolean(value && typeof value === "object" && (value as { schema?: unknown }).schema === "vennek.proof.v1");
}
