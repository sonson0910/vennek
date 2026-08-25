import * as http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { Worker } from "node:worker_threads";
import {
  PRIVATE_DOCUMENT_MAX_BYTES,
  PRIVATE_DOCUMENT_MAX_TEXT_BYTES,
  PRIVATE_DOCUMENT_PATH,
  PRIVATE_DOCUMENT_TIMEOUT_MS,
  validatePrivateDocumentToken,
  validatePrivateExtractionResult,
  type PrivateExtractionResult,
} from "./privateDocumentProtocol.js";
import type { PrivateDocumentMetadata } from "./privateDocumentWorker.js";

export const PRIVATE_DOCUMENT_FILE_NAME_HEADER = "x-private-document-file-name";
export const PRIVATE_DOCUMENT_MIME_HEADER = "x-private-document-mime";
export const PRIVATE_DOCUMENT_MAX_WIRE_RESPONSE_BYTES = PRIVATE_DOCUMENT_MAX_TEXT_BYTES * 2 + 65_536;

export type PrivateDocumentWorkerLike = {
  postMessage: (value: unknown, transferList?: readonly ArrayBuffer[]) => void;
  on: (event: "message" | "error" | "exit", listener: (...args: any[]) => void) => PrivateDocumentWorkerLike;
  removeListener: (event: "message" | "error" | "exit", listener: (...args: any[]) => void) => PrivateDocumentWorkerLike;
  terminate: () => Promise<number>;
};
export type WorkerLike = PrivateDocumentWorkerLike;

export type PrivateDocumentServerOptions = {
  token: string;
  timeoutMs?: number;
  workerFactory?: () => PrivateDocumentWorkerLike;
};

export type PrivateDocumentServer = {
  server: http.Server;
  listen(port: number, host?: string): Promise<void>;
  close(): Promise<void>;
};

const WORKER_URL = new URL("./privateDocumentWorkerThread.js", import.meta.url);
const MAX_FILE_NAME_BYTES = 1024;
const MAX_MIME_BYTES = 256;
const MAX_HEADER_SIZE = 16 * 1024;
const MAX_HEADERS_COUNT = 64;
const processPrivateDocumentState: { state: "available" | "busy" | "poisoned" } = { state: "available" };

class PrivateDocumentServiceError extends Error {
  constructor(readonly statusCode: number, message: string, readonly poisonSlot = false) {
    super(message);
    this.name = "PrivateDocumentServiceError";
  }
}

function defaultWorkerFactory(): PrivateDocumentWorkerLike {
  return new Worker(WORKER_URL, {
    resourceLimits: {
      maxOldGenerationSizeMb: 96,
      maxYoungGenerationSizeMb: 16,
      stackSizeMb: 4,
    },
  }) as unknown as PrivateDocumentWorkerLike;
}

