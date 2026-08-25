import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { PromotionAuditRepository } from "@vennek/cardano-agent";
import {
  KNOWLEDGE_PROMOTION_MAX_BODY_BYTES,
  KNOWLEDGE_PROMOTION_PATH,
  authenticatePromotionRequest,
  validatePromotionBody,
  type PromotionIdentity,
} from "./knowledgePromotionProtocol.js";

const MAX_HEADER_SIZE = 8 * 1024;
const PROMOTION_TIMEOUT_MS = 45_000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1_000;
const MAX_LATENCY_MS = 3_600_000;

type PromotionResult = Readonly<{
  outcome: "promoted" | "no_match";
  promotedCount: number;
}>;

export type KnowledgePromotionServerDependencies = Readonly<{
  identity: PromotionIdentity;
  audit: Pick<PromotionAuditRepository, "claim" | "complete" | "prune">;
  promote: (question: string, signal: AbortSignal) => Promise<PromotionResult>;
  now?: () => Date;
}>;

export function createKnowledgePromotionServer(
  dependencies: KnowledgePromotionServerDependencies,
): Server {
  let active = false;
  let nextPruneAt = 0;
  const now = dependencies.now ?? (() => new Date());
  const server = createHttpServer({ maxHeaderSize: MAX_HEADER_SIZE }, (request, response) => {
    void handleRequest(request, response).catch(() => sendStatus(response, 503));
  });

  return server;

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.url !== KNOWLEDGE_PROMOTION_PATH) {
      sendStatus(response, 404);
      request.resume();
      return;
    }
    if (request.method !== "POST") {
      sendStatus(response, 405);
      request.resume();
      return;
    }
    if (hasDuplicateSecurityHeader(request.rawHeaders)) {
      rejectAndDrain(request, response, 401);
      return;
    }

    let headers: Headers;
    try {
      headers = toHeaders(request.rawHeaders);
    } catch {
      rejectAndDrain(request, response, 401);
      return;
    }
    const declaredLength = contentLength(request.headers["content-length"]);
    if (declaredLength !== undefined && declaredLength > KNOWLEDGE_PROMOTION_MAX_BODY_BYTES) {
      rejectAndDrain(request, response, 413);
      return;
    }

    const rawBody = await readBody(request, response);
    if (rawBody === undefined) return;

    let authenticated: ReturnType<typeof authenticatePromotionRequest>;
    try {
      authenticated = authenticatePromotionRequest({
        method: request.method,
        path: request.url,
        headers,
        body: rawBody,
        identity: dependencies.identity,
        now: currentDate(),
      });
    } catch {
      sendStatus(response, 401);
      return;
    }

    let claim: Awaited<ReturnType<KnowledgePromotionServerDependencies["audit"]["claim"]>>;
    try {
      claim = await dependencies.audit.claim({
        requestId: authenticated.requestId,
        callerId: dependencies.identity.keyId,
        nonceDigest: authenticated.nonceDigest,
      });
    } catch {
      sendStatus(response, 503);
      return;
    }
    if (claim.kind === "completed") {
      sendStatus(response, statusForOutcome(claim.outcome));
      return;
    }
    if (claim.kind === "running" || claim.kind === "conflict") {
      sendStatus(response, 409);
      return;
    }

    maybePrune();
    const startedAt = currentDate().getTime();
    let body: { question: string };
    try {
      body = validatePromotionBody(rawBody);
    } catch {
      try {
        await finish(authenticated.requestId, "invalid_authenticated_request", 0, startedAt);
        sendStatus(response, 400);
      } catch {
        sendStatus(response, 503);
      }
      return;
    }

    if (active) {
      try {
        await finish(authenticated.requestId, "busy", 0, startedAt);
      } catch {
        // Keep the response generic even when audit completion fails.
      }
      sendStatus(response, 503);
      return;
    }

    active = true;
    const requestSignal = createRequestSignal(request, response);
    try {
      const result = await dependencies.promote(body.question, requestSignal.signal);
      requestSignal.signal.throwIfAborted();
      await finish(authenticated.requestId, result.outcome, result.promotedCount, startedAt);
      sendStatus(response, 204);
    } catch {
      const outcome = requestSignal.signal.aborted ? "timeout" : "upstream_failed";
      try {
        await finish(authenticated.requestId, outcome, 0, startedAt);
      } catch {
        // Keep the response generic even when audit completion fails.
      }
      sendStatus(response, 503);
    } finally {
      requestSignal.cleanup();
      active = false;
    }
  }

  function currentDate(): Date {
    try {
      const value = now();
      if (value instanceof Date && Number.isFinite(value.getTime())) return value;
    } catch {
      // Use the system clock for safe audit metadata.
    }
    return new Date();
  }

  function maybePrune(): void {
    const date = currentDate();
    const at = date.getTime();
    if (at < nextPruneAt) return;
    nextPruneAt = at + PRUNE_INTERVAL_MS;
    void Promise.resolve().then(() => dependencies.audit.prune(date)).catch(() => undefined);
  }

  async function finish(
    requestId: string,
    outcome: "promoted" | "no_match" | "busy" | "timeout" | "upstream_failed" | "invalid_authenticated_request",
    promotedCount: number,
    startedAt: number,
  ): Promise<void> {
    const elapsed = currentDate().getTime() - startedAt;
    const latencyMs = Number.isFinite(elapsed)
      ? Math.max(0, Math.min(MAX_LATENCY_MS, Math.floor(elapsed)))
      : MAX_LATENCY_MS;
    await dependencies.audit.complete(requestId, { outcome, promotedCount, latencyMs });
  }
}

