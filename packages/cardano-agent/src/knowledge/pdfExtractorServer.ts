import * as http from "node:http";
import { Worker } from "node:worker_threads";
import {
  PDF_EXTRACTOR_HEALTH_PATH,
  PDF_EXTRACTOR_PATH,
  PDF_MAX_INPUT_BYTES,
  PDF_MAX_WIRE_RESPONSE_BYTES,
  PDF_SERVER_TIMEOUT_MS,
  PdfExtractorError,
  decodePdfExtractorToken,
  tokenMatches,
  validatePdfExtractionResult,
} from "./pdfExtractorProtocol.js";
import type { PdfExtractionResult } from "./pdfExtractorProtocol.js";

export type WorkerLike = {
  postMessage: (value: ArrayBuffer, transferList?: readonly ArrayBuffer[]) => void;
  on: (event: "message" | "error" | "exit", listener: (...args: any[]) => void) => WorkerLike;
  removeListener: (event: "message" | "error" | "exit", listener: (...args: any[]) => void) => WorkerLike;
  terminate: () => Promise<number>;
};

export type PdfExtractorServerOptions = {
  token: string;
  timeoutMs?: number;
  workerFactory?: () => WorkerLike;
};

export type PdfExtractorServer = {
  server: http.Server;
  listen(port: number, host?: string): Promise<void>;
  close(): Promise<void>;
};

const WORKER_URL = new URL("./pdfExtractorWorker.js", import.meta.url);

function defaultWorkerFactory(): WorkerLike {
  const worker = new Worker(WORKER_URL, {
    resourceLimits: {
      maxOldGenerationSizeMb: 96,
      maxYoungGenerationSizeMb: 16,
      stackSizeMb: 4,
    },
  });
  return worker as unknown as WorkerLike;
}

export function createPdfExtractorServer(options: PdfExtractorServerOptions): PdfExtractorServer {
  if (!decodePdfExtractorToken(options.token)) throw new Error("PDF extractor token is invalid");
  const timeoutMs = options.timeoutMs ?? PDF_SERVER_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("PDF extractor timeout is invalid");
  const workerFactory = options.workerFactory ?? defaultWorkerFactory;
  let active = false;

  const server = http.createServer((request, response) => {
    void handleRequest(request, response).catch(() => {
      if (!response.destroyed && !response.headersSent) sendError(response, 503, "PDF extractor unavailable");
      else if (!response.destroyed) response.destroy();
    });
  });

  async function handleRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    if (request.method === "GET" && request.url === PDF_EXTRACTOR_HEALTH_PATH) {
      sendJson(response, 200, { status: "ok" });
      return;
    }
    if (request.method !== "POST" || request.url !== PDF_EXTRACTOR_PATH) {
      sendError(response, 415, "Unsupported endpoint");
      return;
    }
    const authorization = request.headers.authorization;
    const token = parseBearer(authorization);
    if (!token || !tokenMatches(options.token, token)) {
      sendError(response, 401, "Unauthorized");
      return;
    }
    const contentType = headerValue(request.headers["content-type"]);
    if (contentType !== "application/pdf") {
      sendError(response, 415, "Content-Type must be application/pdf");
      return;
    }
    if (request.headers["transfer-encoding"] !== undefined) {
      sendError(response, 415, "Chunked transfer is not supported");
      return;
    }
    const contentLengthHeader = request.headers["content-length"];
    if (Array.isArray(contentLengthHeader) || !contentLengthHeader || !/^\d+$/.test(contentLengthHeader)) {
      sendError(response, 422, "Content-Length is required");
      return;
    }
    const contentLength = Number(contentLengthHeader);
    if (!Number.isSafeInteger(contentLength) || contentLength < 1 || contentLength > PDF_MAX_INPUT_BYTES) {
      sendError(response, 413, "PDF body must be between 1 byte and 8 MiB");
      return;
    }
    if (active) {
      sendError(response, 503, "PDF extractor busy");
      return;
    }
    active = true;
    const requestAbort = new AbortController();
    const deadlineAt = Date.now() + timeoutMs;
    const deadlineTimer = setTimeout(() => {
      requestAbort.abort(new PdfExtractorError("PDF extractor timed out", 504));
    }, timeoutMs);
    const abortRequest = () => requestAbort.abort(new PdfExtractorError("PDF extractor request aborted", 504));
    const abortResponse = () => {
      if (!response.writableEnded) requestAbort.abort(new PdfExtractorError("PDF extractor request aborted", 504));
    };
    request.once("aborted", abortRequest);
    response.once("close", abortResponse);
    try {
      const bytes = await readRequestBody(request, contentLength, requestAbort.signal);
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) throw new PdfExtractorError("PDF extractor timed out", 504);
      const result = await runPdfExtractorWorker(bytes, workerFactory, remainingMs, requestAbort.signal);
      const validated = validatePdfExtractionResult(result);
      if (Buffer.byteLength(JSON.stringify(validated)) > PDF_MAX_WIRE_RESPONSE_BYTES) {
        throw new PdfExtractorError("PDF extractor output is too large", 422);
      }
      sendJson(response, 200, validated);
    } catch (error) {
      if (response.destroyed) return;
      if (response.headersSent) {
        response.destroy();
      } else if (error instanceof PdfExtractorError && error.statusCode) {
        sendError(response, error.statusCode, error.message);
      } else if (error instanceof Error && error.message === "PDF extractor timed out") {
        sendError(response, 504, "PDF extraction timed out");
      } else if (error instanceof Error && /body|Content-Length/i.test(error.message)) {
        sendError(response, 422, error.message);
      } else {
        sendError(response, 503, "PDF extraction unavailable");
      }
    } finally {
      request.off("aborted", abortRequest);
      response.off("close", abortResponse);
      clearTimeout(deadlineTimer);
      active = false;
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

export async function runPdfExtractorWorker(
  bytes: Uint8Array,
  workerFactory: () => WorkerLike = defaultWorkerFactory,
  timeoutMs = PDF_SERVER_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<PdfExtractionResult> {
  const exactBuffer = Uint8Array.from(bytes).buffer;
  const worker = workerFactory();
  return new Promise<PdfExtractionResult>((resolve, reject) => {
    const deadlineAt = Date.now() + timeoutMs;
    let settled = false;
    let finishing = false;
    let terminationTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => finish(new PdfExtractorError("PDF extractor timed out", 504)), timeoutMs);
    const onAbort = () => {
      const reason = signal?.reason;
      finish(reason instanceof PdfExtractorError ? reason : new PdfExtractorError("PDF extractor request aborted", 504));
    };
    const finish = (error?: Error, result?: PdfExtractionResult) => {
      if (finishing || settled) return;
      finishing = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      worker.removeListener("message", onMessage);
      worker.removeListener("error", onError);
      worker.removeListener("exit", onExit);
      let termination: Promise<number> | undefined;
      try {
        termination = worker.terminate();
      } catch {
        termination = undefined;
      }
      const settle = (terminationTimedOut: boolean) => {
        if (settled) return;
        settled = true;
        if (terminationTimer !== undefined) clearTimeout(terminationTimer);
        if (terminationTimedOut || Date.now() >= deadlineAt) {
          reject(new PdfExtractorError("PDF extractor timed out", 504));
        } else if (error) {
          reject(error);
        } else {
          resolve(result!);
        }
      };
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) {
        if (termination !== undefined) void termination.catch(() => undefined);
        settle(true);
        return;
      }
      terminationTimer = setTimeout(() => settle(true), remainingMs);
      if (termination !== undefined) void termination.then(() => settle(false), () => undefined);
    };
    const onMessage = (message: unknown) => {
      if (!message || typeof message !== "object") {
        finish(new PdfExtractorError("Malformed extractor output", 422));
        return;
      }
      const value = message as { ok?: unknown; result?: unknown };
      if (value.ok !== true) {
        finish(new PdfExtractorError("PDF parsing failed", 422));
        return;
      }
      try {
        finish(undefined, validatePdfExtractionResult(value.result));
      } catch (error) {
        finish(error instanceof PdfExtractorError ? error : new PdfExtractorError("Malformed extractor output", 422));
      }
    };
    const onError = () => finish(new PdfExtractorError("PDF parsing failed", 422));
    const onExit = (code: number) => {
      if (!settled) finish(new PdfExtractorError(code === 0 ? "PDF parser exited without output" : "PDF parser exited", 422));
    };
    worker.on("message", onMessage);
    worker.on("error", onError);
    worker.on("exit", onExit);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      worker.postMessage(exactBuffer, [exactBuffer]);
    } catch (error) {
      finish(error instanceof Error ? error : new Error("PDF parser failed"));
    }
  });
}

