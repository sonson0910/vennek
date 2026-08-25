import { createHash, createHmac } from "node:crypto";
import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import type { QuestionRetrievalInput } from "@vennek/cardano-agent";
import {
  KNOWLEDGE_PROMOTION_CLOCK_SKEW_SECONDS,
  KNOWLEDGE_PROMOTION_MAX_BODY_BYTES,
  KNOWLEDGE_PROMOTION_MAX_QUERY_BYTES,
  KNOWLEDGE_PROMOTION_MAX_QUERY_CODE_POINTS,
  KNOWLEDGE_PROMOTION_PATH,
  KnowledgePromotionClient,
  authenticatePromotionRequest,
  parsePromotionIdentity,
  parsePromotionOrigin,
  signPromotionQuestion,
  validatePromotionBody,
  validatePromotionQuestion,
} from "@vennek/telegram-bot";

const identity = {
  keyId: "agent-worker-v1",
  key: Buffer.alloc(32, 7),
} as const;
const fixed = {
  now: new Date("2026-08-25T00:00:00.000Z"),
  requestId: "11111111-1111-4111-8111-111111111111",
  nonce: Buffer.alloc(16, 9),
};

function signed(question = " latest Cardano node ") {
  return signPromotionQuestion(question, identity, fixed);
}

function authenticate(signedRequest = signed(), overrides: Record<string, string> = {}) {
  const headers = new Headers(signedRequest.headers);
  for (const [name, value] of Object.entries(overrides)) headers.set(name, value);
  return authenticatePromotionRequest({
    method: "POST",
    path: KNOWLEDGE_PROMOTION_PATH,
    headers,
    body: Buffer.from(signedRequest.body),
    identity,
    now: fixed.now,
  });
}

function externalSignature(body: Buffer, timestamp: number, nonce: string, key = identity.key, keyId = identity.keyId) {
  const bodyHash = createHash("sha256").update(body).digest("base64url");
  const canonical = [
    "VENNEK-PROMOTION-V1",
    "POST",
    KNOWLEDGE_PROMOTION_PATH,
    keyId,
    "11111111-1111-4111-8111-111111111111",
    String(timestamp),
    nonce,
    bodyHash,
  ].join("\n");
  return createHmac("sha256", key).update(canonical).digest("base64url");
}