function statusForOutcome(
  outcome: "promoted" | "no_match" | "busy" | "timeout" | "upstream_failed" | "invalid_authenticated_request",
): number {
  if (outcome === "promoted" || outcome === "no_match") return 204;
  if (outcome === "invalid_authenticated_request") return 400;
  if (outcome === "busy" || outcome === "timeout" || outcome === "upstream_failed") return 503;
  return 503;
}

function contentLength(value: string | string[] | undefined): number | undefined {
  if (value === undefined || Array.isArray(value) || !/^\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

async function readBody(request: IncomingMessage, response: ServerResponse): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const done = (value: Buffer | undefined): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    request.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.byteLength;
      if (total > KNOWLEDGE_PROMOTION_MAX_BODY_BYTES) {
        sendStatus(response, 413);
        request.resume();
        done(undefined);
        return;
      }
      chunks.push(bytes);
    });
    request.once("end", () => done(Buffer.concat(chunks, total)));
    request.once("aborted", () => {
      if (!settled) reject(new Error("Request aborted."));
    });
    request.once("error", (error) => {
      if (!settled) reject(error);
    });
  });
}

function hasDuplicateSecurityHeader(rawHeaders: readonly string[]): boolean {
  const seen = new Set<string>();
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index]?.toLowerCase();
    if (name !== "content-type" && !name?.startsWith("x-vennek-")) continue;
    if (seen.has(name)) return true;
    seen.add(name);
  }
  return false;
}

function toHeaders(rawHeaders: readonly string[]): Headers {
  const headers = new Headers();
  for (let index = 0; index < rawHeaders.length; index += 2) {
    headers.append(rawHeaders[index]!, rawHeaders[index + 1]!);
  }
  return headers;
}

function rejectAndDrain(request: IncomingMessage, response: ServerResponse, status: number): void {
  sendStatus(response, status);
  request.resume();
}

function sendStatus(response: ServerResponse, status: number): void {
  if (response.writableEnded || response.destroyed) return;
  response.statusCode = status;
  response.removeHeader("Content-Type");
  response.end();
}

function createRequestSignal(request: IncomingMessage, response: ServerResponse): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const client = new AbortController();
  const abort = (): void => client.abort();
  const onRequestClose = (): void => {
    if (!request.complete) abort();
  };
  const onResponseClose = (): void => {
    if (!response.writableEnded) abort();
  };
  request.once("aborted", abort);
  request.once("close", onRequestClose);
  response.once("close", onResponseClose);
  const signal = AbortSignal.any([client.signal, AbortSignal.timeout(PROMOTION_TIMEOUT_MS)]);
  return {
    signal,
    cleanup: () => {
      request.off("aborted", abort);
      request.off("close", onRequestClose);
      response.off("close", onResponseClose);
    },
  };
}