function parseBearer(value: string | string[] | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(value);
  return match?.[1];
}

function headerValue(value: string | string[] | undefined): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

async function readRequestBody(request: http.IncomingMessage, expectedLength: number, signal?: AbortSignal): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let total = 0;
  const read = async (): Promise<Uint8Array> => {
    try {
      for await (const chunk of request) {
        if (signal?.aborted) throw abortReason(signal);
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += bytes.byteLength;
        if (total > expectedLength || total > PDF_MAX_INPUT_BYTES) {
          request.resume();
          throw new PdfExtractorError("PDF body is larger than Content-Length", 413);
        }
        chunks.push(bytes);
      }
      if (signal?.aborted) throw abortReason(signal);
    } catch (error) {
      if (error instanceof PdfExtractorError) throw error;
      if (signal?.aborted) throw abortReason(signal);
      throw new PdfExtractorError("PDF request body failed", 422);
    }
    if (total !== expectedLength) throw new PdfExtractorError("PDF body does not match Content-Length", 422);
    return Buffer.concat(chunks, total);
  };
  if (!signal) return read();
  let abort!: () => void;
  const aborted = new Promise<Uint8Array>((_, reject) => {
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

function abortReason(signal: AbortSignal): PdfExtractorError {
  return signal.reason instanceof PdfExtractorError
    ? signal.reason
    : new PdfExtractorError("PDF extractor request aborted", 504);
}

function sendError(response: http.ServerResponse, statusCode: number, message: string): void {
  sendJson(response, statusCode, { error: message.slice(0, 512) });
}

function sendJson(response: http.ServerResponse, statusCode: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": body.byteLength,
    connection: "close",
  });
  response.end(body);
}

async function main(): Promise<void> {
  const token = process.env.PDF_EXTRACTOR_TOKEN;
  if (!token) {
    process.exitCode = 1;
    return;
  }
  const port = Number(process.env.PDF_EXTRACTOR_PORT ?? process.env.PORT ?? 8081);
  const service = createPdfExtractorServer({ token });
  await service.listen(port, "0.0.0.0");
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("/pdfExtractorServer.js")) {
  void main().catch(() => {
    process.exitCode = 1;
  });
}
