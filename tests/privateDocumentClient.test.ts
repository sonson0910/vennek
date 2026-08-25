import * as http from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  PrivateDocumentClient,
  createPrivateDocumentClient,
} from "../packages/cardano-agent/src/privateComparison/privateDocumentClient.js";
import { PRIVATE_DOCUMENT_MAX_WIRE_RESPONSE_BYTES } from "../packages/cardano-agent/src/privateComparison/privateDocumentServer.js";
import {
  PRIVATE_DOCUMENT_MAX_BYTES,
  PRIVATE_DOCUMENT_TIMEOUT_MS,
} from "../packages/cardano-agent/src/privateComparison/privateDocumentProtocol.js";

const token = Buffer.alloc(32, 8).toString("base64url");
const metadata = { fileName: "claim 😀.txt", mime: "text/plain" };

async function withServer(handler: http.RequestListener, callback: (url: string) => Promise<void>): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  try {
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

describe("private document client", () => {
  it("posts bounded binary data with encoded metadata and validates JSON", async () => {
    const fill = vi.spyOn(Buffer.prototype, "fill");
    try {
      await withServer((request, response) => {
        expect(request.method).toBe("POST");
        expect(request.url).toBe("/v1/extract/private-document");
        expect(request.headers.authorization).toBe(`Bearer ${token}`);
        expect(request.headers["content-type"]).toBe("application/octet-stream");
        expect(request.headers["transfer-encoding"]).toBeUndefined();
        expect(request.headers["x-private-document-file-name"]).toBe(Buffer.from(metadata.fileName).toString("base64url"));
        expect(request.headers["x-private-document-mime"]).toBe(Buffer.from(metadata.mime).toString("base64url"));
        request.resume();
        request.on("end", () => {
          const payload = Buffer.from(JSON.stringify({ type: "text", title: "claim", text: "Cardano" }));
          response.writeHead(200, { "content-type": "application/json", "content-length": payload.byteLength });
          response.end(payload);
        });
      }, async (url) => {
        const client = createPrivateDocumentClient({ url, token });
        expect(client).toBeInstanceOf(PrivateDocumentClient);
        await expect(client.extract(new Uint8Array([67, 97, 114, 100, 97, 110, 111]), metadata)).resolves.toEqual({
          type: "text",
          title: "claim",
          text: "Cardano",
        });
      });
      expect(fill.mock.calls.some(([value]) => value === 0)).toBe(true);
    } finally {
      fill.mockRestore();
    }
  });

  it("requires an exact internal HTTP origin and never follows redirects", () => {
    expect(() => createPrivateDocumentClient({ url: "https://example.com", token })).toThrow();
    expect(() => createPrivateDocumentClient({ url: "http://user@example.com", token })).toThrow();
    expect(() => createPrivateDocumentClient({ url: "http://example.com/private", token })).toThrow();
    expect(() => createPrivateDocumentClient({ url: "http://example.com/?secret=1", token })).toThrow();
    expect(() => createPrivateDocumentClient({ url: "http://example.com/#secret", token })).toThrow();
  });

  it("fails closed on malformed, encoded, oversized, or cancelled responses", async () => {
    await withServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain", "content-length": 1 });
      response.end("x");
    }, async (url) => {
      await expect(createPrivateDocumentClient({ url, token }).extract(new Uint8Array([1]), metadata)).rejects.toThrow(/private extractor/i);
    });
    await withServer((_request, response) => {
      response.writeHead(302, { location: "http://example.com/secret" });
      response.end();
    }, async (url) => {
      await expect(createPrivateDocumentClient({ url, token }).extract(new Uint8Array([1]), metadata)).rejects.toThrow(/private extractor/i);
    });
    await withServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip", "content-length": 1 });
      response.end("x");
    }, async (url) => {
      await expect(createPrivateDocumentClient({ url, token }).extract(new Uint8Array([1]), metadata)).rejects.toThrow(/private extractor/i);
    });
    await withServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json", "content-length": PRIVATE_DOCUMENT_MAX_WIRE_RESPONSE_BYTES + 1 });
      response.end();
    }, async (url) => {
      await expect(createPrivateDocumentClient({ url, token }).extract(new Uint8Array([1]), metadata)).rejects.toThrow(/private extractor/i);
    });
    await withServer((_request, response) => {
      const payload = Buffer.from("{bad");
      response.writeHead(200, { "content-type": "application/json", "content-length": payload.byteLength });
      response.end(payload);
    }, async (url) => {
      await expect(createPrivateDocumentClient({ url, token }).extract(new Uint8Array([1]), metadata)).rejects.toThrow(/private extractor/i);
    });
    await withServer((_request, response) => {
      const payload = Buffer.from(JSON.stringify({ type: "invalid", title: "claim", text: "Cardano" }));
      response.writeHead(200, { "content-type": "application/json", "content-length": payload.byteLength });
      response.end(payload);
    }, async (url) => {
      await expect(createPrivateDocumentClient({ url, token }).extract(new Uint8Array([1]), metadata)).rejects.toThrow(/private extractor/i);
    });
    await withServer((_request, response) => {
      const prefix = Buffer.from('{"type":"text","title":"claim","text":"');
      const suffix = Buffer.from('"}');
      const payload = Buffer.concat([prefix, Buffer.from([0xff]), suffix]);
      response.writeHead(200, { "content-type": "application/json", "content-length": payload.byteLength });
      response.end(payload);
    }, async (url) => {
      await expect(createPrivateDocumentClient({ url, token }).extract(new Uint8Array([1]), metadata)).rejects.toThrow(/private extractor/i);
    });
    await withServer((_request, response) => {
      const payload = Buffer.from(JSON.stringify({ type: "text", title: "claim", text: "Cardano" }));
      response.writeHead(200, { "content-type": "application/json", "content-length": payload.byteLength + 1 });
      response.end(payload);
    }, async (url) => {
      await expect(createPrivateDocumentClient({ url, token }).extract(new Uint8Array([1]), metadata)).rejects.toThrow(/private extractor/i);
    });
    await withServer((_request, response) => {
      const payload = Buffer.from(JSON.stringify({ type: "text", title: "claim", text: "Cardano" }));
      response.writeHead(200, { "content-type": "application/json", "content-length": "01" });
      response.end(payload);
    }, async (url) => {
      await expect(createPrivateDocumentClient({ url, token }).extract(new Uint8Array([1]), metadata)).rejects.toThrow(/private extractor/i);
    });
    await withServer((_request, response) => {
      setTimeout(() => response.end(JSON.stringify({ type: "text", title: "claim", text: "Cardano" })), 100);
    }, async (url) => {
      const controller = new AbortController();
      const extraction = createPrivateDocumentClient({ url, token }).extract(new Uint8Array([1]), metadata, controller.signal);
      controller.abort();
      await expect(extraction).rejects.toThrow(/private extractor/i);
    });
  });

  it("times out a response at the fixed request deadline", async () => {
    const timeoutController = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);
    try {
      await withServer((_request, _response) => undefined, async (url) => {
        const extraction = createPrivateDocumentClient({ url, token }).extract(new Uint8Array([1]), metadata);
        expect(timeout).toHaveBeenCalledWith(PRIVATE_DOCUMENT_TIMEOUT_MS);
        timeoutController.abort();
        await expect(extraction).rejects.toThrow(/private extractor/i);
      });
    } finally {
      timeout.mockRestore();
    }
  });

  it("rejects unsafe metadata and out-of-bounds input before making a request", () => {
    const client = createPrivateDocumentClient({ url: "http://127.0.0.1", token });
    expect(() => client.extract(new Uint8Array(0), metadata)).toThrow();
    expect(() => client.extract(Buffer.alloc(PRIVATE_DOCUMENT_MAX_BYTES + 1), metadata)).toThrow();
    expect(() => client.extract(new Uint8Array([1]), { fileName: "claim\n.txt", mime: "text/plain" })).toThrow();
    expect(() => client.extract(new Uint8Array([1]), { fileName: "a".repeat(1025), mime: "text/plain" })).toThrow();
    expect(() => client.extract(new Uint8Array([1]), { fileName: "claim.txt", mime: "text/\ud800" })).toThrow();
  });

  it("does not expose a token from a remote error body", async () => {
    await withServer((_request, response) => {
      const payload = Buffer.from(JSON.stringify({ error: `secret ${token}` }));
      response.writeHead(500, { "content-type": "application/json", "content-length": payload.byteLength });
      response.end(payload);
    }, async (url) => {
      const extraction = createPrivateDocumentClient({ url, token }).extract(new Uint8Array([1]), metadata);
      await expect(extraction).rejects.toThrow(/private extractor/i);
      await expect(extraction).rejects.not.toThrow(token);
    });
  });

  it("does not expose mutable URL/token fields or serialize the token", async () => {
    await withServer((_request, response) => {
      const payload = Buffer.from(JSON.stringify({ type: "text", title: "claim", text: "Cardano" }));
      response.writeHead(200, { "content-type": "application/json", "content-length": payload.byteLength });
      response.end(payload);
    }, async (url) => {
      const client = createPrivateDocumentClient({ url, token });
      expect(JSON.stringify(client)).not.toContain(token);
      expect(Object.keys(client)).not.toContain("token");
      (client as unknown as { url?: string }).url = "http://127.0.0.1:1";
      (client as unknown as { token?: string }).token = "mutated";
      expect(JSON.stringify(client)).not.toContain(token);
      await expect(client.extract(new Uint8Array([1]), metadata)).resolves.toEqual({ type: "text", title: "claim", text: "Cardano" });
    });
  });
});
