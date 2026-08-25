import { EventEmitter } from "node:events";
import * as http from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  createPrivateDocumentServer,
  runPrivateDocumentWorker,
  type PrivateDocumentWorkerLike,
} from "../packages/cardano-agent/src/privateComparison/privateDocumentServer.js";
import {
  PRIVATE_DOCUMENT_MAX_BYTES,
  PRIVATE_DOCUMENT_MAX_TEXT_BYTES,
  PRIVATE_DOCUMENT_TIMEOUT_MS,
} from "../packages/cardano-agent/src/privateComparison/privateDocumentProtocol.js";

const token = Buffer.alloc(32, 9).toString("base64url");
const body = Buffer.from("Cardano uses proof of stake.");
const metadata = { fileName: "claim.txt", mime: "text/plain" };

class FakeWorker extends EventEmitter implements PrivateDocumentWorkerLike {
  transferred?: ArrayBuffer;
  received?: { fileName: string; mime: string };

  constructor(private readonly result: unknown = { type: "text", title: "claim", text: "Cardano" }) {
    super();
  }

  postMessage(message: unknown, transferList?: readonly ArrayBuffer[]): void {
    const value = message as { bytes?: ArrayBuffer; metadata?: { fileName: string; mime: string } };
    this.transferred = transferList?.[0];
    this.received = value.metadata;
    setImmediate(() => this.emit("message", {
      ok: true,
      result: this.result,
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

function request(port: number, options: { token?: string; path?: string; method?: string; body?: Buffer; headers?: Record<string, string> } = {}) {
  const requestBody = options.body ?? body;
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port,
      path: options.path ?? "/v1/extract/private-document",
      method: options.method ?? "POST",
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
    const fill = vi.spyOn(Buffer.prototype, "fill");
    try {
      await withServer(() => (worker = new FakeWorker()), async (port) => {
        const response = await request(port);
        expect(response.status).toBe(200);
        expect(JSON.parse(response.body)).toEqual({ type: "text", title: "claim", text: "Cardano" });
        expect(worker.received).toEqual(metadata);
        expect(worker.transferred).toBeInstanceOf(ArrayBuffer);
        expect(worker.transferred?.byteLength).toBe(body.byteLength);
      });
      expect(fill.mock.calls.some(([value]) => value === 0)).toBe(true);
    } finally {
      fill.mockRestore();
    }
  });

  it("rejects the wrong endpoint, token, content type, transfer encoding, and length", async () => {
    await withServer(() => new FakeWorker(), async (port) => {
      expect((await request(port, { method: "GET" })).status).not.toBe(200);
      expect((await request(port, { path: "/v1/extract/private-document/" })).status).not.toBe(200);
      for (const invalidToken of ["", "bad", `${token.slice(0, -1)}!`, Buffer.alloc(32, 8).toString("base64url")]) {
        expect((await request(port, { token: invalidToken })).status).toBe(401);
      }
      expect((await request(port, { headers: { "content-type": "application/json" } })).status).toBe(415);
      expect((await request(port, { headers: { "transfer-encoding": "chunked" } })).status).not.toBe(200);
      expect((await request(port, { body: Buffer.alloc(0) })).status).toBe(413);
      expect((await request(port, { headers: { "content-length": "01" } })).status).toBe(413);
      expect((await request(port, { headers: { "content-length": String(PRIVATE_DOCUMENT_MAX_BYTES + 1) } })).status).toBe(413);
      expect((await request(port, { headers: { "x-private-document-file-name": Buffer.from("a".repeat(1025)).toString("base64url") } })).status).toBe(422);
      expect((await request(port, { headers: { "x-private-document-mime": "%" } })).status).toBe(422);
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

  it("accepts the exact one-byte and twenty-mebibyte body bounds", async () => {
    await withServer(() => new FakeWorker(), async (port) => {
      expect((await request(port, { body: Buffer.alloc(1, 1) })).status).toBe(200);
      expect((await request(port, { body: Buffer.alloc(PRIVATE_DOCUMENT_MAX_BYTES, 1) })).status).toBe(200);
    }, 2_000);
  });

  it("preserves a large serialized response until it is flushed", async () => {
    const largeText = "Cardano ".repeat(250_000);
    await withServer(() => new FakeWorker({ type: "text", title: "claim", text: largeText }), async (port) => {
      const response = await request(port);
      expect(response.status).toBe(200);
      expect(JSON.parse(response.body).text).toBe(largeText);
    }, 2_000);
  });

  it("cleans a serialized response when the client aborts", async () => {
    const fill = vi.spyOn(Buffer.prototype, "fill");
    const largeText = "Cardano ".repeat(250_000);
    try {
      await withServer(() => new FakeWorker({ type: "text", title: "claim", text: largeText }), async (port) => {
        await new Promise<void>((resolve) => {
          const requestToAbort = http.request({
            host: "127.0.0.1",
            port,
            path: "/v1/extract/private-document",
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/octet-stream",
              "content-length": body.byteLength,
              "x-private-document-file-name": Buffer.from(metadata.fileName).toString("base64url"),
              "x-private-document-mime": Buffer.from(metadata.mime).toString("base64url"),
            },
          }, (response) => {
            response.once("close", resolve);
            response.destroy();
          });
          requestToAbort.on("error", () => undefined);
          requestToAbort.end(body);
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(fill.mock.calls.some(([value]) => value === 0)).toBe(true);
      });
    } finally {
      fill.mockRestore();
    }
  });

  it("times out a slow upload before creating a parser worker", async () => {
    let workers = 0;
    await withServer(() => {
      workers += 1;
      return new FakeWorker();
    }, async (port) => {
      const slow = await new Promise<{ status: number }>((resolve, reject) => {
        let gotResponse = false;
        const requestToSlow = http.request({
          host: "127.0.0.1",
          port,
          path: "/v1/extract/private-document",
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/octet-stream",
            "content-length": body.byteLength,
            "x-private-document-file-name": Buffer.from(metadata.fileName).toString("base64url"),
            "x-private-document-mime": Buffer.from(metadata.mime).toString("base64url"),
          },
        }, (response) => {
          gotResponse = true;
          response.resume();
          response.on("end", () => resolve({ status: response.statusCode ?? 0 }));
        });
        requestToSlow.on("error", (error) => {
          if (!gotResponse) reject(error);
        });
        requestToSlow.write(body.subarray(0, 1));
        setTimeout(() => {
          if (!requestToSlow.destroyed) requestToSlow.end(body.subarray(1));
        }, 60);
      });
      expect(slow.status).toBe(504);
      expect(workers).toBe(0);
      expect((await request(port)).status).toBe(200);
    }, 25);
  });

  it("bounds cleanup when worker termination never settles", async () => {
    class NeverTerminatingWorker extends EventEmitter implements PrivateDocumentWorkerLike {
      postMessage(): void {
        setImmediate(() => this.emit("message", { ok: true, result: { type: "text", title: "claim", text: "Cardano" } }));
      }
      terminate(): Promise<number> {
        return new Promise<number>(() => undefined);
      }
    }
    vi.resetModules();
    const { createPrivateDocumentServer: createIsolatedServer } = await import(
      "../packages/cardano-agent/src/privateComparison/privateDocumentServer.js"
    );
    let workers = 0;
    const service = createIsolatedServer({
      token,
      workerFactory: () => workers++ === 0 ? new NeverTerminatingWorker() : new FakeWorker(),
      timeoutMs: 25,
    });
    await service.listen(0);
    const address = service.server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    try {
      expect((await request(address.port)).status).toBe(504);
      expect((await request(address.port)).status).toBe(503);
    } finally {
      await service.close();
    }
  });

  it("rejects timeout overrides outside the bounded service deadline", async () => {
    expect(() => createPrivateDocumentServer({ token, timeoutMs: PRIVATE_DOCUMENT_TIMEOUT_MS + 1 })).toThrow(/timeout/i);
    await expect(runPrivateDocumentWorker(new Uint8Array([1]), metadata, () => new FakeWorker(), PRIVATE_DOCUMENT_TIMEOUT_MS + 1)).rejects.toThrow(/timeout/i);
  });

  it("terminates the worker and releases the global slot when the caller cancels", async () => {
    class HangingWorker extends EventEmitter implements PrivateDocumentWorkerLike {
      terminated = false;
      postMessage(): void {}
      terminate(): Promise<number> {
        this.terminated = true;
        this.emit("exit", 0);
        return Promise.resolve(0);
      }
    }
    let workers = 0;
    let hangingWorker!: HangingWorker;
    await withServer(() => workers++ === 0 ? (hangingWorker = new HangingWorker()) : new FakeWorker(), async (port) => {
      await new Promise<void>((resolve) => {
        const requestToAbort = http.request({
          host: "127.0.0.1",
          port,
          path: "/v1/extract/private-document",
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/octet-stream",
            "content-length": body.byteLength,
            "x-private-document-file-name": Buffer.from(metadata.fileName).toString("base64url"),
            "x-private-document-mime": Buffer.from(metadata.mime).toString("base64url"),
          },
        });
        requestToAbort.on("error", () => resolve());
        requestToAbort.end(body);
        setTimeout(() => requestToAbort.destroy(), 10);
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(hangingWorker.terminated).toBe(true);
      expect((await request(port)).status).toBe(200);
    }, 100);
  });

  it("shares the active parser slot across server instances", async () => {
    class HangingWorker extends EventEmitter implements PrivateDocumentWorkerLike {
      postMessage(): void {}
      terminate(): Promise<number> {
        this.emit("exit", 0);
        return Promise.resolve(0);
      }
    }
    const first = createPrivateDocumentServer({ token, workerFactory: () => new HangingWorker(), timeoutMs: 25 });
    const second = createPrivateDocumentServer({ token, workerFactory: () => new FakeWorker(), timeoutMs: 25 });
    await first.listen(0);
    await second.listen(0);
    const firstAddress = first.server.address();
    const secondAddress = second.server.address();
    if (!firstAddress || typeof firstAddress === "string" || !secondAddress || typeof secondAddress === "string") throw new Error("server did not bind");
    try {
      const extraction = request(firstAddress.port);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect((await request(secondAddress.port)).status).toBe(429);
      expect((await extraction).status).toBe(504);
    } finally {
      await first.close();
      await second.close();
    }
  });

  it("rejects invalid worker output and oversized JSON responses generically", async () => {
    await withServer(() => new FakeWorker({ type: "invalid", title: "claim", text: "Cardano" }), async (port) => {
      const response = await request(port);
      expect(response.status).toBe(503);
      expect(response.body).toBe('{"error":"Private document extraction unavailable"}');
    });
    await withServer(() => new FakeWorker({ type: "text", title: "claim", text: "\0".repeat(2_700_000) }), async (port) => {
      const response = await request(port);
      expect(response.status).toBe(503);
      expect(response.body).toBe('{"error":"Private document extraction unavailable"}');
    });
    expect(PRIVATE_DOCUMENT_MAX_TEXT_BYTES).toBe(8_000_000);
  });
});
