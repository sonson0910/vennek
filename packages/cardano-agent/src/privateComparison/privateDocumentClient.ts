import * as http from "node:http";
import {
  PRIVATE_DOCUMENT_MAX_BYTES,
  PRIVATE_DOCUMENT_PATH,
  PRIVATE_DOCUMENT_TIMEOUT_MS,
  validatePrivateDocumentToken,
  validatePrivateExtractionResult,
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
};

const MAX_FILE_NAME_BYTES = 1024;
const MAX_MIME_BYTES = 256;

export class PrivateDocumentClient {
  readonly url: URL;
  readonly token: string;

  constructor(config: PrivateDocumentClientConfig) {
    this.url = validateConfig(config);
    this.token = config.token;
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
      const finish = (error?: Error, result?: PrivateExtractionResult) => {
        if (settled) return;
        settled = true;
        requestSignal.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve(result!);
      };
      const request = http.request({
        protocol: this.url.protocol,
        hostname: this.url.hostname,
        port: this.url.port || 80,
        path: PRIVATE_DOCUMENT_PATH,
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
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
        if (
          contentType !== "application/json" ||
          contentEncoding !== undefined ||
          transferEncoding !== undefined ||
          declaredLength === undefined ||
          declaredLength > PRIVATE_DOCUMENT_MAX_WIRE_RESPONSE_BYTES
        ) {
          response.resume();
          response.destroy();
          finish(new Error("Private extractor response rejected"));
          return;
        }

        const chunks: Buffer[] = [];
        let total = 0;
        response.on("data", (chunk: Buffer | string) => {
          if (settled) return;
          const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += value.byteLength;
          if (total > PRIVATE_DOCUMENT_MAX_WIRE_RESPONSE_BYTES || total > declaredLength) {
            response.destroy();
            finish(new Error("Private extractor response rejected"));
            return;
          }
          chunks.push(value);
        });
        response.on("error", () => finish(new Error("Private extractor response rejected")));
        response.on("end", () => {
          if (settled) return;
          if (total !== declaredLength) {
            finish(new Error("Private extractor response rejected"));
            return;
          }
          if (response.statusCode !== 200) {
            finish(new Error("Private extractor request failed"));
            return;
          }
          try {
            const value = JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
            finish(undefined, validatePrivateExtractionResult(value));
          } catch {
            finish(new Error("Private extractor response rejected"));
          }
        });
      });

      const abort = () => {
        request.destroy();
        finish(new Error("Private extractor request failed"));
      };
      requestSignal.addEventListener("abort", abort, { once: true });
      if (requestSignal.aborted) {
        abort();
        return;
      }
      request.on("error", () => finish(new Error("Private extractor request failed")));
      request.end(body);
    });
  }
}

export function createPrivateDocumentClient(config: PrivateDocumentClientConfig): PrivateDocumentClient {
  return new PrivateDocumentClient(config);
}

function validateConfig(config: PrivateDocumentClientConfig): URL {
  let url: URL;
  try {
    url = new URL(config.url);
  } catch {
    throw new Error("Private extractor URL is invalid");
  }
  if (
    url.protocol !== "http:" ||
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
