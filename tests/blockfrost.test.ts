import { describe, expect, it } from "vitest";
import { proofVerifyCommand, verifyProofTxWithBlockfrost } from "@vennek/cardano-governance-skills";

const txHash = "a".repeat(64);
const payload = {
  schema: "vennek.proof.v1",
  content_hash: "sha256:" + "b".repeat(64),
  source_refs: [],
  created_at: "2026-07-04T00:00:00.000Z",
  agent_version: "0.1.0"
};

describe("Blockfrost proof verification", () => {
  it("verifies vennek.proof.v1 metadata payload", async () => {
    const result = await verifyProofTxWithBlockfrost({
      txHash,
      expectedContentHash: payload.content_hash,
      options: {
        projectId: "test_project",
        network: "preprod",
        fetchImpl: jsonFetch(200, [{ label: "674", json_metadata: payload }])
      }
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("verified");
    expect(result.reason).toMatch(/verified via Blockfrost/i);
  });

  it("accepts sha256: expected hash when on-chain metadata stores bare hex", async () => {
    const bareHexPayload = { ...payload, content_hash: "b".repeat(64) };
    const result = await verifyProofTxWithBlockfrost({
      txHash,
      expectedContentHash: payload.content_hash,
      options: {
        projectId: "test_project",
        network: "preprod",
        fetchImpl: jsonFetch(200, [{ label: "674", json_metadata: bareHexPayload }])
      }
    });

    expect(result.ok).toBe(true);
  });

  it("fails safely when project id is missing", async () => {
    const result = await verifyProofTxWithBlockfrost({ txHash, expectedContentHash: payload.content_hash, options: { projectId: "" } });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/BLOCKFROST_PROJECT_ID/);
  });

  it("fails when metadata is missing or content hash mismatches", async () => {
    await expect(verifyProofTxWithBlockfrost({
      txHash,
      expectedContentHash: payload.content_hash,
      options: { projectId: "test_project", fetchImpl: jsonFetch(200, []) }
    })).resolves.toMatchObject({ ok: false, status: "failed" });

    await expect(verifyProofTxWithBlockfrost({
      txHash,
      expectedContentHash: "sha256:" + "c".repeat(64),
      options: { projectId: "test_project", fetchImpl: jsonFetch(200, [{ json_metadata: payload }]) }
    })).resolves.toMatchObject({ ok: false, status: "failed" });
  });

  it("rejects schema-only and malformed proof payloads", async () => {
    for (const malformed of [
      { schema: "vennek.proof.v1" },
      { ...payload, content_hash: "not-a-hash" },
      { ...payload, source_refs: "not-an-array" },
      { ...payload, created_at: "not-a-date" },
      { ...payload, agent_version: "" }
    ]) {
      await expect(verifyProofTxWithBlockfrost({
        txHash,
        expectedContentHash: payload.content_hash,
        options: {
          projectId: "test_project",
          fetchImpl: jsonFetch(200, [{ json_metadata: malformed }])
        }
      })).resolves.toMatchObject({ ok: false, status: "failed" });
    }
  });

  it("fails safely when metadata contains a null entry", async () => {
    await expect(verifyProofTxWithBlockfrost({
      txHash,
      expectedContentHash: payload.content_hash,
      options: {
        projectId: "test_project",
        fetchImpl: jsonFetch(200, [null])
      }
    })).resolves.toMatchObject({ ok: false, status: "failed" });
  });

  it("matches the expected hash when multiple proof payloads are present", async () => {
    const firstPayload = { ...payload, content_hash: "c".repeat(64) };
    const result = await verifyProofTxWithBlockfrost({
      txHash,
      expectedContentHash: payload.content_hash,
      options: {
        projectId: "test_project",
        fetchImpl: jsonFetch(200, [
          { json_metadata: firstPayload },
          { json_metadata: payload }
        ])
      }
    });

    expect(result.ok).toBe(true);
    expect(result.matchedPayload).toEqual(payload);
  });

  it("rejects malformed expected hashes before fetching metadata", async () => {
    let fetchCalls = 0;
    const fetchImpl = (async () => {
      fetchCalls += 1;
      return { ok: true, status: 200, json: async () => [{ json_metadata: payload }] };
    }) as unknown as typeof fetch;
    const result = await verifyProofTxWithBlockfrost({
      txHash,
      expectedContentHash: "not-a-sha256-hash",
      options: { projectId: "test_project", fetchImpl }
    });

    expect(result).toMatchObject({ ok: false, status: "failed", reason: expect.stringMatching(/SHA-256/i) });
    expect(fetchCalls).toBe(0);
  });

  it("requires an expected content hash", async () => {
    await expect(proofVerifyCommand(txHash, {
      projectId: "test_project",
      fetchImpl: jsonFetch(200, [{ json_metadata: payload }])
    })).rejects.toThrow(/requires <tx_hash> <expected_content_hash>/i);
  });

  it("rejects a non-sha256 expected value", async () => {
    await expect(proofVerifyCommand(`${txHash} same-arbitrary-string`, {
      projectId: "test_project",
      fetchImpl: jsonFetch(200, [{ json_metadata: { ...payload, content_hash: "same-arbitrary-string" } }])
    })).rejects.toThrow(/SHA-256/i);
  });

  it("rejects extra proof verification arguments", async () => {
    await expect(proofVerifyCommand(`${txHash} ${payload.content_hash} extra`, {
      projectId: "test_project",
      fetchImpl: jsonFetch(200, [{ json_metadata: payload }])
    })).rejects.toThrow(/requires <tx_hash> <expected_content_hash>/i);
  });

  it("fails safely on Blockfrost HTTP, network, and malformed response errors", async () => {
    await expect(verifyProofTxWithBlockfrost({
      txHash,
      expectedContentHash: payload.content_hash,
      options: { projectId: "test_project", fetchImpl: jsonFetch(429, { error: "rate limited" }) }
    })).resolves.toMatchObject({ ok: false, reason: expect.stringMatching(/HTTP 429/) });

    await expect(verifyProofTxWithBlockfrost({
      txHash,
      expectedContentHash: payload.content_hash,
      options: { projectId: "test_project", fetchImpl: rejectingFetch(new Error("network down")) }
    })).resolves.toMatchObject({ ok: false, reason: expect.stringMatching(/network down/) });

    await expect(verifyProofTxWithBlockfrost({
      txHash,
      expectedContentHash: payload.content_hash,
      options: { projectId: "test_project", fetchImpl: jsonFetch(200, { not: "array" }) }
    })).resolves.toMatchObject({ ok: false, reason: expect.stringMatching(/invalid JSON\/shape/) });
  });

  it("retries retryable Blockfrost failures before succeeding", async () => {
    const fetchImpl = sequenceFetch([
      { status: 500, body: { error: "temporary" } },
      { status: 200, body: [{ json_metadata: payload }] }
    ]);
    const result = await verifyProofTxWithBlockfrost({
      txHash,
      expectedContentHash: payload.content_hash,
      options: { projectId: "test_project", fetchImpl, maxRetries: 1, retryDelayMs: 0 }
    });
    expect(result.ok).toBe(true);
    expect(fetchImpl.calls).toBe(2);
  });

  it("/proof-verify command stays non-custodial and source-unavailable", async () => {
    const result = await proofVerifyCommand(`${txHash} ${payload.content_hash}`, {
      projectId: "test_project",
      network: "preprod",
      fetchImpl: jsonFetch(200, [{ json_metadata: payload }])
    });
    expect(result.ok).toBe(true);
    expect(result.command).toBe("proof-verify");
    expect(result.text).toContain("Blockfrost verification only");
    expect(result.text).toContain("Verified: yes");
    expect(result.text).not.toMatch(/seed phrase|private key|wallet connector/i);
  });
});

function jsonFetch(status: number, body: unknown): typeof fetch {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  })) as unknown as typeof fetch;
}

function rejectingFetch(error: Error): typeof fetch {
  return (async () => {
    throw error;
  }) as unknown as typeof fetch;
}

function sequenceFetch(responses: Array<{ status: number; body: unknown }>): typeof fetch & { calls: number } {
  let calls = 0;
  const fn = (async () => {
    const response = responses[Math.min(calls, responses.length - 1)];
    calls += 1;
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      json: async () => response.body
    };
  }) as unknown as typeof fetch & { calls: number };
  Object.defineProperty(fn, "calls", { get: () => calls });
  return fn;
}