export function createPrivateDocumentServer(options: PrivateDocumentServerOptions): PrivateDocumentServer {
  const expectedToken = validatePrivateDocumentToken(options.token);
  const timeoutMs = options.timeoutMs ?? PRIVATE_DOCUMENT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > PRIVATE_DOCUMENT_TIMEOUT_MS) {
    throw new Error("Private extractor timeout is invalid");
  }
  const workerFactory = options.workerFactory ?? defaultWorkerFactory;
  const state = processPrivateDocumentState;

  const server = http.createServer({
    headersTimeout: 10_000,
    requestTimeout: 30_000,
    connectionsCheckingInterval: 1_000,
    maxHeaderSize: MAX_HEADER_SIZE,
  }, (request, response) => {
    void handleRequest(request, response).catch(() => {
      if (!response.destroyed && !response.headersSent) {
        sendError(response, 503, "Private document extraction unavailable");
      } else if (!response.destroyed) {
        response.destroy();
      }
    });
  });
  server.maxHeadersCount = MAX_HEADERS_COUNT;

  async function handleRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    if (request.method !== "POST" || request.url !== PRIVATE_DOCUMENT_PATH) {
      sendError(response, 404, "Private document request rejected");
      return;
    }
    if (!matchesBearer(expectedToken, request.headers.authorization)) {
      sendError(response, 401, "Private document request rejected");
      return;
    }
    if (headerValue(request.headers["content-type"]) !== "application/octet-stream") {
      sendError(response, 415, "Private document request rejected");
      return;
    }
    if (request.headers["transfer-encoding"] !== undefined) {
      sendError(response, 415, "Private document request rejected");
      return;
    }

    let metadata: PrivateDocumentMetadata;
    try {
      metadata = readMetadata(request.headers);
    } catch {
      sendError(response, 422, "Private document request rejected");
      return;
    }

    const contentLengthHeader = request.headers["content-length"];
    const contentLength = parseContentLength(contentLengthHeader);
    if (contentLength === undefined) {
      sendError(response, 413, "Private document request rejected");
      return;
    }
    if (state.state === "poisoned") {
      sendError(response, 503, "Private document extraction unavailable");
      return;
    }
    if (state.state === "busy") {
      sendError(response, 429, "Private document extraction unavailable");
      return;
    }

    state.state = "busy";
    const abortController = new AbortController();
    const deadlineAt = Date.now() + timeoutMs;
    const deadlineTimer = setTimeout(() => abortController.abort(new PrivateDocumentServiceError(504, "Private document extraction timed out")), timeoutMs);
    const abortRequest = () => abortController.abort(new PrivateDocumentServiceError(504, "Private document extraction aborted"));
    const abortResponse = () => {
      if (!response.writableEnded) abortController.abort(new PrivateDocumentServiceError(504, "Private document extraction aborted"));
    };
    request.once("aborted", abortRequest);
    response.once("close", abortResponse);

    let input: Buffer | undefined;
    try {
      input = await readRequestBody(request, contentLength, abortController.signal);
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) throw new PrivateDocumentServiceError(504, "Private document extraction timed out");
      const result = await runPrivateDocumentWorker(input, metadata, workerFactory, remainingMs, abortController.signal);
      const validated = validatePrivateExtractionResult(result);
      const payload = Buffer.from(JSON.stringify(validated));
      if (payload.byteLength > PRIVATE_DOCUMENT_MAX_WIRE_RESPONSE_BYTES) {
        payload.fill(0);
        throw new PrivateDocumentServiceError(503, "Private document extraction unavailable");
      }
      sendJson(response, 200, payload);
    } catch (error) {
      if (error instanceof PrivateDocumentServiceError && error.poisonSlot) state.state = "poisoned";
      if (response.destroyed) return;
      if (response.headersSent) {
        response.destroy();
      } else if (error instanceof PrivateDocumentServiceError) {
        sendError(response, error.statusCode, error.message);
      } else {
        sendError(response, 503, "Private document extraction unavailable");
      }
    } finally {
      input?.fill(0);
      request.off("aborted", abortRequest);
      response.off("close", abortResponse);
      clearTimeout(deadlineTimer);
      if (state.state === "busy") state.state = "available";
    }
  }

  return {
    server,
    listen(port, host = "127.0.0.1") {
      return new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
      });
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}

