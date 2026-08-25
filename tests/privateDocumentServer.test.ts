import { EventEmitter } from "node:events";
import * as http from "node:http";
import { describe, expect, it } from "vitest";
import {
  createPrivateDocumentServer,
  type PrivateDocumentWorkerLike,
} from "../packages/cardano-agent/src/privateComparison/privateDocumentServer.js";

const token = Buffer.alloc(32, 9).toString("base64url");
const body = Buffer.from("Cardano uses proof of stake.");
const metadata = { fileName: "claim.txt", mime: "text/plain" };

class FakeWorker extends EventEmitter implements PrivateDocumentWorkerLike {
  transferred?: ArrayBuffer;
  received?: { fileName: string; mime: string };

  postMessage(message: unknown, transferList?: readonly ArrayBuffer[]): void {
    const value = message as { bytes?: ArrayBuffer; metadata?: { fileName: string; mime: string } };
    this.transferred = transferList?.[0];
    this.received = value.metadata;
    setImmediate(() => this.emit("message", {
      ok: true,
      result: { type: "text", title: "claim", text: "Cardano" },
    }));
  }

  terminate(): Promise<number> {
    this.emit("exit", 0);
    return Promise.resolve(0);
  }
}

async function withServer(
  workerFactory: () => PrivateDocumentWorkerLike,
  callback: (port: number) => Promise<void>,
  timeoutMs = 100,
): Promise<void> {
  const service = createPrivateDocumentServer({ token, workerFactory, timeoutMs });
  await service.listen(0);
  const address = service.server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  try {
    await callback(address.port);
  } finally {
    await service.close();
  }
}

function request(port: number, options: { token?: string; path?: string; body?: Buffer; headers?: Record<string, string> } = {}) {
  const requestBody = options.body ?? body;
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port,
      path: options.path ?? "/v1/extract/private-document",
      method: "POST",
      headers: {
        authorization: `Bearer ${options.token ?? token}`,
        "content-type": "application/octet-stream",
        "content-length": requestBody.byteLength,
        "x-private-document-file-name": Buffer.from(metadata.fileName).toString("base64url"),
        "x-private-document-mime": Buffer.from(metadata.mime).toString("base64url"),
        ...options.headers,
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    request.end(requestBody);
  });
}

describe("private document server", () => {
  it("authenticates, decodes bounded metadata, transfers bytes, and validates output", async () => {
    let worker!: FakeWorker;
    await withServer(() => (worker = new FakeWorker()), async (port) => {
      const response = await request(port);
      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ type: "text", title: "claim", text: "Cardano" });
      expect(worker.received).toEqual(metadata);
      expect(worker.transferred).toBeInstanceOf(ArrayBuffer);
      expect(worker.transferred?.byteLength).toBe(body.byteLength);
    });
  });

  it("rejects the wrong endpoint, token, content type, transfer encoding, and length", async () => {
    await withServer(() => new FakeWorker(), async (port) => {
      expect((await request(port, { path: "/v1/extract/private-document/" })).status).not.toBe(200);
      expect((await request(port, { token: "bad" })).status).toBe(401);
      expect((await request(port, { headers: { "content-type": "application/json" } })).status).toBe(415);
      expect((await request(port, { headers: { "transfer-encoding": "chunked" } })).status).not.toBe(200);
      expect((await request(port, { body: Buffer.alloc(0) })).status).toBe(413);
      const oversized = await request(port, { headers: { "content-length": String(body.byteLength + 1) } });
      expect(oversized.status).not.toBe(200);
      expect(oversized.body).not.toContain(token);
    });
  });

  it("limits extraction to one active worker and releases it after timeout", async () => {
    class HangingWorker extends EventEmitter implements PrivateDocumentWorkerLike {
      postMessage(): void {}
      terminate(): Promise<number> {
        this.emit("exit", 0);
        return Promise.resolve(0);
      }
    }
    await withServer(() => new HangingWorker(), async (port) => {
      const first = request(port);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect((await request(port)).status).toBe(429);
      expect((await first).status).toBe(504);
    }, 25);
  });
});
