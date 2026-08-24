import * as http from "node:http";
import { describe, expect, it } from "vitest";
import { PdfExtractorClient } from "../packages/cardano-agent/src/knowledge/pdfExtractorClient.js";
import { PDF_MAX_WIRE_RESPONSE_BYTES } from "../packages/cardano-agent/src/knowledge/pdfExtractorProtocol.js";

const token = Buffer.alloc(32, 4).toString("base64url");

async function withServer(handler: http.RequestListener, fn: (url: string) => Promise<void>): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

describe("PdfExtractorClient", () => {
  it("is available as the explicit remote extractor boundary", () => {
    expect(PdfExtractorClient).toBeTypeOf("function");
  });

  it("posts binary input and validates bounded JSON output", async () => {
    await withServer((request, response) => {
      expect(request.method).toBe("POST");
      expect(request.headers.authorization).toBe(`Bearer ${token}`);
      expect(request.headers["content-type"]).toBe("application/pdf");
      expect(request.headers["transfer-encoding"]).toBeUndefined();
      request.resume();
      request.on("end", () => {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ title: "title", text: "text" }));
      });
    }, async (url) => {
      await expect(new PdfExtractorClient({ url, token }).extract(new Uint8Array([37, 80, 68, 70]))).resolves.toEqual({ title: "title", text: "text" });
    });
  });

  it("rejects invalid internal configuration, malformed output, and caller abort", async () => {
    expect(() => new PdfExtractorClient({ url: "https://example.com", token })).toThrow();
    expect(() => new PdfExtractorClient({ url: "http://example.com", token: "bad" })).toThrow();
    await withServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ title: "x" }));
    }, async (url) => {
      await expect(new PdfExtractorClient({ url, token }).extract(new Uint8Array([1]))).rejects.toThrow(/Malformed/);
    });
    await withServer((_request, response) => {
      setTimeout(() => response.end(JSON.stringify({ title: "x", text: "text" })), 50);
    }, async (url) => {
      const controller = new AbortController();
      const extraction = new PdfExtractorClient({ url, token }).extract(new Uint8Array([1]), controller.signal);
      controller.abort();
      await expect(extraction).rejects.toThrow(/aborted/i);
    });
  });

  it("fails closed on a response over the wire cap", async () => {
    await withServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json", "content-length": PDF_MAX_WIRE_RESPONSE_BYTES + 1 });
      response.end();
    }, async (url) => {
      await expect(new PdfExtractorClient({ url, token }).extract(new Uint8Array([1]))).rejects.toThrow(/too large/i);
    });
  });
});
