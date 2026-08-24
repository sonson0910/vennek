import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LiteLlmClient,
  selectModelProfile,
} from "@vennek/cardano-agent";

const endpoint = new URL("http://litellm:4000");
const apiKey = "test-key";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function successResponse(overrides: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: "Cardano answer" } }],
      usage: { prompt_tokens: 4, completion_tokens: 2 },
      ...overrides,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function trackedEmptyBody(cancel: (reason?: unknown) => void): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    cancel(reason) {
      cancel(reason);
    },
  });
}

describe("LiteLLM client", () => {
  it("uses the fixed OpenAI-compatible endpoint and never logs prompts", async () => {
    const fetchMock = vi.fn().mockResolvedValue(successResponse());
    vi.stubGlobal("fetch", fetchMock);
    const logSpy = vi.spyOn(console, "log");
    const client = new LiteLlmClient(endpoint, apiKey);

    await expect(
      client.complete({
        model: "cardano-fast",
        messages: [{ role: "user", content: "xin chào" }],
        temperature: 0.2,
      }),
    ).resolves.toEqual({
      text: "Cardano answer",
      promptTokens: 4,
      completionTokens: 2,
      model: "cardano-fast",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://litellm:4000/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        signal: expect.any(AbortSignal),
        headers: {
          accept: "application/json",
          authorization: "Bearer test-key",
          "content-type": "application/json",
        },
      }),
    );
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toEqual({
      model: "cardano-fast",
      messages: [{ role: "user", content: "xin chào" }],
      temperature: 0.2,
      store: false,
    });
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("uses the 45-second timeout signal", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(successResponse()));

    await new LiteLlmClient(endpoint, apiKey).complete({
      model: "cardano-fast",
      messages: [],
    });

    expect(timeoutSpy).toHaveBeenCalledWith(45_000);
  });

  it("rejects malformed success responses without exposing the body", async () => {
    const providerSecret = "provider-internal-secret";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: providerSecret }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const result = new LiteLlmClient(endpoint, apiKey).complete({
      model: "cardano-fast",
      messages: [],
    });
    await expect(result).rejects.toThrow(/malformed/i);
    await expect(result).rejects.not.toThrow(providerSecret);
  });

  it("rejects invalid JSON, content type, and response fields", async () => {
    const cases = [
      new Response("not-json", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      new Response(JSON.stringify({ choices: [{ message: { content: 1 } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: -1, completion_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
      new Response(JSON.stringify({ choices: [], usage: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ];

    for (const response of cases) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
      await expect(
        new LiteLlmClient(endpoint, apiKey).complete({
          model: "cardano-fast",
          messages: [],
        }),
      ).rejects.toThrow(/malformed|content-type/i);
    }
  });

  it("rejects a non-JSON response before parsing it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("Cardano answer", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
      ),
    );

    await expect(
      new LiteLlmClient(endpoint, apiKey).complete({
        model: "cardano-fast",
        messages: [],
      }),
    ).rejects.toThrow(/content-type/i);
  });

  it("rejects responses over the byte limit from content length", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("{}", {
          status: 200,
          headers: {
            "content-type": "application/json",
            "content-length": String(2 * 1024 * 1024 + 1),
          },
        }),
      ),
    );

    await expect(
      new LiteLlmClient(endpoint, apiKey).complete({
        model: "cardano-fast",
        messages: [],
      }),
    ).rejects.toThrow(/too large/i);
  });

  it("cancels unconsumed response bodies on early rejection", async () => {
    const cases = [
      {
        response: (cancel: (reason?: unknown) => void) =>
          new Response(trackedEmptyBody(cancel), {
            status: 503,
            headers: { "content-type": "application/json" },
          }),
        message: /request failed/i,
      },
      {
        response: (cancel: (reason?: unknown) => void) =>
          new Response(trackedEmptyBody(cancel), {
            status: 200,
            headers: { "content-type": "text/plain" },
          }),
        message: /content-type/i,
      },
      {
        response: (cancel: (reason?: unknown) => void) =>
          new Response(trackedEmptyBody(cancel), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "content-length": "not-a-number",
            },
          }),
        message: /malformed/i,
      },
      {
        response: (cancel: (reason?: unknown) => void) =>
          new Response(trackedEmptyBody(cancel), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "content-length": String(2 * 1024 * 1024 + 1),
            },
          }),
        message: /too large/i,
      },
    ];

    for (const { response, message } of cases) {
      const cancel = vi.fn();
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(cancel)));
      await expect(
        new LiteLlmClient(endpoint, apiKey).complete({ model: "cardano-fast", messages: [] }),
      ).rejects.toThrow(message);
      expect(cancel).toHaveBeenCalled();
    }
  });

  it("caps chunked responses incrementally", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let reads = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (reads++ < 3) controller.enqueue(chunk);
        else controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(body, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(
      new LiteLlmClient(endpoint, apiKey).complete({
        model: "cardano-fast",
        messages: [],
      }),
    ).rejects.toThrow(/too large/i);
  });

  it("accepts a fragmented body with a few empty chunks", async () => {
    const encoder = new TextEncoder();
    const chunks = [
      new Uint8Array(),
      encoder.encode('{"choices":['),
      new Uint8Array(),
      encoder.encode('{"message":{"content":"ok"}}],'),
      encoder.encode('"usage":{"prompt_tokens":1,"completion_tokens":1}}'),
    ];
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(body, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(
      new LiteLlmClient(endpoint, apiKey).complete({ model: "cardano-fast", messages: [] }),
    ).resolves.toMatchObject({ text: "ok", promptTokens: 1, completionTokens: 1 });
  });

  it("fails a stream that makes no byte progress indefinitely", async () => {
    let reads = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (reads++ < 40) controller.enqueue(new Uint8Array());
        else controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(body, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(
      new LiteLlmClient(endpoint, apiKey).complete({ model: "cardano-fast", messages: [] }),
    ).rejects.toThrow(/malformed/i);
  });

  it("rejects redirects and provider errors without returning their bodies", async () => {
    const prompt = "private user prompt";
    const providerBody = `${apiKey} ${prompt} provider traceback`;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(providerBody, {
          status: 302,
          headers: {
            location: "https://attacker.invalid/steal",
            "content-type": "text/plain",
          },
        }),
      ),
    );

    const result = new LiteLlmClient(endpoint, apiKey).complete({
      model: "cardano-fast",
      messages: [{ role: "user", content: prompt }],
    });
    await expect(result).rejects.toThrow(/request failed/i);
    await expect(result).rejects.not.toThrow(providerBody);
  });

  it("handles an abort while incrementally reading the response body", async () => {
    const controller = new AbortController();
    const abortObserved = vi.fn();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = new ReadableStream<Uint8Array>({
          start(streamController) {
            init.signal?.addEventListener("abort", abortObserved);
            init.signal?.addEventListener("abort", () =>
              streamController.error(new DOMException("aborted", "AbortError")),
            );
            streamController.enqueue(new TextEncoder().encode("{"));
            queueMicrotask(() => controller.abort());
          },
        });
        return new Response(body, {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    await expect(
      new LiteLlmClient(endpoint, apiKey).complete({ model: "cardano-fast", messages: [] }),
    ).rejects.toThrow(/malformed/i);
    expect(abortObserved).toHaveBeenCalled();
  });

  it("preserves a configured base path when joining the chat endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(successResponse());
    vi.stubGlobal("fetch", fetchMock);

    await new LiteLlmClient(new URL("https://litellm.example/cardano/"), apiKey).complete({
      model: "cardano-fast",
      messages: [],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://litellm.example/cardano/v1/chat/completions",
      expect.any(Object),
    );
  });

  it("rejects invalid caller inputs", async () => {
    const fetchMock = vi.fn().mockResolvedValue(successResponse());
    vi.stubGlobal("fetch", fetchMock);
    const client = new LiteLlmClient(endpoint, apiKey);

    await expect(client.complete({ model: " ", messages: [] })).rejects.toThrow(/model/i);
    await expect(
      client.complete({ model: "fast", messages: [{ role: "tool" as never, content: "x" }] }),
    ).rejects.toThrow(/message/i);
    await expect(
      client.complete({ model: "fast", messages: [{ role: "user", content: 1 as never }] }),
    ).rejects.toThrow(/message/i);
    await expect(
      client.complete({ model: "fast", messages: [], temperature: Number.NaN }),
    ).rejects.toThrow(/temperature/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("model profile router", () => {
  it("selects fast only for simple, low-source questions", () => {
    expect(selectModelProfile({ sourceCount: 6, hasConflicts: false, technical: false })).toBe("fast");
    expect(selectModelProfile({ sourceCount: 7, hasConflicts: false, technical: false })).toBe("quality");
    expect(selectModelProfile({ sourceCount: 0, hasConflicts: true, technical: false })).toBe("quality");
    expect(selectModelProfile({ sourceCount: 0, hasConflicts: false, technical: true })).toBe("quality");
  });
});