export async function runPrivateDocumentWorker(
  bytes: Uint8Array,
  metadata: PrivateDocumentMetadata,
  workerFactory: () => PrivateDocumentWorkerLike = defaultWorkerFactory,
  timeoutMs = PRIVATE_DOCUMENT_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<PrivateExtractionResult> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > PRIVATE_DOCUMENT_MAX_BYTES) {
    throw new PrivateDocumentServiceError(413, "Private document request rejected");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > PRIVATE_DOCUMENT_TIMEOUT_MS) {
    throw new Error("Private extractor timeout is invalid");
  }

  const transferred = Uint8Array.from(bytes).buffer;
  const worker = workerFactory();
  return new Promise<PrivateExtractionResult>((resolve, reject) => {
    const deadlineAt = Date.now() + timeoutMs;
    let settled = false;
    let finishing = false;
    let terminationTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => finish(new PrivateDocumentServiceError(504, "Private document extraction timed out")), timeoutMs);

    const onAbort = () => {
      const reason = signal?.reason;
      finish(reason instanceof PrivateDocumentServiceError ? reason : new PrivateDocumentServiceError(504, "Private document extraction aborted"));
    };
    const finish = (error?: Error, result?: PrivateExtractionResult) => {
      if (finishing || settled) return;
      finishing = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      worker.removeListener("message", onMessage);
      worker.removeListener("error", onError);
      worker.removeListener("exit", onExit);

      let termination: Promise<number> | undefined;
      let terminationFailed = false;
      try {
        termination = worker.terminate();
      } catch {
        terminationFailed = true;
        termination = undefined;
      }

      const settle = (terminationTimedOut: boolean) => {
        if (settled) return;
        settled = true;
        if (terminationTimer !== undefined) clearTimeout(terminationTimer);
        if (terminationTimedOut) {
          reject(new PrivateDocumentServiceError(504, "Private document extraction timed out", true));
        } else if (terminationFailed) {
          reject(new PrivateDocumentServiceError(
            error instanceof PrivateDocumentServiceError ? error.statusCode : 503,
            error?.message ?? "Private document extraction unavailable",
            true,
          ));
        } else if (error) {
          reject(error);
        } else if (result !== undefined) {
          resolve(result);
        } else {
          reject(new PrivateDocumentServiceError(503, "Private document extraction unavailable"));
        }
      };

      const remainingMs = deadlineAt - Date.now();
      if (termination === undefined) {
        settle(true);
        return;
      }
      if (remainingMs <= 0) {
        terminationTimer = setTimeout(() => settle(true), 0);
        void termination.then(() => settle(false), () => {
          terminationFailed = true;
          settle(false);
        });
        return;
      }
      terminationTimer = setTimeout(() => settle(true), remainingMs);
      void termination.then(() => settle(false), () => {
        terminationFailed = true;
        settle(false);
      });
    };

    const onMessage = (message: unknown) => {
      if (message === null || typeof message !== "object") {
        finish(new PrivateDocumentServiceError(503, "Private document extraction unavailable"));
        return;
      }
      const value = message as { ok?: unknown; result?: unknown };
      if (value.ok !== true) {
        finish(new PrivateDocumentServiceError(503, "Private document extraction unavailable"));
        return;
      }
      try {
        finish(undefined, validatePrivateExtractionResult(value.result));
      } catch {
        finish(new PrivateDocumentServiceError(503, "Private document extraction unavailable"));
      }
    };
    const onError = () => finish(new PrivateDocumentServiceError(503, "Private document extraction unavailable"));
    const onExit = () => finish(new PrivateDocumentServiceError(503, "Private document extraction unavailable"));

    worker.on("message", onMessage);
    worker.on("error", onError);
    worker.on("exit", onExit);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      worker.postMessage({ bytes: transferred, metadata }, [transferred]);
    } catch {
      finish(new PrivateDocumentServiceError(503, "Private document extraction unavailable"));
    }
  });
}

function matchesBearer(expected: Buffer, header: string | string[] | undefined): boolean {
  const value = typeof header === "string" ? /^Bearer ([A-Za-z0-9_-]{43})$/u.exec(header)?.[1] : undefined;
  const actual = value === undefined ? Buffer.alloc(32) : decodeToken(value);
  return timingSafeEqual(expected, actual) && value !== undefined;
}

function decodeToken(value: string): Buffer {
  try {
    const token = validatePrivateDocumentToken(value);
    return token;
  } catch {
    return Buffer.alloc(32);
  }
}

