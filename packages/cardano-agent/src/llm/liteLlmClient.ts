const REQUEST_TIMEOUT_MS = 45_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_EMPTY_READS = 32;

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type CompletionInput = {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
};

export type CompletionOutput = {
  text: string;
  promptTokens: number;
  completionTokens: number;
  model: string;
};

class LiteLlmFailure extends Error {}

function malformedResponse(): LiteLlmFailure {
  return new LiteLlmFailure("LiteLLM response malformed");
}

function validateInput(input: CompletionInput): void {
  if (!input || typeof input !== "object") {
    throw new Error("LiteLLM completion input is required");
  }
  if (typeof input.model !== "string" || !input.model.trim()) {
    throw new Error("LiteLLM model is required");
  }
  if (!Array.isArray(input.messages)) {
    throw new Error("LiteLLM messages are required");
  }
  for (const message of input.messages) {
    if (
      !message ||
      typeof message !== "object" ||
      !["system", "user", "assistant"].includes(message.role) ||
      typeof message.content !== "string"
    ) {
      throw new Error("LiteLLM message is invalid");
    }
  }
  if (
    input.temperature !== undefined &&
    (!Number.isFinite(input.temperature) || input.temperature < 0 || input.temperature > 2)
  ) {
    throw new Error("LiteLLM temperature is invalid");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

async function readBoundedBody(response: Response): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const normalized = contentLength.trim();
    if (!/^\d+$/.test(normalized)) throw malformedResponse();
    const length = Number(normalized);
    if (!Number.isSafeInteger(length)) throw malformedResponse();
    if (length > MAX_RESPONSE_BYTES) {
      throw new LiteLlmFailure("LiteLLM response too large");
    }
  }

  if (!response.body) throw malformedResponse();
  const reader = response.body.getReader();
  const bytes = new Uint8Array(MAX_RESPONSE_BYTES);
  let total = 0;
  let emptyReads = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw malformedResponse();
      if (value.byteLength === 0) {
        if (++emptyReads >= MAX_EMPTY_READS) throw malformedResponse();
        continue;
      }
      emptyReads = 0;
      if (total + value.byteLength > MAX_RESPONSE_BYTES) {
        throw new LiteLlmFailure("LiteLLM response too large");
      }
      bytes.set(value, total);
      total += value.byteLength;
    }
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // The original safe error is more useful than a provider stream error.
    }
    throw error;
  } finally {
    reader.releaseLock();
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, total));
  } catch {
    throw malformedResponse();
  }
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Cancellation is best effort and must not replace the safe client error.
  }
}

function parseCompletion(body: string, requestedModel: string): CompletionOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw malformedResponse();
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.choices) || parsed.choices.length < 1) {
    throw malformedResponse();
  }
  const choice = parsed.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message) || typeof choice.message.content !== "string") {
    throw malformedResponse();
  }
  if (!isRecord(parsed.usage)) throw malformedResponse();
  const promptTokens = readNonNegativeInteger(parsed.usage.prompt_tokens);
  const completionTokens = readNonNegativeInteger(parsed.usage.completion_tokens);
  if (promptTokens === undefined || completionTokens === undefined) {
    throw malformedResponse();
  }

  const model = parsed.model;
  if (model !== undefined && (typeof model !== "string" || !model.trim())) {
    throw malformedResponse();
  }
  return {
    text: choice.message.content,
    promptTokens,
    completionTokens,
    model: model === undefined ? requestedModel : model,
  };
}

export class LiteLlmClient {
  private readonly endpoint: string;
  private readonly apiKey: string;

  constructor(baseUrl: URL, apiKey: string) {
    if (!(baseUrl instanceof URL) || !["http:", "https:"].includes(baseUrl.protocol)) {
      throw new Error("LiteLLM base URL must use http or https");
    }
    if (baseUrl.username || baseUrl.password) {
      throw new Error("LiteLLM base URL must not include credentials");
    }
    if (typeof apiKey !== "string" || !apiKey.trim()) {
      throw new Error("LiteLLM API key is required");
    }
    const normalizedBaseUrl = new URL(baseUrl.toString());
    if (!normalizedBaseUrl.pathname.endsWith("/")) normalizedBaseUrl.pathname += "/";
    this.endpoint = new URL("v1/chat/completions", normalizedBaseUrl).toString();
    this.apiKey = apiKey.trim();
  }

  async complete(input: CompletionInput): Promise<CompletionOutput> {
    validateInput(input);
    const requestMessages = input.messages.map(({ role, content }) => ({ role, content }));
    const requestBody = JSON.stringify({
      model: input.model,
      messages: requestMessages,
      ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
      store: false,
    });

    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: requestBody,
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new Error("LiteLLM request failed");
    }

    if (!response.ok) {
      await cancelResponseBody(response);
      throw new Error("LiteLLM request failed");
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
    if (contentType !== "application/json") {
      await cancelResponseBody(response);
      throw new Error("LiteLLM response content-type invalid");
    }

    let body: string;
    try {
      body = await readBoundedBody(response);
    } catch (error) {
      await cancelResponseBody(response);
      if (error instanceof LiteLlmFailure) throw error;
      throw malformedResponse();
    }
    return parseCompletion(body, input.model);
  }
}
