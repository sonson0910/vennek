import { createHash, createHmac } from "node:crypto";
import { connect as connectSocket } from "node:net";
import { request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  KNOWLEDGE_PROMOTION_MAX_BODY_BYTES,
  KNOWLEDGE_PROMOTION_PATH,
  signPromotionQuestion,
} from "../apps/telegram-bot/src/knowledgePromotionProtocol.js";
import {
  createKnowledgePromotionServer,
  type KnowledgePromotionServerDependencies,
} from "../apps/telegram-bot/src/knowledgePromotionServer.js";

const identity = { keyId: "agent-worker-v1", key: Buffer.alloc(32, 7) } as const;
const fixed = {
  now: new Date("2026-08-25T00:00:00.000Z"),
  requestId: "11111111-1111-4111-8111-111111111111",
  nonce: Buffer.alloc(16, 9),
};

type FakeAudit = {
  claim: ReturnType<typeof vi.fn>;
  complete: ReturnType<typeof vi.fn>;
  prune: ReturnType<typeof vi.fn>;
};

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => closeForTest(server)));
  vi.useRealTimers();
});

function fakeAudit(
  claim: { kind: "claimed" } | { kind: "running" } | { kind: "conflict" } | { kind: "completed"; outcome: "promoted" | "no_match" | "busy" | "timeout" | "upstream_failed" | "invalid_authenticated_request" } = { kind: "claimed" },
): FakeAudit {
  return {
    claim: vi.fn(async () => claim),
    complete: vi.fn(async () => undefined),
    prune: vi.fn(async () => 0),
  };
}

function serverWith(overrides: Partial<KnowledgePromotionServerDependencies> = {}): {
  server: Server;
  audit: FakeAudit;
  promote: ReturnType<typeof vi.fn>;
} {
  const audit = (overrides.audit as FakeAudit | undefined) ?? fakeAudit();
  const promote = vi.fn(overrides.promote ?? (async () => ({ outcome: "promoted" as const, promotedCount: 1 })));
  const server = createKnowledgePromotionServer({
    identity,
    audit: audit as KnowledgePromotionServerDependencies["audit"],
    promote,
    now: () => fixed.now,
    ...overrides,
  });
  servers.push(server);
  return { server, audit, promote };
}

async function listenForTest(server: Server): Promise<URL> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind TCP.");
  return new URL(`http://127.0.0.1:${address.port}/`);
}

async function closeForTest(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function request(
  origin: URL,
  question = "latest Cardano node",
  headers?: Record<string, string>,
  signingNow = fixed.now,
): Promise<Response> {
  const signed = signPromotionQuestion(question, identity, { ...fixed, now: signingNow });
  return fetch(new URL(KNOWLEDGE_PROMOTION_PATH, origin), {
    method: "POST",
    headers: headers ?? signed.headers,
    body: signed.body,
  });
}

function signedRawBody(body: Buffer | string): Record<string, string> {
  const value = Buffer.from(body);
  const timestamp = String(Math.floor(fixed.now.getTime() / 1_000));
  const nonce = fixed.nonce.toString("base64url");
  const canonical = [
    "VENNEK-PROMOTION-V1",
    "POST",
    KNOWLEDGE_PROMOTION_PATH,
    identity.keyId,
    fixed.requestId,
    timestamp,
    nonce,
    createHash("sha256").update(value).digest("base64url"),
  ].join("\n");
  return {
    "Content-Type": "application/json",
    "X-Vennek-Key-Id": identity.keyId,
    "X-Vennek-Request-Id": fixed.requestId,
    "X-Vennek-Timestamp": timestamp,
    "X-Vennek-Nonce": nonce,
    "X-Vennek-Signature": createHmac("sha256", identity.key).update(canonical).digest("base64url"),
  };
}

async function rawRequest(
  origin: URL,
  headers: Record<string, string | string[]>,
  body: Buffer | string,
): Promise<{ status: number; body: string; headers: IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      origin,
      { method: "POST", path: KNOWLEDGE_PROMOTION_PATH, headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
          headers: response.headers,
        }));
      },
    );
    request.once("error", reject);
    request.end(body);
  });
}