function readMetadata(headers: http.IncomingHttpHeaders): PrivateDocumentMetadata {
  const fileName = decodeMetadata(headers[PRIVATE_DOCUMENT_FILE_NAME_HEADER], MAX_FILE_NAME_BYTES);
  const mime = decodeMetadata(headers[PRIVATE_DOCUMENT_MIME_HEADER], MAX_MIME_BYTES);
  if (fileName.trim().length === 0 || mime.trim().length === 0) throw new Error("metadata");
  return { fileName, mime };
}

function decodeMetadata(value: string | string[] | undefined, maxBytes: number): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("metadata");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.byteLength < 1 || bytes.byteLength > maxBytes || bytes.toString("base64url") !== value) throw new Error("metadata");
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("metadata");
  }
  if (/\p{Cc}|\p{Cf}|\p{Zl}|\p{Zp}/u.test(decoded)) throw new Error("metadata");
  return decoded;
}

function parseContentLength(value: string | string[] | undefined): number | undefined {
  if (typeof value !== "string" || !/^[1-9]\d*$/u.test(value)) return undefined;
  const length = Number(value);
  return Number.isSafeInteger(length) && length >= 1 && length <= PRIVATE_DOCUMENT_MAX_BYTES ? length : undefined;
}

function headerValue(value: string | string[] | undefined): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

async function readRequestBody(request: http.IncomingMessage, expectedLength: number, signal: AbortSignal): Promise<Buffer> {
  const buffer = Buffer.alloc(expectedLength);
  let offset = 0;
  const read = async (): Promise<Buffer> => {
    try {
      for await (const chunk of request) {
        if (signal.aborted) throw abortReason(signal);
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (bytes.byteLength === 0) continue;
        if (bytes.byteLength > expectedLength - offset) {
          request.resume();
          throw new PrivateDocumentServiceError(422, "Private document request rejected");
        }
        bytes.copy(buffer, offset);
        offset += bytes.byteLength;
      }
      if (signal.aborted) throw abortReason(signal);
    } catch (error) {
      buffer.fill(0);
      if (error instanceof PrivateDocumentServiceError) throw error;
      if (signal.aborted) throw abortReason(signal);
      throw new PrivateDocumentServiceError(422, "Private document request rejected");
    }
    if (offset !== expectedLength) {
      buffer.fill(0);
      throw new PrivateDocumentServiceError(422, "Private document request rejected");
    }
    return buffer;
  };

  let abort!: () => void;
  const aborted = new Promise<Buffer>((_, reject) => {
    abort = () => {
      request.resume();
      reject(abortReason(signal));
    };
  });
  signal.addEventListener("abort", abort, { once: true });
  try {
    return await Promise.race([read(), aborted]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

function abortReason(signal: AbortSignal): PrivateDocumentServiceError {
  return signal.reason instanceof PrivateDocumentServiceError
    ? signal.reason
    : new PrivateDocumentServiceError(504, "Private document extraction aborted");
}

function sendError(response: http.ServerResponse, statusCode: number, message: string): void {
  sendJson(response, statusCode, Buffer.from(JSON.stringify({ error: message })));
}

function sendJson(response: http.ServerResponse, statusCode: number, body: Buffer): void {
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    body.fill(0);
    response.off("finish", cleanup);
    response.off("close", cleanup);
  };
  response.once("finish", cleanup);
  response.once("close", cleanup);
  try {
    response.writeHead(statusCode, {
      "content-type": "application/json",
      "content-length": body.byteLength,
      connection: "close",
      "cache-control": "no-store",
    });
    response.end(body);
  } catch (error) {
    cleanup();
    throw error;
  }
}

async function main(): Promise<void> {
  const token = process.env.PRIVATE_DOCUMENT_EXTRACTOR_TOKEN;
  if (!token) {
    process.exitCode = 1;
    return;
  }
  const port = Number(process.env.PRIVATE_DOCUMENT_EXTRACTOR_PORT ?? process.env.PORT ?? 8082);
  const service = createPrivateDocumentServer({ token });
  await service.listen(port, "0.0.0.0");
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("/privateDocumentServer.js")) {
  void main().catch(() => {
    process.exitCode = 1;
  });
}
