import { afterEach, describe, expect, it, vi } from "vitest";
import { EmbeddingClient } from "../packages/cardano-agent/src/llm/embeddingClient.js";

const endpoint = new URL("https://embeddings.example.test/root");
const apiKey = "embedding-secret";
const model = "cardano-embedding";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function embedding(value = 0): number[] {
  return Array.from({ length: 1_536 }, () => value);
}

function providerResponse(data: unknown, status = 200, contentType = "application/json"): Response {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: { "content-type": contentType },
  });
}

function validFetch() {
  return vi.fn(async (_url: string | URL, _init?: RequestInit) => providerResponse([{ index: 0, embedding: embedding() }]));
}

describe("EmbeddingClient", () => {
  it("validates endpoint credentials and model", () => {
    expect(() => new EmbeddingClient(new URL("file:///tmp/provider"), apiKey, model)).toThrow(/http/i);
    expect(() => new EmbeddingClient(new URL("https://user:secret@provider.test"), apiKey, model)).toThrow(/credentials/i);
    expect(() => new EmbeddingClient(endpoint, " ", model)).toThrow(/key/i);
    expect(() => new EmbeddingClient(endpoint, apiKey, " ")).toThrow(/model/i);
  });

  it("rejects a wallet signing-key embedding alias before any request", () => {
    const fetch = validFetch();
    vi.stubGlobal("fetch", fetch);
    const signingKey = "addr_xsk1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";

    expect(() => new EmbeddingClient(endpoint, apiKey, signingKey)).toThrow(/model/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects empty input arrays and items before fetch", async () => {
    const fetch = validFetch();
    vi.stubGlobal("fetch", fetch);
    const client = new EmbeddingClient(endpoint, apiKey, model);

    await expect(client.embed([])).rejects.toThrow(/input/i);
    await expect(client.embed([" "])).rejects.toThrow(/input/i);
    await expect(client.embed(["x".repeat(100_001)])).rejects.toThrow(/large|100,?000/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("posts the normalized request and maps batch indexes", async () => {
    const fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model: string; input: string[] };
      return providerResponse(body.input.map((_, index) => ({ index, embedding: embedding(index) })));
    });
    vi.stubGlobal("fetch", fetch);
    const client = new EmbeddingClient(endpoint, apiKey, model);

    await expect(client.embed(["first", "second"])).resolves.toEqual([
      { index: 0, embedding: embedding(0) },
      { index: 1, embedding: embedding(1) },
    ]);
    expect(fetch).toHaveBeenCalledWith("https://embeddings.example.test/root/v1/embeddings", expect.objectContaining({
      method: "POST",
      redirect: "error",
      headers: expect.objectContaining({ authorization: `Bearer ${apiKey}`, "content-type": "application/json" }),
      body: JSON.stringify({ model, input: ["first", "second"] }),
    }));
  });

  it("partitions sequentially at 64 inputs and 100,000 characters", async () => {
    const batches: string[][] = [];
    const fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      batches.push(body.input);
      return providerResponse(body.input.map((_, index) => ({ index, embedding: embedding() })));
    });
    vi.stubGlobal("fetch", fetch);
    const client = new EmbeddingClient(endpoint, apiKey, model);

    const inputs = Array.from({ length: 65 }, (_, index) => `item-${index}`);
    await client.embed(inputs);
    expect(batches.map((batch) => batch.length)).toEqual([64, 1]);

    batches.length = 0;
    await client.embed(["a".repeat(100_000), "b"]);
    expect(batches).toEqual([["a".repeat(100_000)], ["b"]]);
  });

  it("honors an already-aborted signal without calling the provider", async () => {
    const fetch = validFetch();
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    controller.abort();

    await expect(new EmbeddingClient(endpoint, apiKey, model).embed(["input"], controller.signal)).rejects.toThrow(/abort|request failed/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("stops before a later batch when the caller aborts", async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      controller.abort();
      return providerResponse(body.input.map((_, index) => ({ index, embedding: embedding() })));
    });
    vi.stubGlobal("fetch", fetch);

    await expect(new EmbeddingClient(endpoint, apiKey, model).embed(Array.from({ length: 65 }, (_, index) => `item-${index}`), controller.signal)).rejects.toThrow(/abort|request failed/i);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["count", [{ index: 0, embedding: embedding() }]],
    ["order", [{ index: 1, embedding: embedding() }, { index: 0, embedding: embedding() }]],
    ["dimension", [{ index: 0, embedding: [0] }]],
    ["nonfinite", [{ index: 0, embedding: Object.assign(embedding(), { 0: Number.NaN }) }]],
  ])("rejects malformed provider %s payloads", async (_name, data) => {
    vi.stubGlobal("fetch", vi.fn(async () => providerResponse(data)));
    const client = new EmbeddingClient(endpoint, apiKey, model);
    await expect(client.embed(["input", "second"])).rejects.toThrow(/malformed|embedding/i);
  });

  it("rejects sparse provider vectors instead of mapping over holes", async () => {
    const sparse = new Array<number>(1_536).fill(0);
    delete sparse[17];
    const originalParse = JSON.parse;
    vi.spyOn(JSON, "parse").mockImplementation((value: string) => ({
      data: [{ index: 0, embedding: sparse }],
      ...(value.length === 0 ? { ignored: true } : {}),
    }));
    vi.stubGlobal("fetch", vi.fn(async () => providerResponse([{ index: 0, embedding: embedding() }])));
    const client = new EmbeddingClient(endpoint, apiKey, model);

    await expect(client.embed(["input"])).rejects.toThrow(/malformed|embedding/i);
    JSON.parse = originalParse;
  });

  it("cancels a body after repeated empty reads", async () => {
    let reads = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads += 1;
        controller.enqueue(new Uint8Array());
      },
      cancel() {
        cancelled = true;
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { headers: { "content-type": "application/json" } })));
    const client = new EmbeddingClient(endpoint, apiKey, model);

    await expect(client.embed(["input"])).rejects.toThrow(/malformed|response/i);
    expect(reads).toBeLessThan(34);
    expect(cancelled).toBe(true);
  });

  it("maps a provider timeout or abort to a safe request error", async () => {
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL, init?: RequestInit) => {
      requestSignal = init?.signal as AbortSignal | undefined;
      throw new DOMException("provider timeout", "TimeoutError");
    }));
    const client = new EmbeddingClient(endpoint, apiKey, model);

    await expect(client.embed(["input"])).rejects.toThrow("Embedding request failed");
    expect(requestSignal).toBeDefined();
  });

  it("rejects non-JSON, oversized, non-success, and network responses without secrets", async () => {
    const client = new EmbeddingClient(endpoint, apiKey, model);
    vi.stubGlobal("fetch", vi.fn(async () => providerResponse([], 200, "text/plain")));
    await expect(client.embed(["input"])).rejects.toThrow(/content-type/i);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("x", {
      headers: { "content-type": "application/json", "content-length": String(9 * 1024 * 1024) },
    })));
    const oversized = await client.embed(["input"]).catch((error: unknown) => error);
    expect(oversized).toBeInstanceOf(Error);
    expect((oversized as Error).message).not.toContain(apiKey);

    vi.stubGlobal("fetch", vi.fn(async () => providerResponse({ error: "provider detail" }, 500)));
    await expect(client.embed(["input"])).rejects.toThrow(/request failed/i);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error(`network ${apiKey}`); }));
    await expect(client.embed(["input"])).rejects.toThrow(/request failed/i);
  });
});
