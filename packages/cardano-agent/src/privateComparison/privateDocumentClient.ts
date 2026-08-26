import * as http from "node:http";
import {
  PRIVATE_DOCUMENT_MAX_BYTES,
  PRIVATE_DOCUMENT_PATH,
  PRIVATE_DOCUMENT_TIMEOUT_MS,
  isPrivateDocumentFailureCategory,
  validatePrivateDocumentToken,
  validatePrivateExtractionResult,
  type PrivateDocumentFailureCategory,
  type PrivateExtractionResult,
} from "./privateDocumentProtocol.js";
import {
  PRIVATE_DOCUMENT_FILE_NAME_HEADER,
  PRIVATE_DOCUMENT_MAX_WIRE_RESPONSE_BYTES,
  PRIVATE_DOCUMENT_MIME_HEADER,
} from "./privateDocumentServer.js";
import type { PrivateDocumentMetadata } from "./privateDocumentWorker.js";

export type PrivateDocumentClientConfig = {
  url: string;
  token: string;
  /** Test seam for the fixed internal transport; production uses node:http. */
  request?: typeof http.request;
};

export const PRIVATE_DOCUMENT_EXTRACTOR_HOSTNAME = "private-document-extractor";
export const PRIVATE_DOCUMENT_EXTRACTOR_PORT = 8083;

export class PrivateDocumentClientError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
    readonly aborted = false,
    readonly category?: PrivateDocumentFailureCategory,
  ) {
    super(message);
    this.name = "PrivateDocumentClientError";
  }
}

const MAX_FILE_NAME_BYTES = 1024;
const MAX_MIME_BYTES = 256;

export class PrivateDocumentClient {
  #requestOptions: Readonly<{
    protocol: "http:";
    hostname: string;
    port: string | 80;
    path: typeof PRIVATE_DOCUMENT_PATH;
    method: "POST";
    agent: false;
  }>;
  #token: string;
  #request: typeof http.request;

  constructor(config: PrivateDocumentClientConfig) {
    const url = validateConfig(config);
    this.#requestOptions = Object.freeze({
      protocol: "http:",
      hostname: url.hostname,
      port: url.port,
      path: PRIVATE_DOCUMENT_PATH,
      method: "POST",
      agent: false,
    });
    this.#token = config.token;
    this.#request = config.request ?? http.request;
  }

  extract(bytes: Uint8Array, metadata: PrivateDocumentMetadata, signal?: AbortSignal): Promise<PrivateExtractionResult> {
    validateInput(bytes);
    const fileName = encodeMetadata(metadata.fileName, MAX_FILE_NAME_BYTES);
    const mime = encodeMetadata(metadata.mime, MAX_MIME_BYTES);
    const body = Buffer.from(bytes);
    const timeout = AbortSignal.timeout(PRIVATE_DOCUMENT_TIMEOUT_MS);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;

    return new Promise<PrivateExtractionResult>((resolve, reject) => {
      let settled = false;
      let bodyCleaned = false;
      const cleanBody = () => {
        if (bodyCleaned) return;
        bodyCleaned = true;
        body.fill(0);
      };
      let chunks: Buffer[] = [];
      let payload: Buffer | undefined;
      const cleanResponse = () => {
        payload?.fill(0);
        payload = undefined;
        for (const chunk of chunks) chunk.fill(0);
        chunks = [];
      };
      let abort: () => void = () => undefined;
      const finish = (error?: Error, result?: PrivateExtractionResult) => {
        if (settled) return;
        settled = true;
        requestSignal.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve(result!);
      };
      let request: ReturnType<typeof http.request>;
      try {
        request = this.#request({
          ...this.#requestOptions,
          headers: {
            authorization: `Bearer ${this.#token}`,
            "content-type": "application/octet-stream",
            "content-length": body.byteLength,
            [PRIVATE_DOCUMENT_FILE_NAME_HEADER]: fileName,
            [PRIVATE_DOCUMENT_MIME_HEADER]: mime,
            connection: "close",
          },
          agent: false,
        }, (response) => {
        const contentType = typeof response.headers["content-type"] === "string"
          ? response.headers["content-type"].split(";", 1)[0]?.trim().toLowerCase()
          : "";
        const contentEncoding = response.headers["content-encoding"];
        const transferEncoding = response.headers["transfer-encoding"];
        const declaredLength = parseResponseLength(response.headers["content-length"]);
        const oversized = declaredLength !== undefined && declaredLength > PRIVATE_DOCUMENT_MAX_WIRE_RESPONSE_BYTES;
        if (
          contentType !== "application/json" ||
          contentEncoding !== undefined ||
          transferEncoding !== undefined ||
          declaredLength === undefined ||
          oversized
        ) {
          response.resume();
          response.destroy();
          cleanResponse();
          finish(new PrivateDocumentClientError("Private extractor response rejected", oversized ? false : retryableStatus(response.statusCode), response.statusCode));
          return;
        }

        let total = 0;
        response.on("data", (chunk: Buffer | string) => {
          if (settled) return;
          const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += value.byteLength;
          if (total > PRIVATE_DOCUMENT_MAX_WIRE_RESPONSE_BYTES || total > declaredLength) {
            response.destroy();
            cleanResponse();
            finish(new PrivateDocumentClientError("Private extractor response rejected", false));
            return;
          }
          chunks.push(value);
        });
        response.on("error", () => {
          cleanResponse();
          finish(new PrivateDocumentClientError("Private extractor response rejected", retryableResponseError(response.statusCode), response.statusCode));
        });
        response.on("end", () => {
          if (settled) return;
          try {
            if (total !== declaredLength) throw new Error("Private extractor response rejected");
            payload = Buffer.concat(chunks, total);
            const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
            if (response.statusCode !== 200) {
              const category = response.statusCode === 422 && value !== null && typeof value === "object" && isPrivateDocumentFailureCategory((value as { category?: unknown }).category)
                ? (value as { category: PrivateDocumentFailureCategory }).category
                : undefined;
              throw new PrivateDocumentClientError("Private extractor request failed", retryableStatus(response.statusCode), response.statusCode, false, category);
            }
            finish(undefined, validatePrivateExtractionResult(value));
          } catch (error) {
            finish(error instanceof PrivateDocumentClientError ? error : new PrivateDocumentClientError("Private extractor response rejected", false));
          } finally {
            cleanResponse();
          }
        });
        });
      } catch {
        cleanBody();
        finish(new PrivateDocumentClientError("Private extractor request failed", !signal?.aborted, undefined, Boolean(signal?.aborted)));
        return;
      }

      abort = () => {
        cleanBody();
        cleanResponse();
        request.destroy();
        finish(new PrivateDocumentClientError("Private extractor request failed", !signal?.aborted, undefined, Boolean(signal?.aborted)));
      };
      requestSignal.addEventListener("abort", abort, { once: true });
      if (requestSignal.aborted) {
        abort();
        return;
      }
      request.once("finish", cleanBody);
      request.once("close", cleanBody);
      request.on("error", () => {
        cleanBody();
        finish(new PrivateDocumentClientError("Private extractor request failed", !signal?.aborted, undefined, Boolean(signal?.aborted)));
      });
      try {
        request.end(body);
      } catch {
        cleanBody();
        finish(new PrivateDocumentClientError("Private extractor request failed", !signal?.aborted, undefined, Boolean(signal?.aborted)));
      }
    });
  }
}

