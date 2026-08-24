import * as http from "node:http";
import { URL } from "node:url";
import {
  PDF_CLIENT_TIMEOUT_MS,
  PDF_EXTRACTOR_PATH,
  PDF_MAX_WIRE_RESPONSE_BYTES,
  PdfExtractorError,
  type PdfExtractionResult,
  validatePdfExtractionResult,
  validatePdfInput,
  decodePdfExtractorToken,
} from "./pdfExtractorProtocol.js";

export type PdfExtractorClientConfig = {
  url: string;
  token: string;
};

function validateConfig(config: PdfExtractorClientConfig): URL {
  let url: URL;
  try {
    url = new URL(config.url);
  } catch {
    throw new Error("PDF extractor URL must be a valid internal http URL");
  }
  if (url.protocol !== "http:" || url.username || url.password || url.search || url.hash || !decodePdfExtractorToken(config.token)) {
    throw new Error("PDF extractor URL/token configuration is invalid");
  }
  return url;
}

export class PdfExtractorClient {
  readonly url: URL;
  readonly token: string;

  constructor(config: PdfExtractorClientConfig) {
    this.url = validateConfig(config);
    this.token = config.token;
  }

  extract(bytes: Uint8Array, signal?: AbortSignal): Promise<PdfExtractionResult> {
    validatePdfInput(bytes);
    const body = Buffer.from(bytes);
    const requestUrl = new URL(PDF_EXTRACTOR_PATH, this.url);
    const timeout = AbortSignal.timeout(PDF_CLIENT_TIMEOUT_MS);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    return new Promise<PdfExtractionResult>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown, result?: PdfExtractionResult) => {
        if (settled) return;
        settled = true;
        requestSignal.removeEventListener("abort", abort);
        if (error !== undefined) reject(error);
        else resolve(result!);
      };
      const request = http.request({
        protocol: requestUrl.protocol,
        hostname: requestUrl.hostname,
        port: requestUrl.port || 80,
        path: requestUrl.pathname,
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/pdf",
          "content-length": body.byteLength,
          connection: "close",
        },
        agent: false,
      }, (response) => {
        const chunks: Buffer[] = [];
        let total = 0;
        const contentType = String(response.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
        const declaredLength = Number(response.headers["content-length"]);
        if (Number.isSafeInteger(declaredLength) && declaredLength > PDF_MAX_WIRE_RESPONSE_BYTES) {
          response.destroy();
          finish(new PdfExtractorError("PDF extractor response too large", 502));
          return;
        }
        response.on("data", (chunk: Buffer | string) => {
          if (settled) return;
          const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += value.byteLength;
          if (total > PDF_MAX_WIRE_RESPONSE_BYTES) {
            response.destroy();
            finish(new PdfExtractorError("PDF extractor response too large", 502));
            return;
          }
          chunks.push(value);
        });
        response.on("error", (error) => finish(new PdfExtractorError(errorMessage(error), 502)));
        response.on("end", () => {
          if (settled) return;
          const payload = Buffer.concat(chunks, total);
          if (response.statusCode !== 200) {
            finish(new PdfExtractorError(readErrorMessage(payload), response.statusCode));
            return;
          }
          if (contentType !== "application/json") {
            finish(new PdfExtractorError("PDF extractor returned an invalid content type", 502));
            return;
          }
          try {
            const value = JSON.parse(payload.toString("utf8"));
            finish(undefined, validatePdfExtractionResult(value));
          } catch (error) {
            finish(error instanceof PdfExtractorError ? error : new PdfExtractorError("Malformed extractor response", 502));
          }
        });
      });
      const abort = () => {
        request.destroy();
        finish(new PdfExtractorError("PDF extractor request aborted", 504));
      };
      requestSignal.addEventListener("abort", abort, { once: true });
      if (requestSignal.aborted) {
        abort();
        return;
      }
      request.on("error", (error) => finish(new PdfExtractorError(errorMessage(error), 502)));
      request.end(body);
    });
  }
}

export function createPdfExtractorClient(config: PdfExtractorClientConfig): PdfExtractorClient {
  return new PdfExtractorClient(config);
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "PDF extractor transport failure";
}

function readErrorMessage(bytes: Uint8Array): string {
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as { error?: unknown };
    return typeof value.error === "string" && value.error.length <= 512 ? value.error : "PDF extractor request failed";
  } catch {
    return "PDF extractor request failed";
  }
}