describe("knowledge promotion protocol", () => {
  it("signs and authenticates the exact transmitted body with the pinned vector", () => {
    const request = signed();

    expect(request.body).toBe('{"question":"latest Cardano node"}');
    expect(request.headers).toEqual({
      "Content-Type": "application/json",
      "X-Vennek-Key-Id": "agent-worker-v1",
      "X-Vennek-Request-Id": fixed.requestId,
      "X-Vennek-Timestamp": "1787616000",
      "X-Vennek-Nonce": "CQkJCQkJCQkJCQkJCQkJCQ",
      "X-Vennek-Signature": "gWE9sMTSlKa3Z7O6VA6I7QdZ99n2YxoHUJS4PUNQEqQ",
    });
    expect(authenticate(request)).toEqual({
      requestId: fixed.requestId,
      nonceDigest: createHash("sha256").update(fixed.nonce).digest(),
    });
  });

  it("authenticates without parsing the body", () => {
    const request = signed();
    const body = Buffer.from("not json", "utf8");
    const headers = new Headers(request.headers);
    headers.set("x-vennek-signature", externalSignature(body, Number(request.headers["X-Vennek-Timestamp"]), request.headers["X-Vennek-Nonce"]));
    expect(authenticatePromotionRequest({
      method: "POST",
      path: KNOWLEDGE_PROMOTION_PATH,
      headers,
      body,
      identity,
      now: fixed.now,
    }).requestId).toBe(fixed.requestId);
  });

  it("rejects method, path, content type, header, identity, and signature mutations", () => {
    const request = signed();
    const mutations: Array<{ method?: string; path?: string; headers?: Record<string, string> }> = [
      { method: "GET", path: KNOWLEDGE_PROMOTION_PATH },
      { method: "POST", path: "/wrong" },
      { headers: { "content-type": "text/plain" } },
      { headers: { "x-vennek-key-id": "other-key" } },
      { headers: { "x-vennek-request-id": "not-a-uuid" } },
      { headers: { "x-vennek-timestamp": "1787616001" } },
      { headers: { "x-vennek-nonce": "bad" } },
      { headers: { "x-vennek-signature": "bad" } },
      { headers: { "x-vennek-extra": "unexpected" } },
    ];
    for (const input of mutations) {
      expect(() => authenticatePromotionRequest({
        method: input.method ?? "POST",
        path: input.path ?? KNOWLEDGE_PROMOTION_PATH,
        headers: new Headers({ ...request.headers, ...input.headers }),
        body: Buffer.from(request.body),
        identity,
        now: fixed.now,
      })).toThrow();
    }

    expect(() => authenticatePromotionRequest({
      method: "POST",
      path: KNOWLEDGE_PROMOTION_PATH,
      headers: new Headers(request.headers),
      body: Buffer.from('{"question":"changed"}'),
      identity,
      now: fixed.now,
    })).toThrow();

    const otherKey = Buffer.alloc(32, 8);
    expect(() => authenticatePromotionRequest({
      method: "POST",
      path: KNOWLEDGE_PROMOTION_PATH,
      headers: new Headers(request.headers),
      body: Buffer.from(request.body),
      identity: { keyId: identity.keyId, key: otherKey },
      now: fixed.now,
    })).toThrow();
  });

  it("rejects stale and future timestamps, but accepts the inclusive 60-second boundary", () => {
    const body = Buffer.from('{"question":"latest Cardano node"}');
    const now = fixed.now.getTime() / 1000;
    for (const offset of [-KNOWLEDGE_PROMOTION_CLOCK_SKEW_SECONDS, KNOWLEDGE_PROMOTION_CLOCK_SKEW_SECONDS]) {
      const nonce = Buffer.alloc(16, 4).toString("base64url");
      const headers = new Headers(signed().headers);
      headers.set("x-vennek-timestamp", String(now + offset));
      headers.set("x-vennek-nonce", nonce);
      headers.set("x-vennek-signature", externalSignature(body, now + offset, nonce));
      expect(authenticatePromotionRequest({ method: "POST", path: KNOWLEDGE_PROMOTION_PATH, headers, body, identity, now: fixed.now })).toBeTruthy();
    }
    for (const offset of [-KNOWLEDGE_PROMOTION_CLOCK_SKEW_SECONDS - 1, KNOWLEDGE_PROMOTION_CLOCK_SKEW_SECONDS + 1]) {
      const nonce = Buffer.alloc(16, 4).toString("base64url");
      const headers = new Headers(signed().headers);
      headers.set("x-vennek-timestamp", String(now + offset));
      headers.set("x-vennek-nonce", nonce);
      headers.set("x-vennek-signature", externalSignature(body, now + offset, nonce));
      expect(() => authenticatePromotionRequest({ method: "POST", path: KNOWLEDGE_PROMOTION_PATH, headers, body, identity, now: fixed.now })).toThrow();
    }
  });

  it("requires canonical nonce and signature encodings with exact lengths", () => {
    const request = signed();
    for (const nonce of ["CQkJCQkJCQkJCQkJCQkJCQ=", "CQkJCQkJCQkJCQkJCQkJ+Q", Buffer.alloc(15, 9).toString("base64url")]) {
      expect(() => authenticate(request, { "x-vennek-nonce": nonce })).toThrow();
    }
    for (const signature of [
      `${request.headers["x-vennek-signature"]}=`,
      Buffer.alloc(31, 1).toString("base64url"),
      Buffer.alloc(33, 1).toString("base64url"),
    ]) {
      expect(() => authenticate(request, { "x-vennek-signature": signature })).toThrow();
    }
  });

  it("validates exact canonical keys and copies the secret bytes", () => {
    const keyText = Buffer.alloc(32, 7).toString("base64");
    const parsed = parsePromotionIdentity("agent-worker-v1", keyText);
    expect(parsed.key).toEqual(Buffer.alloc(32, 7));
    expect(parsed.key).not.toBe(Buffer.from(keyText));
    const original = Buffer.alloc(32, 7);
    const direct = parsePromotionIdentity("agent-worker-v1", keyText);
    original.fill(1);
    expect(direct.key).toEqual(Buffer.alloc(32, 7));

    for (const [keyId, key] of [
      ["", keyText],
      ["Agent", keyText],
      ["a_", keyText],
      ["a", Buffer.alloc(16).toString("base64")],
      ["a", `${keyText.slice(0, -1)} `],
      ["a", keyText.replace(/B/, "!")],
      ["a", "A".repeat(42) + "B="],
    ]) {
      expect(() => parsePromotionIdentity(keyId, key)).toThrow();
    }
  });

  it("accepts only a credential-free HTTP(S) origin rooted at slash", () => {
    expect(parsePromotionOrigin("https://knowledge.example.test/").href).toBe("https://knowledge.example.test/");
    expect(parsePromotionOrigin(new URL("http://localhost:8082/")).hostname).toBe("localhost");
    for (const value of [
      "ftp://knowledge.example.test/",
      "https://user:secret@knowledge.example.test/",
      "https://knowledge.example.test/path",
      "https://knowledge.example.test/?q=secret",
      "https://knowledge.example.test/#secret",
      "not a URL",
      null,
    ]) {
      expect(() => parsePromotionOrigin(value)).toThrow();
    }
  });

  it("validates strict UTF-8, exact JSON fields, and bounded safe questions", () => {
    expect(validatePromotionBody(Buffer.from('{"question":"  e\\u0301  "}'))).toEqual({ question: "é" });
    expect(validatePromotionBody(Buffer.from('{"question":"safe"}'))).toEqual({ question: "safe" });
    for (const body of [
      Buffer.from([0xc3, 0x28]),
      Buffer.from("not json"),
      Buffer.from("[]"),
      Buffer.from("null"),
      Buffer.from('{"question":"safe","extra":true}'),
      Buffer.from("{}"),
      Buffer.from('{"question":"bad\\u0000"}'),
      Buffer.from('{"question":"site:cardano"}'),
      Buffer.from('{"question":"addr_xsk1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq"}'),
      Buffer.from('{"question":"\\u0085"}'),
      Buffer.from('{"question":"\\ud800"}'),
    ]) {
      expect(() => validatePromotionBody(body)).toThrow();
    }
    expect(() => validatePromotionQuestion("a".repeat(KNOWLEDGE_PROMOTION_MAX_QUERY_CODE_POINTS + 1))).toThrow();
    expect(() => validatePromotionQuestion("é".repeat(KNOWLEDGE_PROMOTION_MAX_QUERY_BYTES / 2 + 1))).toThrow();
    expect(() => validatePromotionBody(Buffer.from(JSON.stringify({ question: "a".repeat(KNOWLEDGE_PROMOTION_MAX_BODY_BYTES) })))).toThrow();
    const maxBytesQuestion = "😀".repeat(KNOWLEDGE_PROMOTION_MAX_QUERY_CODE_POINTS);
    expect(Buffer.byteLength(validatePromotionQuestion(maxBytesQuestion), "utf8")).toBe(KNOWLEDGE_PROMOTION_MAX_QUERY_BYTES);
    expect(() => validatePromotionQuestion("\u0085")).toThrow();
    expect(() => validatePromotionQuestion("\ud800")).toThrow();
  });

  it("serializes only the question, forbids redirects, accepts only 204, and sanitizes failures", async () => {
    const input: QuestionRetrievalInput = { question: "Cardano?", language: "vi" };
    const fetch = vi.fn(async (_url: URL | RequestInfo, init: RequestInit = {}) => {
      expect(init.method).toBe("POST");
      expect(init.redirect).toBe("error");
      expect(JSON.parse(String(init.body))).toEqual({ question: "Cardano?" });
      expect(String(init.body)).not.toMatch(/language|user|chat|url|source|history/i);
      return new Response(null, { status: 204 });
    });
    const client = new KnowledgePromotionClient({ origin: new URL("http://knowledge-worker:8082/"), identity, fetch });
    await expect(client.promote(input)).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledWith(new URL(`${"http://knowledge-worker:8082"}${KNOWLEDGE_PROMOTION_PATH}`), expect.any(Object));

    for (const response of [new Response(null, { status: 200 }), new Response("private body", { status: 500 })]) {
      const failed = new KnowledgePromotionClient({
        origin: new URL("http://knowledge-worker:8082/"),
        identity,
        fetch: vi.fn(async (): Promise<Response> => response),
      });
      await expect(failed.promote(input)).rejects.toThrow("Knowledge promotion request failed.");
    }

    const network = new KnowledgePromotionClient({
      origin: new URL("http://knowledge-worker:8082/"),
      identity,
      fetch: vi.fn(async (): Promise<Response> => { throw new Error("secret body and key"); }),
    });
    await expect(network.promote(input)).rejects.toThrow("Knowledge promotion request failed.");
    await expect(network.promote(input)).rejects.not.toThrow(/secret|body|key/i);
  });

  it("bounds the injected timeout and aborts with a generic error", async () => {
    expect(() => new KnowledgePromotionClient({ origin: new URL("https://example.test/"), identity, timeoutMs: 0 })).toThrow();
    expect(() => new KnowledgePromotionClient({ origin: new URL("https://example.test/"), identity, timeoutMs: 50_001 })).toThrow();
    const timeout = new KnowledgePromotionClient({
      origin: new URL("https://example.test/"),
      identity,
      timeoutMs: 1,
      fetch: vi.fn((_url: URL | RequestInfo, init: RequestInit = {}) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("secret timeout")), { once: true });
      })),
    });
    await expect(timeout.promote({ question: "Cardano?", language: "en" })).rejects.toThrow("Knowledge promotion request failed.");
  });

  it("does not expose the copied key through JSON or inspection", () => {
    const key = Buffer.alloc(32, 0xa5);
    const client = new KnowledgePromotionClient({
      origin: new URL("https://example.test/"),
      identity: { keyId: "agent-worker-v1", key },
    });
    expect(JSON.stringify(client)).not.toContain('"identity"');
    expect(JSON.stringify(client)).not.toContain(key.toString("hex"));
    expect(inspect(client)).not.toContain("identity");
    expect(inspect(client)).not.toContain(key.toString("hex"));
  });

  it("cancels a non-204 response body before returning the generic failure", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel: () => {
        cancelled = true;
      },
    });
    const client = new KnowledgePromotionClient({
      origin: new URL("https://example.test/"),
      identity,
      fetch: vi.fn(async (): Promise<Response> => ({ status: 500, body } as Response)),
    });
    await expect(client.promote({ question: "Cardano?", language: "en" })).rejects.toThrow("Knowledge promotion request failed.");
    expect(cancelled).toBe(true);
  });

  it("retains the original key when the caller mutates its config buffer", async () => {
    const key = Buffer.alloc(32, 7);
    let captured: { body: string; headers: Record<string, string> } | undefined;
    const client = new KnowledgePromotionClient({
      origin: new URL("https://example.test/"),
      identity: { keyId: "agent-worker-v1", key },
      fetch: vi.fn(async (_url: URL | RequestInfo, init: RequestInit = {}): Promise<Response> => {
        captured = { body: String(init.body), headers: Object.fromEntries(new Headers(init.headers).entries()) };
        return new Response(null, { status: 204 });
      }),
    });
    key.fill(8);
    await client.promote({ question: "Cardano?", language: "en" });
    expect(captured).toBeDefined();
    expect(() => authenticatePromotionRequest({
      method: "POST",
      path: KNOWLEDGE_PROMOTION_PATH,
      headers: new Headers(captured!.headers),
      body: Buffer.from(captured!.body),
      identity: { keyId: "agent-worker-v1", key: Buffer.alloc(32, 7) },
    })).not.toThrow();
  });
});