export function createPrivateDocumentClient(config: PrivateDocumentClientConfig): PrivateDocumentClient {
  return new PrivateDocumentClient(config);
}

function validateConfig(config: PrivateDocumentClientConfig): URL {
  const origin = `http://${PRIVATE_DOCUMENT_EXTRACTOR_HOSTNAME}:${PRIVATE_DOCUMENT_EXTRACTOR_PORT}`;
  if (typeof config.url !== "string" || (config.url !== origin && config.url !== `${origin}/`)) {
    throw new Error("Private extractor URL is invalid");
  }
  let url: URL;
  try {
    url = new URL(config.url);
  } catch {
    throw new Error("Private extractor URL is invalid");
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== PRIVATE_DOCUMENT_EXTRACTOR_HOSTNAME ||
    url.port !== String(PRIVATE_DOCUMENT_EXTRACTOR_PORT) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("Private extractor URL is invalid");
  }
  validatePrivateDocumentToken(config.token);
  return url;
}

function validateInput(bytes: Uint8Array): void {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > PRIVATE_DOCUMENT_MAX_BYTES) {
    throw new Error("Private document input is invalid");
  }
}

function encodeMetadata(value: unknown, maxBytes: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || /\p{Cc}|\p{Cf}|\p{Zl}|\p{Zp}/u.test(value)) {
    throw new Error("Private document metadata is invalid");
  }
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error("Private document metadata is invalid");
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new Error("Private document metadata is invalid");
    }
  }
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength > maxBytes) throw new Error("Private document metadata is invalid");
  return encoded.toString("base64url");
}

function parseResponseLength(value: string | string[] | undefined): number | undefined {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/u.test(value)) return undefined;
  const length = Number(value);
  return Number.isSafeInteger(length) && length >= 1 ? length : undefined;
}

function retryableStatus(status: number | undefined): boolean {
  return status === 429 || (status !== undefined && status >= 500 && status <= 599);
}

function retryableResponseError(status: number | undefined): boolean {
  return status === undefined || !(status >= 400 && status <= 499 && status !== 429);
}
