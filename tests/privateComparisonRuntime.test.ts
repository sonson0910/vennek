import { EventEmitter } from "node:events";
import type { ClientRequest } from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  createTelegramApi,
  TELEGRAM_FILE_PATH_MAX_BYTES,
  TELEGRAM_PRIVATE_FILE_MAX_BYTES,
  type TelegramFileRequest,
  type TelegramFileResponse,
} from "../apps/telegram-bot/src/pollingRuntime.js";
import { withPrivateTelegramDocument } from "../apps/telegram-bot/src/privateComparisonRuntime.js";

describe("Telegram private document download", () => {
  it("gets an exact bounded file object and binds the returned id", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        result: { file_id: "file-1", file_unique_id: "unique-1", file_size: 3, file_path: "documents/file-1.txt" },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const file = await createTelegramApi("TOKEN_SECRET").getFile!({ file_id: "file-1" });

    expect(file).toEqual({ file_id: "file-1", file_unique_id: "unique-1", file_size: 3, file_path: "documents/file-1.txt" });
    expect(JSON.stringify(file)).not.toContain("TOKEN_SECRET");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telegram.org/botTOKEN_SECRET/getFile",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ file_id: "file-1" }) }),
    );
    vi.unstubAllGlobals();
  });

  it.each([
    "../file.txt",
    "documents/../file.txt",
    "documents/%2e%2e/file.txt",
    "documents/%2fetc/passwd",
    "documents/%5cetc/passwd",
    "https://evil.example/file",
    "documents/file.txt?x=1",
    "documents/file.txt#x",
    "documents\\file.txt",
    "documents/",
  ])("rejects unsafe returned paths: %s", async (filePath) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { file_id: "file-1", file_unique_id: "unique-1", file_path: filePath } }),
    }));

    await expect(createTelegramApi("TOKEN_SECRET").getFile!({ file_id: "file-1" })).rejects.toThrow();
    vi.unstubAllGlobals();
  });

  it("rejects malformed and TOCTOU file metadata", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true, result: { file_id: "other", file_unique_id: "unique-1" } }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true, result: { file_id: "file-1", file_unique_id: "unique-1", file_size: 0 } }) });
    vi.stubGlobal("fetch", fetchMock);

    await expect(createTelegramApi("TOKEN_SECRET").getFile!({ file_id: "file-1" })).rejects.toThrow();
    await expect(createTelegramApi("TOKEN_SECRET").getFile!({ file_id: "file-1" })).rejects.toThrow();
    vi.unstubAllGlobals();
  });

  it("accepts exact file id, path, and 20 MiB advisory boundaries", async () => {
    const fileId = "f".repeat(512);
    const filePath = "a".repeat(TELEGRAM_FILE_PATH_MAX_BYTES);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { file_id: fileId, file_unique_id: "unique-1", file_size: TELEGRAM_PRIVATE_FILE_MAX_BYTES, file_path: filePath } }),
    }));

    await expect(createTelegramApi("TOKEN_SECRET").getFile!({ file_id: fileId })).resolves.toMatchObject({ file_id: fileId, file_size: TELEGRAM_PRIVATE_FILE_MAX_BYTES, file_path: filePath });
    vi.unstubAllGlobals();
  });

  it.each([
    { length: 512, valid: true },
    { length: 513, valid: false },
  ])("enforces the file ID byte boundary at $length", async ({ length, valid }) => {
    const fileId = "f".repeat(length);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { file_id: fileId, file_unique_id: "unique-1" } }),
    }));

    const result = createTelegramApi("TOKEN_SECRET").getFile!({ file_id: fileId });
    if (valid) await expect(result).resolves.toMatchObject({ file_id: fileId });
    else await expect(result).rejects.toThrow();
    vi.unstubAllGlobals();
  });

  it.each([
    { length: TELEGRAM_FILE_PATH_MAX_BYTES, valid: true },
    { length: TELEGRAM_FILE_PATH_MAX_BYTES + 1, valid: false },
  ])("enforces the file path byte boundary at $length", async ({ length, valid }) => {
    const filePath = "a".repeat(length);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { file_id: "file-1", file_unique_id: "unique-1", file_path: filePath } }),
    }));

    const result = createTelegramApi("TOKEN_SECRET").getFile!({ file_id: "file-1" });
    if (valid) await expect(result).resolves.toMatchObject({ file_path: filePath });
    else await expect(result).rejects.toThrow();
    vi.unstubAllGlobals();
  });

  it("downloads only from the fixed origin and cleans the consumer buffer", async () => {
    let options: TelegramFileRequest | undefined;
    let received: Buffer | undefined;
    const api = createTelegramApi("123456:ABC_SECRET", undefined, {
      request(requestOptions, callback) {
        options = requestOptions;
        const request = new EventEmitter() as unknown as ClientRequest;
        request.setTimeout = () => request;
        request.destroy = () => request;
        request.end = () => {
          const response = new EventEmitter() as unknown as TelegramFileResponse & EventEmitter;
          response.statusCode = 200;
          response.headers = { "content-type": "text/plain", "content-length": "3" };
          queueMicrotask(() => {
            const chunk = Buffer.from("abc");
            response.emit("data", chunk);
            response.emit("end");
          });
          callback(response);
          return request;
        };
        return request;
      },
    });

    await api.withDownloadedFile!("documents/file.txt", 3, undefined, (buffer) => {
      received = buffer;
      expect(buffer.toString()).toBe("abc");
    });

    expect(options).toMatchObject({
      protocol: "https:",
      hostname: "api.telegram.org",
      path: "/file/bot123456:ABC_SECRET/documents/file.txt",
      method: "GET",
      agent: false,
      headers: { "accept-encoding": "identity" },
    });
    expect(received?.every((value) => value === 0)).toBe(true);
  });

  it("rejects redirects, compression, and size mismatches without exposing secrets", async () => {
    const makeApi = (headers: Record<string, string>, statusCode = 200, body = "abc") => createTelegramApi("TOKEN_SECRET", undefined, {
      request(_requestOptions, callback) {
        const request = new EventEmitter() as unknown as ClientRequest;
        request.setTimeout = () => request;
        request.destroy = () => request;
        request.end = () => {
          const response = new EventEmitter() as unknown as TelegramFileResponse & EventEmitter;
          response.statusCode = statusCode;
          response.headers = headers;
          queueMicrotask(() => {
            response.emit("data", Buffer.from(body));
            response.emit("end");
          });
          callback(response);
          return request;
        };
        return request;
      },
    });

    for (const api of [
      makeApi({ "content-type": "text/plain", location: "https://TOKEN_SECRET/secret", "content-length": "3" }, 302),
      makeApi({ "content-type": "text/plain", "content-encoding": "gzip", "content-length": "3" }),
      makeApi({ "content-type": "text/plain", "content-length": "4" }),
    ]) {
      await expect(api.withDownloadedFile!("documents/file.txt", 3, undefined, () => undefined)).rejects.toThrow();
    }
  });

  it("rejects a consumer failure after zeroing the buffer", async () => {
    let received: Buffer | undefined;
    const api = createTelegramApi("TOKEN_SECRET", undefined, {
      request(_requestOptions, callback) {
        const request = new EventEmitter() as unknown as ClientRequest;
        request.setTimeout = () => request;
        request.destroy = () => request;
        request.end = () => {
          const response = new EventEmitter() as unknown as TelegramFileResponse & EventEmitter;
          response.statusCode = 200;
          response.headers = { "content-type": "application/octet-stream", "content-length": "3" };
          queueMicrotask(() => {
            response.emit("data", Buffer.from("abc"));
            response.emit("end");
          });
          callback(response);
          return request;
        };
        return request;
      },
    });

    await expect(api.withDownloadedFile!("documents/file.txt", 3, undefined, (buffer) => {
      received = buffer;
      throw new Error("TOKEN_SECRET documents/file.txt private metadata");
    })).rejects.not.toThrow(/TOKEN_SECRET|documents\/file\.txt|private metadata/);
    expect(received?.every((value) => value === 0)).toBe(true);
  });

  it("zeroes response chunks when streaming over the hard limit", async () => {
    let oversizedChunk: Buffer | undefined;
    const api = createTelegramApi("TOKEN_SECRET", undefined, {
      request(_requestOptions, callback) {
        const request = new EventEmitter() as unknown as ClientRequest;
        request.setTimeout = () => request;
        request.destroy = () => request;
        request.end = () => {
          const response = new EventEmitter() as unknown as TelegramFileResponse & EventEmitter;
          response.statusCode = 200;
          response.headers = { "content-type": "application/octet-stream" };
          queueMicrotask(() => {
            oversizedChunk = Buffer.alloc(4);
            response.emit("data", oversizedChunk);
            response.emit("end");
          });
          callback(response);
          return request;
        };
        return request;
      },
    });

    await expect(api.withDownloadedFile!("documents/file.txt", 3, undefined, () => undefined)).rejects.toThrow();
    expect(oversizedChunk?.every((value) => value === 0)).toBe(true);
  });

  it.each([
    { size: TELEGRAM_PRIVATE_FILE_MAX_BYTES, valid: true },
    { size: TELEGRAM_PRIVATE_FILE_MAX_BYTES + 1, valid: false },
  ])("enforces the streamed body boundary at $size bytes", async ({ size, valid }) => {
    let destroyed = false;
    let consumed = 0;
    const api = createTelegramApi("TOKEN_SECRET", undefined, {
      request(_requestOptions, callback) {
        const request = new EventEmitter() as unknown as ClientRequest;
        request.setTimeout = () => request;
        request.destroy = () => {
          destroyed = true;
          return request;
        };
        request.end = () => {
          const response = new EventEmitter() as unknown as TelegramFileResponse & EventEmitter;
          response.statusCode = 200;
          response.headers = { "content-type": "application/octet-stream" };
          callback(response);
          queueMicrotask(() => {
            const chunk = Buffer.alloc(1024 * 1024);
            for (let offset = 0; offset < size - 1_048_576; offset += chunk.byteLength) {
              chunk.fill(0x61);
              response.emit("data", chunk);
            }
            const remainder = size % chunk.byteLength || chunk.byteLength;
            chunk.fill(0x61);
            response.emit("data", chunk.subarray(0, remainder));
            response.emit("end");
          });
          return request;
        };
        return request;
      },
    });

    const result = api.withDownloadedFile!("documents/file.txt", valid ? size : undefined, undefined, (bytes) => {
      consumed = bytes.byteLength;
    });
    if (valid) await expect(result).resolves.toBeUndefined();
    else await expect(result).rejects.toThrow();
    expect(consumed).toBe(valid ? size : 0);
    if (!valid) expect(destroyed).toBe(true);
  });

  it("aborts and destroys a request at the absolute 15 second deadline", async () => {
    vi.useFakeTimers();
    let destroyed = false;
    let requestStarted = false;
    try {
      const api = createTelegramApi("TOKEN_SECRET", undefined, {
        request(_requestOptions, _callback) {
          requestStarted = true;
          const request = new EventEmitter() as unknown as ClientRequest;
          request.setTimeout = () => request;
          request.destroy = () => {
            destroyed = true;
            return request;
          };
          request.end = () => request;
          vi.advanceTimersByTime(15_001);
          return request;
        },
      });
      const pending = api.withDownloadedFile!("documents/file.txt", undefined, undefined, () => undefined);
      await expect(pending).rejects.toThrow();
      expect(requestStarted).toBe(true);
      expect(destroyed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts and destroys an in-flight request when the caller signal aborts", async () => {
    let destroyed = false;
    const controller = new AbortController();
    const api = createTelegramApi("TOKEN_SECRET", undefined, {
      request(_requestOptions, _callback) {
        const request = new EventEmitter() as unknown as ClientRequest;
        request.setTimeout = () => request;
        request.destroy = () => {
          destroyed = true;
          return request;
        };
        request.end = () => request;
        return request;
      },
    });

    const pending = api.withDownloadedFile!("documents/file.txt", undefined, controller.signal, () => undefined);
    const rejected = expect(pending).rejects.toThrow();
    controller.abort();
    await rejected;
    expect(destroyed).toBe(true);
  });

  it("does not let caller abort interrupt a consumer after network completion", async () => {
    let consumerStarted!: () => void;
    let releaseConsumer!: () => void;
    let received: Buffer | undefined;
    const started = new Promise<void>((resolve) => { consumerStarted = resolve; });
    const consumerDone = new Promise<void>((resolve) => { releaseConsumer = resolve; });
    const controller = new AbortController();
    const api = createTelegramApi("TOKEN_SECRET", undefined, {
      request(_requestOptions, callback) {
        const request = new EventEmitter() as unknown as ClientRequest;
        request.setTimeout = () => request;
        request.destroy = () => request;
        request.end = () => {
          const response = new EventEmitter() as unknown as TelegramFileResponse & EventEmitter;
          response.statusCode = 200;
          response.headers = { "content-type": "text/plain", "content-length": "3" };
          callback(response);
          queueMicrotask(() => {
            response.emit("data", Buffer.from("abc"));
            response.emit("end");
          });
          return request;
        };
        return request;
      },
    });

    const pending = api.withDownloadedFile!("documents/file.txt", 3, controller.signal, async (bytes) => {
      received = bytes;
      consumerStarted();
      await consumerDone;
    });
    await started;
    controller.abort();
    expect(received?.toString()).toBe("abc");
    releaseConsumer();
    await pending;
    expect(received?.every((value) => value === 0)).toBe(true);
  });

  it("does not let the network deadline interrupt a consumer after body validation", async () => {
    vi.useFakeTimers();
    let consumerStarted!: () => void;
    let releaseConsumer!: () => void;
    let received: Buffer | undefined;
    const started = new Promise<void>((resolve) => { consumerStarted = resolve; });
    const consumerDone = new Promise<void>((resolve) => { releaseConsumer = resolve; });
    try {
      const api = createTelegramApi("TOKEN_SECRET", undefined, {
        request(_requestOptions, callback) {
          const request = new EventEmitter() as unknown as ClientRequest;
          request.setTimeout = () => request;
          request.destroy = () => request;
          request.end = () => {
            const response = new EventEmitter() as unknown as TelegramFileResponse & EventEmitter;
            response.statusCode = 200;
            response.headers = { "content-type": "text/plain", "content-length": "3" };
            callback(response);
            queueMicrotask(() => {
              response.emit("data", Buffer.from("abc"));
              response.emit("end");
            });
            return request;
          };
          return request;
        },
      });

      const pending = api.withDownloadedFile!("documents/file.txt", 3, undefined, async (bytes) => {
        received = bytes;
        consumerStarted();
        await consumerDone;
      });
      await started;
      const completed = expect(pending).resolves.toBeUndefined();
      await vi.advanceTimersByTimeAsync(15_001);
      expect(received?.toString()).toBe("abc");
      releaseConsumer();
      await completed;
      expect(received?.every((value) => value === 0)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cannot extend the absolute deadline by trickling response chunks", async () => {
    vi.useFakeTimers();
    let destroyed = false;
    let interval: ReturnType<typeof setInterval> | undefined;
    try {
      const api = createTelegramApi("TOKEN_SECRET", undefined, {
        request(_requestOptions, callback) {
          const request = new EventEmitter() as unknown as ClientRequest;
          request.setTimeout = () => request;
          request.destroy = () => {
            destroyed = true;
            if (interval) clearInterval(interval);
            return request;
          };
          request.end = () => {
            const response = new EventEmitter() as unknown as TelegramFileResponse & EventEmitter;
            response.statusCode = 200;
            response.headers = { "content-type": "text/plain" };
            interval = setInterval(() => response.emit("data", Buffer.from("a")), 5_000);
            callback(response);
            return request;
          };
          return request;
        },
      });
      const pending = api.withDownloadedFile!("documents/file.txt", undefined, undefined, () => undefined);
      const rejected = expect(pending).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(15_001);
      await rejected;
      expect(destroyed).toBe(true);
    } finally {
      if (interval) clearInterval(interval);
      vi.useRealTimers();
    }
  });

  it("destroys and resumes a response that arrives after timeout without streaming listeners", async () => {
    vi.useFakeTimers();
    let lateResponseCallback!: (response: TelegramFileResponse) => void;
    let requestDestroyed = false;
    try {
      const api = createTelegramApi("TOKEN_SECRET", undefined, {
        request(_requestOptions, callback) {
          lateResponseCallback = callback;
          const request = new EventEmitter() as unknown as ClientRequest;
          request.setTimeout = () => request;
          request.destroy = () => {
            requestDestroyed = true;
            return request;
          };
          request.end = () => request;
          return request;
        },
      });
      const pending = api.withDownloadedFile!("documents/file.txt", undefined, undefined, () => undefined);
      const rejected = expect(pending).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(15_001);
      await rejected;
      expect(requestDestroyed).toBe(true);

      let responseDestroyed = false;
      let responseResumed = false;
      const lateResponse = new EventEmitter() as unknown as TelegramFileResponse & EventEmitter;
      lateResponse.statusCode = 200;
      lateResponse.headers = { "content-type": "text/plain", "content-length": "3" };
      lateResponse.destroy = (() => {
        responseDestroyed = true;
        return lateResponse;
      }) as unknown as TelegramFileResponse["destroy"];
      lateResponse.resume = (() => {
        responseResumed = true;
        return lateResponse;
      }) as unknown as TelegramFileResponse["resume"];
      lateResponseCallback(lateResponse);
      expect(responseDestroyed).toBe(true);
      expect(responseResumed).toBe(true);
      expect(lateResponse.listenerCount("data")).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { file_id: "different", file_unique_id: "unique-1", file_size: 3 },
    { file_id: "file-1", file_unique_id: "different", file_size: 3 },
    { file_id: "file-1", file_unique_id: "unique-1", file_size: 4 },
  ])("rejects private download when getFile metadata changes: %#", async (file) => {
    const download = vi.fn();
    const api = {
      getFile: vi.fn(async () => ({ file_id: file.file_id, file_unique_id: file.file_unique_id, file_size: file.file_size, file_path: "documents/file.txt" })),
      withDownloadedFile: download,
    };

    await expect(withPrivateTelegramDocument(api, "file-1", "unique-1", 3, undefined, () => undefined)).rejects.toThrow(/unavailable/);
    expect(download).not.toHaveBeenCalled();
  });

  it("does not pass metadata-mutated files to the downloader", async () => {
    const download = vi.fn();
    const api = {
      getFile: vi.fn(async () => ({ file_id: "file-1", file_unique_id: "unique-1", file_size: 3, file_path: "documents/file.txt" })),
      withDownloadedFile: download,
    };
    await withPrivateTelegramDocument(api, "file-1", "unique-1", 3, undefined, () => undefined);
    expect(download).toHaveBeenCalledWith("documents/file.txt", 3, undefined, expect.any(Function));
  });

});