async function streamingOverflow(origin: URL, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = connectSocket(Number(origin.port), origin.hostname);
    let received = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { received += chunk; });
    socket.on("error", reject);
    socket.on("end", () => {
      const match = /^HTTP\/1\.1 (\d+)/u.exec(received);
      resolve({ status: Number(match?.[1] ?? 0), body: received.slice(received.indexOf("\r\n\r\n") + 4) });
    });
    socket.on("connect", () => {
      const lines = Object.entries(headers).map(([name, value]) => `${name}: ${value}`);
      socket.write([
        `POST ${KNOWLEDGE_PROMOTION_PATH} HTTP/1.1`,
        `Host: ${origin.host}`,
        "Connection: close",
        "Transfer-Encoding: chunked",
        ...lines,
        "",
        "",
      ].join("\r\n"));
      const bytes = Buffer.alloc(KNOWLEDGE_PROMOTION_MAX_BODY_BYTES + 1, 65);
      socket.write(`${bytes.byteLength.toString(16)}\r\n`);
      socket.write(bytes);
      socket.end("\r\n0\r\n\r\n");
    });
  });
}

describe("knowledge promotion server", () => {
  it("authenticates, claims, promotes once, and returns no content", async () => {
    const { server, audit, promote } = serverWith();
    const origin = await listenForTest(server);
    const response = await request(origin);

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(promote).toHaveBeenCalledWith("latest Cardano node", expect.any(AbortSignal));
    expect(audit.claim).toHaveBeenCalledWith(expect.objectContaining({
      requestId: fixed.requestId,
      callerId: identity.keyId,
      nonceDigest: createHash("sha256").update(fixed.nonce).digest(),
    }));
    expect(audit.complete).toHaveBeenCalledWith(fixed.requestId, expect.objectContaining({
      outcome: "promoted",
      promotedCount: 1,
    }));
  });

  it("authenticates before parsing or touching the audit repository", async () => {
    const audit = fakeAudit();
    const promote = vi.fn(async () => ({ outcome: "promoted" as const, promotedCount: 1 }));
    const { server } = serverWith({ audit: audit as never, promote });
    const origin = await listenForTest(server);
    const signed = signPromotionQuestion("safe question", identity, fixed);
    const response = await fetch(new URL(KNOWLEDGE_PROMOTION_PATH, origin), {
      method: "POST",
      headers: signed.headers,
      body: "not json",
    });

    expect(response.status).toBe(401);
    expect(await response.text()).toBe("");
    expect(audit.claim).not.toHaveBeenCalled();
    expect(audit.complete).not.toHaveBeenCalled();
    expect(promote).not.toHaveBeenCalled();
  });

  it.each(["X-Vennek-Key-Id", "Content-Type"] as const)("rejects duplicate %s headers before normalized authentication", async (duplicateName) => {
    const audit = fakeAudit();
    const { server } = serverWith({ audit: audit as never });
    const origin = await listenForTest(server);
    const signed = signPromotionQuestion("safe question", identity, fixed);
    const response = await rawRequest(origin, {
      ...signed.headers,
      [duplicateName]: duplicateName === "Content-Type"
        ? ["application/json", "application/json"]
        : [identity.keyId, identity.keyId],
    }, signed.body);

    expect(response.status).toBe(401);
    expect(response.body).toBe("");
    expect(audit.claim).not.toHaveBeenCalled();
  });

  it("rejects oversized declared and streaming bodies with 413 before auth or audit", async () => {
    const audit = fakeAudit();
    const { server } = serverWith({ audit: audit as never });
    const origin = await listenForTest(server);
    const signed = signPromotionQuestion("safe question", identity, fixed);
    const tooLarge = KNOWLEDGE_PROMOTION_MAX_BODY_BYTES + 1;
    const declared = await rawRequest(origin, {
      ...signed.headers,
      "Content-Length": String(tooLarge),
    }, "");
    const streamed = await streamingOverflow(origin, signedRawBody(Buffer.alloc(tooLarge)));

    expect(declared.status).toBe(413);
    expect(declared.body).toBe("");
    expect(streamed.status).toBe(413);
    expect(streamed.body).toBe("");
    expect(audit.claim).not.toHaveBeenCalled();
  });

  it("audits authenticated invalid JSON and returns an empty 400", async () => {
    const audit = fakeAudit();
    const { server } = serverWith({ audit: audit as never });
    const origin = await listenForTest(server);
    const body = Buffer.from("not json");
    const response = await rawRequest(origin, signedRawBody(body), body);

    expect(response.status).toBe(400);
    expect(response.body).toBe("");
    expect(audit.complete).toHaveBeenCalledWith(fixed.requestId, expect.objectContaining({
      outcome: "invalid_authenticated_request",
      promotedCount: 0,
    }));
  });

  it.each([
    ["promoted", 204],
    ["no_match", 204],
    ["invalid_authenticated_request", 400],
    ["busy", 503],
    ["timeout", 503],
    ["upstream_failed", 503],
  ] as const)("maps completed %s replay to %s with no body", async (outcome, status) => {
    const audit = fakeAudit({ kind: "completed", outcome });
    const { server, promote } = serverWith({ audit: audit as never });
    const origin = await listenForTest(server);
    const response = await request(origin);

    expect(response.status).toBe(status);
    expect(await response.text()).toBe("");
    expect(promote).not.toHaveBeenCalled();
  });

  it.each(["running", "conflict"] as const)("maps %s claims to empty 409", async (kind) => {
    const audit = fakeAudit({ kind });
    const { server, promote } = serverWith({ audit: audit as never });
    const origin = await listenForTest(server);
    const response = await request(origin);

    expect(response.status).toBe(409);
    expect(await response.text()).toBe("");
    expect(promote).not.toHaveBeenCalled();
  });

  it("audits a second live claim as busy and returns 503", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const promote = vi.fn(async () => {
      await blocked;
      return { outcome: "promoted" as const, promotedCount: 1 };
    });
    const audit = fakeAudit();
    const { server } = serverWith({ audit: audit as never, promote });
    const origin = await listenForTest(server);
    const first = request(origin);
    await vi.waitFor(() => expect(promote).toHaveBeenCalledTimes(1));
    const second = await request(origin, "a different question");

    expect(second.status).toBe(503);
    expect(await second.text()).toBe("");
    expect(audit.complete).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      outcome: "busy",
      promotedCount: 0,
    }));
    release();
    expect((await first).status).toBe(204);
  });

  it("sanitizes upstream failures and abort timeouts", async () => {
    const upstreamAudit = fakeAudit();
    const upstream = vi.fn(async () => {
      throw new Error("secret question URL provider failure");
    });
    const upstreamServer = serverWith({ audit: upstreamAudit as never, promote: upstream });
    const upstreamOrigin = await listenForTest(upstreamServer.server);
    const upstreamResponse = await request(upstreamOrigin);
    expect(upstreamResponse.status).toBe(503);
    expect(await upstreamResponse.text()).toBe("");
    expect(upstreamAudit.complete).toHaveBeenCalledWith(fixed.requestId, expect.objectContaining({ outcome: "upstream_failed" }));

    const timeoutAudit = fakeAudit();
    const timeout = vi.fn((_question: string, signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("secret timeout")), { once: true });
    }));
    const timeoutServer = serverWith({ audit: timeoutAudit as never, promote: timeout });
    const timeoutOrigin = await listenForTest(timeoutServer.server);
    const timeoutRequest = httpRequest(timeoutOrigin, {
      method: "POST",
      path: KNOWLEDGE_PROMOTION_PATH,
      headers: signPromotionQuestion("latest Cardano node", identity, fixed).headers,
    });
    timeoutRequest.once("error", () => undefined);
    timeoutRequest.end(signPromotionQuestion("latest Cardano node", identity, fixed).body);
    await vi.waitFor(() => expect(timeout).toHaveBeenCalledTimes(1));
    timeoutRequest.destroy();
    await vi.waitFor(() => expect(timeoutAudit.complete).toHaveBeenCalled());
    expect(timeoutAudit.complete).toHaveBeenCalledWith(fixed.requestId, expect.objectContaining({ outcome: "timeout" }));
  });

  it("uses exact routing and never reflects URL or provider errors", async () => {
    const { server, promote } = serverWith({
      promote: vi.fn(async () => { throw new Error("secret URL, question, and provider error"); }),
    });
    const origin = await listenForTest(server);
    const wrongPath = await fetch(new URL("/wrong", origin), { method: "POST", body: "secret URL" });
    const wrongMethod = await fetch(new URL(KNOWLEDGE_PROMOTION_PATH, origin), { method: "GET" });
    const failed = await request(origin, "secret question");
    const body = await failed.text();

    expect(wrongPath.status).toBe(404);
    expect(wrongMethod.status).toBe(405);
    expect(failed.status).toBe(503);
    expect(body).toBe("");
    expect(body).not.toMatch(/secret|URL|question|provider|error/i);
    expect(promote).toHaveBeenCalledTimes(1);
  });

  it("prunes at most once per hour and advances the schedule after failure", async () => {
    let current = fixed.now.getTime();
    const audit = fakeAudit();
    audit.prune.mockRejectedValue(new Error("database secret"));
    const { server } = serverWith({ audit: audit as never, now: () => new Date(current) });
    const origin = await listenForTest(server);

    await request(origin);
    await vi.waitFor(() => expect(audit.prune).toHaveBeenCalledTimes(1));
    await request(origin, "second question");
    expect(audit.prune).toHaveBeenCalledTimes(1);
    current += 60 * 60 * 1_000;
    await request(origin, "third question", undefined, new Date(current));
    await vi.waitFor(() => expect(audit.prune).toHaveBeenCalledTimes(2));
  });
});
