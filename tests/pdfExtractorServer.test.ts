import { EventEmitter } from "node:events";
import * as http from "node:http";
import * as net from "node:net";
import { describe, expect, it } from "vitest";
import {
  createPdfExtractorServer,
  type WorkerLike,
} from "../packages/cardano-agent/src/knowledge/pdfExtractorServer.js";

const token = Buffer.alloc(32, 7).toString("base64url");
const pdf = Buffer.from("%PDF-1.4\nbody");

class FakeWorker extends EventEmitter implements WorkerLike {
  constructor(private readonly result: unknown, private readonly delayMs = 0, private readonly hangTermination = false, private readonly rejectTermination = false, private readonly throwTermination = false) {
    super();
  }

  postMessage(): void {
    if (this.result === "hang") return;
    setTimeout(() => this.emit("message", { ok: true, result: this.result }), this.delayMs);
  }

  terminate(): Promise<number> {
    if (this.hangTermination) return new Promise<number>(() => undefined);
    if (this.rejectTermination) return Promise.reject(new Error("termination failed"));
    if (this.throwTermination) throw new Error("termination threw");
    this.emit("exit", 0);
    return Promise.resolve(0);
  }
}

async function withServer(workerFactory: () => WorkerLike, fn: (port: number) => Promise<void>, timeoutMs = 100): Promise<void> {
  const service = createPdfExtractorServer({ token, workerFactory, timeoutMs });
  await service.listen(0);
  const address = service.server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  try {
    await fn(address.port);
  } finally {
    await service.close();
  }
}

function request(port: number, options: { token?: string; body?: Buffer; contentType?: string; headers?: Record<string, string>; omitLength?: boolean } = {}): Promise<{ status: number; body: string }> {
  const body = options.body ?? pdf;
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | number> = {
      authorization: options.token === undefined ? `Bearer ${token}` : `Bearer ${options.token}`,
      "content-type": options.contentType ?? "application/pdf",
      "content-length": body.byteLength,
      ...options.headers,
    };
    if (options.omitLength) delete headers["content-length"];
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: "/v1/extract/pdf",
      method: "POST",
      headers,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

function rawRequest(port: number, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.end(body));
    let output = "";
    socket.on("data", (chunk) => output += chunk.toString("utf8"));
    socket.on("end", () => resolve(output));
    socket.on("error", reject);
  });
}

describe("PDF extractor server", () => {
  it("rejects missing and duplicate-style authorization before extraction", async () => {
    await withServer(() => new FakeWorker({ title: "ok", text: "text" }), async (port) => {
      const missing = await request(port, { token: "" });
      expect(missing.status).toBe(401);
      const duplicate = await request(port, { headers: { authorization: `Bearer ${token}, Bearer ${token}` } });
      expect(duplicate.status).toBe(401);
    });
  });

  it("validates headers, length, and parser output", async () => {
    await withServer(() => new FakeWorker({ title: "ok", text: "text" }), async (port) => {
      expect((await request(port, { contentType: "application/pdf; charset=binary" })).status).toBe(415);
      expect((await request(port, { omitLength: true, headers: { "transfer-encoding": "chunked" } })).status).toBe(415);
      expect((await request(port, { body: Buffer.alloc(0) })).status).toBe(413);
      const missingLength = await rawRequest(port, `POST /v1/extract/pdf HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/pdf\r\nConnection: close\r\n\r\nbody`);
      expect(missingLength).toContain(" 422 ");
    });
    await withServer(() => new FakeWorker({ title: "x" }), async (port) => {
      expect((await request(port)).status).toBe(422);
    });
  });

  it("returns 503 for a concurrent authenticated request and 504 on timeout", async () => {
    await withServer(() => new FakeWorker("hang"), async (port) => {
      const first = request(port);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect((await request(port)).status).toBe(503);
      expect((await first).status).toBe(504);
    }, 30);
  });

  it("releases the active slot when the caller aborts", async () => {
    await withServer(() => new FakeWorker("hang"), async (port) => {
      const aborted = new Promise<void>((resolve) => {
        const req = http.request({
          host: "127.0.0.1",
          port,
          path: "/v1/extract/pdf",
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/pdf", "content-length": pdf.byteLength }
        });
        req.on("error", () => resolve());
        req.end(pdf);
        setTimeout(() => req.destroy(), 10);
      });
      await aborted;
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect((await request(port)).status).toBe(504);
    }, 100);
  });

  it("times out a slow authenticated upload and releases the slot", async () => {
    await withServer(() => new FakeWorker({ title: "ok", text: "text" }), async (port) => {
      const slow = await new Promise<{ status: number }>((resolve, reject) => {
        let gotResponse = false;
        const req = http.request({
          host: "127.0.0.1",
          port,
          path: "/v1/extract/pdf",
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/pdf", "content-length": pdf.byteLength }
        }, (res) => {
          gotResponse = true;
          res.resume();
          res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
        });
        req.on("error", (error) => {
          if (!gotResponse) reject(error);
        });
        req.write(pdf.subarray(0, 1));
        setTimeout(() => {
          if (!req.destroyed) req.end(pdf.subarray(1));
        }, 60);
      });
      expect(slow.status).toBe(504);
      expect((await request(port)).status).toBe(200);
    }, 30);
  }, 1_000);

  it("bounds worker termination and releases the slot after a valid result", async () => {
    let workers = 0;
    await withServer(() => new FakeWorker({ title: "ok", text: "text" }, 0, workers++ === 0), async (port) => {
      expect((await request(port)).status).toBe(504);
      expect((await request(port)).status).toBe(200);
    }, 30);
  }, 1_000);

  it("does not confirm a valid result when worker termination rejects", async () => {
    let workers = 0;
    await withServer(() => new FakeWorker({ title: "ok", text: "text" }, 0, false, workers++ === 0), async (port) => {
      expect((await request(port)).status).toBe(504);
      expect((await request(port)).status).toBe(200);
    }, 30);
  }, 1_000);

  it("does not confirm a valid result when worker termination throws", async () => {
    let workers = 0;
    await withServer(() => new FakeWorker({ title: "ok", text: "text" }, 0, false, false, workers++ === 0), async (port) => {
      expect((await request(port)).status).toBe(504);
      expect((await request(port)).status).toBe(200);
    }, 30);
  }, 1_000);
});
