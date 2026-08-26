import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  fetchStackExchangeSource,
  type StackExchangeSourceResult,
} from "../packages/cardano-agent/src/knowledge/stackExchangeSource.js";
import type { StackExchangeFetchState } from "../packages/cardano-agent/src/knowledge/knowledgeRepository.js";
import type { PublicHttpsRequest } from "@vennek/cardano-governance-skills";
import type { SourceRegistryEntry } from "@vennek/cardano-agent";

const now = new Date("2026-08-24T00:00:00.000Z");
const entry: Extract<SourceRegistryEntry, { kind: "stackexchange" }> = {
  id: "cardano-stackexchange",
  owner: "Cardano",
  trustTier: "official",
  kind: "stackexchange",
  url: "https://api.stackexchange.com/2.3/questions",
  allowedDomains: ["api.stackexchange.com", "cardano.stackexchange.com"],
  topics: ["questions"],
  networks: ["mainnet"],
  refresh: "daily",
  stackExchange: { site: "cardano" },
};

describe("bounded Cardano Stack Exchange ingestion", () => {
  it("requests sorted questions then their answers and builds safe citations", async () => {
    const calls: Array<{ path: string; headers: Record<string, string> }> = [];
    const request = responseRequest(calls, (path) => path.includes("/answers")
      ? {
          items: [{
            answer_id: 22,
            question_id: 11,
            body: "<p>Answer <script>bad()</script><span class=hidden>secret</span>text.</p>",
            creation_date: 1_700_000_001,
            content_license: "CC BY-SA 4.0",
            owner: { user_id: 7, display_name: "Answerer", link: "https://cardano.stackexchange.com/users/7/name" },
          }],
          has_more: false,
          quota_remaining: 98,
        }
      : {
          items: [{
            question_id: 11,
            title: "How?",
            body: "<p>Question <style>.x{}</style>body.</p>",
            creation_date: 1_700_000_000,
            last_activity_date: 1_700_000_010,
            content_license: "CC BY-SA 4.0",
            owner: { user_id: 7, display_name: "Asker", link: "https://cardano.stackexchange.com/users/7/name" },
          }],
          has_more: false,
          quota_remaining: 99,
        });
    const repository = fakeRepository();

    const result: StackExchangeSourceResult = await fetchStackExchangeSource({
      entry,
      repository,
      signal: new AbortController().signal,
      now,
      lookup: publicLookup,
      request,
    });

    expect(calls.map(({ path }) => path)).toEqual([
      "/2.3/questions?order=desc&sort=activity&pagesize=100&page=1&filter=withbody&site=cardano",
      "/2.3/questions/11/answers?order=desc&sort=activity&pagesize=100&page=1&filter=withbody&site=cardano",
    ]);
    expect(calls.every(({ headers }) => headers["accept-encoding"] === "identity")).toBe(true);
    expect(result.documents).toHaveLength(2);
    expect(result.documents.map((document) => document.canonicalUrl)).toEqual([
      "https://cardano.stackexchange.com/questions/11",
      "https://cardano.stackexchange.com/a/22",
    ]);
    expect(result.documents[0]?.text).toContain("Author: Asker");
    expect(result.documents[1]?.text).toContain("Answer text.");
    expect(result.documents[1]?.text).not.toContain("bad");
    expect(result.documents[1]?.text).not.toContain("secret");
    expect(result.commitState).toBeTypeOf("function");
    await expect(result.commitState?.()).resolves.toBe(true);
    expect(repository.compareAndSetStackExchangeFetchState).toHaveBeenCalledWith(
      entry.id,
      null,
      { checkedAt: now.toISOString(), quotaRemaining: 98 },
      undefined,
    );
  });

  it("returns a stored future retry without touching the API", async () => {
    const request = vi.fn() as unknown as PublicHttpsRequest;
    const repository = fakeRepository({ retryAt: "2026-08-24T00:05:00.000Z" });

    await expect(fetchStackExchangeSource({ entry, repository, signal: new AbortController().signal, now, request })).resolves.toEqual({
      documents: [],
      unchanged: 0,
      deferredUntil: new Date("2026-08-24T00:05:00.000Z"),
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("discards staged documents and persists a bounded quota deferral", async () => {
    const calls: Array<{ path: string; headers: Record<string, string> }> = [];
    const request = responseRequest(calls, () => ({ items: [], has_more: false, quota_remaining: 0 }));
    const repository = fakeRepository();

    const result = await fetchStackExchangeSource({ entry, repository, signal: new AbortController().signal, now, request });

    expect(result.documents).toEqual([]);
    expect(result.deferredUntil).toEqual(new Date("2026-08-24T00:01:00.000Z"));
    expect(repository.compareAndSetStackExchangeFetchState).toHaveBeenCalledWith(
      entry.id,
      null,
      { checkedAt: now.toISOString(), retryAt: "2026-08-24T00:01:00.000Z", quotaRemaining: 0 },
      expect.objectContaining({ signal: expect.any(AbortSignal), timeoutMs: 5_000 }),
    );
  });

  it("stops immediately on question backoff, discards staged docs, and persists actual quota", async () => {
    const calls: Array<{ path: string; headers: Record<string, string> }> = [];
    const request = responseRequest(calls, (path) => path.includes("/answers")
      ? { items: [], has_more: false, quota_remaining: 3 }
      : { items: [question(11)], has_more: false, quota_remaining: 7, backoff: 1 });
    const repository = fakeRepository();

    const result = await fetchStackExchangeSource({ entry, repository, signal: new AbortController().signal, now, request });

    expect(result.documents).toEqual([]);
    expect(result.deferredUntil).toEqual(new Date("2026-08-24T00:01:00.000Z"));
    expect(calls).toHaveLength(1);
    expect(repository.compareAndSetStackExchangeFetchState).toHaveBeenCalledWith(
      entry.id,
      null,
      { checkedAt: now.toISOString(), retryAt: "2026-08-24T00:01:00.000Z", quotaRemaining: 7 },
      expect.objectContaining({ timeoutMs: 5_000 }),
    );
  });

  it("stops immediately on answer backoff after staging a question", async () => {
    const calls: Array<{ path: string; headers: Record<string, string> }> = [];
    const request = responseRequest(calls, (path) => path.includes("/answers")
      ? { items: [], has_more: false, quota_remaining: 6, backoff: 1 }
      : { items: [question(11)], has_more: false, quota_remaining: 8 });
    const repository = fakeRepository();

    const result = await fetchStackExchangeSource({ entry, repository, signal: new AbortController().signal, now, request });

    expect(result.documents).toEqual([]);
    expect(calls).toHaveLength(2);
    expect(repository.compareAndSetStackExchangeFetchState).toHaveBeenCalledWith(
      entry.id,
      null,
      { checkedAt: now.toISOString(), retryAt: "2026-08-24T00:01:00.000Z", quotaRemaining: 6 },
      expect.objectContaining({ timeoutMs: 5_000 }),
    );
  });

  it("clamps backoff to the minimum and maximum retry windows", async () => {
    const minimum = responseRequest([], () => ({ items: [], has_more: false, quota_remaining: 4, backoff: 0 }));
    await expect(fetchStackExchangeSource({ entry, repository: fakeRepository(), signal: new AbortController().signal, now, request: minimum })).resolves.toMatchObject({
      deferredUntil: new Date("2026-08-24T00:01:00.000Z"),
      documents: [],
    });

    const maximum = responseRequest([], () => ({ items: [], has_more: false, quota_remaining: 4, backoff: Number.MAX_SAFE_INTEGER }));
    await expect(fetchStackExchangeSource({ entry, repository: fakeRepository(), signal: new AbortController().signal, now, request: maximum })).resolves.toMatchObject({
      deferredUntil: new Date("2026-08-25T00:00:00.000Z"),
      documents: [],
    });
  });

  it("passes the total retrieval signal and deadline to repository bootstrap", async () => {
    let releaseEnsure!: () => void;
    const ensureStarted = new Promise<void>((resolve) => { releaseEnsure = resolve; });
    const repository = fakeRepository();
    vi.mocked(repository.ensureSource).mockImplementation(async (_entry, rawOptions) => {
      const options = rawOptions as { signal?: AbortSignal; deadlineAt?: number } | undefined;
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      expect(options?.deadlineAt).toBeTypeOf("number");
      await ensureStarted;
      return undefined;
    });
    const controller = new AbortController();
    const pending = fetchStackExchangeSource({ entry, repository, signal: controller.signal, now, request: vi.fn() as unknown as PublicHttpsRequest });
    await Promise.resolve();
    controller.abort();
    releaseEnsure();
    await expect(pending).rejects.toThrow(/abort/i);
    expect(repository.getStackExchangeFetchState).not.toHaveBeenCalled();
  });

  it("cancels an in-flight API request when the caller aborts", async () => {
    const controller = new AbortController();
    let destroyed = false;
    const request = ((options, callback) => {
      const client = Object.assign(new EventEmitter(), {
        end() {},
        destroy() { destroyed = true; },
      });
      setTimeout(() => {
        if (destroyed) return;
        const body = Readable.from([Buffer.from(JSON.stringify({ items: [], has_more: false, quota_remaining: 1 }))]);
        Object.assign(body, { statusCode: 200, headers: { "content-type": "application/json", "content-length": "55" } });
        callback(body as never);
      }, 100);
      return client as never;
    }) as PublicHttpsRequest;
    const pending = fetchStackExchangeSource({ entry, repository: fakeRepository(), signal: controller.signal, now, request });
    setTimeout(() => controller.abort(), 5);

    await expect(pending).rejects.toThrow(/abort/i);
    expect(destroyed).toBe(true);
  });

  it("aborts an in-flight initial state read before any network request", async () => {
    let releaseState!: () => void;
    const stateStarted = new Promise<void>((resolve) => { releaseState = resolve; });
    const repository = fakeRepository();
    vi.mocked(repository.getStackExchangeFetchState).mockImplementation(async () => {
      await stateStarted;
      return null;
    });
    const controller = new AbortController();
    const request = vi.fn() as unknown as PublicHttpsRequest;
    const pending = fetchStackExchangeSource({ entry, repository, signal: controller.signal, now, request });
    await Promise.resolve();
    controller.abort();
    releaseState();

    await expect(pending).rejects.toThrow(/abort/i);
    expect(request).not.toHaveBeenCalled();
  });

  it("bounds author display names at exactly 120 characters", async () => {
    const request = responseRequest([], (path) => path.includes("/answers")
      ? { items: [], has_more: false, quota_remaining: 2 }
      : {
          items: [question(11, { owner: { user_id: 7, display_name: "a".repeat(121) } })],
          has_more: false,
          quota_remaining: 3,
        });
    const result = await fetchStackExchangeSource({ entry, repository: fakeRepository(), signal: new AbortController().signal, now, request });
    expect(result.documents[0]?.text).toContain(`Author: ${"a".repeat(120)}`);
    expect(result.documents[0]?.text).not.toContain(`Author: ${"a".repeat(121)}`);
  });

  it("enforces the final UTF-16 document limit after attribution", async () => {
    const canonical = "https://cardano.stackexchange.com/questions/11";
    const attribution = [
      "Attribution:",
      "Author: deleted user",
      "Author URL: unavailable",
      "License: CC BY-SA 4.0",
      `Source: ${canonical}`,
    ].join("\n");
    const body = "😀".repeat(Math.floor((2_000_000 - attribution.length) / 2));
    const request = responseRequest([], (path) => path.includes("/answers")
      ? { items: [], has_more: false, quota_remaining: 2 }
      : { items: [question(11, { body })], has_more: false, quota_remaining: 3 });

    await expect(fetchStackExchangeSource({ entry, repository: fakeRepository(), signal: new AbortController().signal, now, request })).rejects.toThrow(/large|size/i);
  });

  it("follows bounded answer pagination and never requests a sixth answer page", async () => {
    const calls: Array<{ path: string; headers: Record<string, string> }> = [];
    const request = responseRequest(calls, (path) => {
      if (!path.includes("/answers")) return { items: [question(11)], has_more: false, quota_remaining: 10 };
      const page = Number(new URL(`https://api.stackexchange.com${path}`).searchParams.get("page"));
      return { items: page <= 2 ? [answer(page + 20, 11)] : [], has_more: page < 5, quota_remaining: 10 - page };
    });
    const result = await fetchStackExchangeSource({ entry, repository: fakeRepository(), signal: new AbortController().signal, now, request });
    expect(result.documents).toHaveLength(3);
    expect(calls.filter(({ path }) => path.includes("/answers")).map(({ path }) => new URL(`https://api.stackexchange.com${path}`).searchParams.get("page"))).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("caps a full five-page question feed at 500 documents", async () => {
    const request = responseRequest([], (path) => {
      if (path.includes("/answers")) return { items: [], has_more: false, quota_remaining: 10 };
      const page = Number(new URL(`https://api.stackexchange.com${path}`).searchParams.get("page"));
      return { items: Array.from({ length: 100 }, (_, index) => question((page - 1) * 100 + index + 1)), has_more: page < 5, quota_remaining: 10 };
    });
    const result = await fetchStackExchangeSource({ entry, repository: fakeRepository(), signal: new AbortController().signal, now, request });
    expect(result.documents).toHaveLength(500);
  });

  it("enforces the sequential 128 MiB aggregate response budget", async () => {
    const calls: Array<{ path: string; headers: Record<string, string> }> = [];
    const questionBodies = Array.from({ length: 5 }, (_, page) => exactJsonBody({ items: [question(page + 1)], has_more: true, quota_remaining: 10 }));
    const answerBody = exactJsonBody({ items: [], has_more: true, quota_remaining: 10 });
    const request = rawResponseRequest(calls, (path) => {
      if (path.includes("/answers")) return { contentType: "application/json", body: answerBody };
      const page = Number(new URL(`https://api.stackexchange.com${path}`).searchParams.get("page"));
      return { contentType: "application/json", body: questionBodies[page - 1]! };
    });

    await expect(fetchStackExchangeSource({ entry, repository: fakeRepository(), signal: new AbortController().signal, now, request })).rejects.toThrow(/aggregate/i);
    expect(calls).toHaveLength(16);
  });

  it("rejects oversized, unsupported, malformed, and error API responses", async () => {
    const cases: Array<[string, RawResponse, RegExp]> = [
      ["oversized", { contentType: "application/json", body: "{}", contentLength: String(8 * 1024 * 1024 + 1) }, /too large/i],
      ["unsupported content type", { contentType: "text/plain", body: "not json" }, /content-type/i],
      ["http", { statusCode: 503, contentType: "application/json", body: "{}" }, /HTTP 503/i],
      ["malformed JSON", { contentType: "application/json", body: "{" }, /JSON/i],
      ["invalid wrapper", { contentType: "application/json", body: JSON.stringify([]) }, /wrapper/i],
      ["API error wrapper", { contentType: "application/json", body: JSON.stringify({ error_id: 400, error_message: "bad", error_name: "bad" }) }, /error wrapper/i],
      ["invalid items", { contentType: "application/json", body: JSON.stringify({ items: {}, has_more: false, quota_remaining: 1 }) }, /items/i],
      ["too many items", { contentType: "application/json", body: JSON.stringify({ items: Array.from({ length: 101 }, () => null), has_more: false, quota_remaining: 1 }) }, /page is too large/i],
      ["invalid UTF-8", { contentType: "application/json", body: new Uint8Array([0xff, 0xfe]) }, /UTF-8/i],
    ];
    for (const [name, spec, error] of cases) {
      const request = rawResponseRequest([], () => ({ ...spec }));
      await expect(fetchStackExchangeSource({ entry, repository: fakeRepository(), signal: new AbortController().signal, now, request }), name).rejects.toThrow(error);
    }
  });

  it("rejects invalid IDs, timestamps, and duplicate answer IDs", async () => {
    for (const overrides of [
      { question_id: 0 },
      { question_id: Number.MAX_SAFE_INTEGER + 1 },
      { creation_date: -1 },
      { last_activity_date: "bad" },
    ]) {
      const request = responseRequest([], () => ({ items: [question(11, overrides)], has_more: false, quota_remaining: 1 }));
      await expect(fetchStackExchangeSource({ entry, repository: fakeRepository(), signal: new AbortController().signal, now, request })).rejects.toThrow(/invalid/i);
    }
    const duplicate = responseRequest([], (path) => path.includes("/answers")
      ? { items: [answer(22, 11), answer(22, 11)], has_more: false, quota_remaining: 1 }
      : { items: [question(11)], has_more: false, quota_remaining: 2 });
    await expect(fetchStackExchangeSource({ entry, repository: fakeRepository(), signal: new AbortController().signal, now, request: duplicate })).rejects.toThrow(/answer IDs/i);
  });

  it("returns false from the adapter commit callback without retrying CAS", async () => {
    const repository = fakeRepository();
    repository.compareAndSetStackExchangeFetchState = vi.fn(async () => false);
    const request = responseRequest([], (path) => path.includes("/answers")
      ? { items: [], has_more: false, quota_remaining: 1 }
      : { items: [question(11)], has_more: false, quota_remaining: 2 });
    const result = await fetchStackExchangeSource({ entry, repository, signal: new AbortController().signal, now, request });
    await expect(result.commitState?.()).resolves.toBe(false);
    expect(repository.compareAndSetStackExchangeFetchState).toHaveBeenCalledOnce();
  });

  it("uses an already persisted retry after a backoff CAS conflict", async () => {
    const repository = fakeRepository();
    repository.getStackExchangeFetchState = vi.fn(async () => repository.getStackExchangeFetchState.mock.calls.length > 1
      ? { retryAt: "2026-08-24T00:05:00.000Z" }
      : null);
    repository.compareAndSetStackExchangeFetchState = vi.fn(async () => false);
    const request = responseRequest([], () => ({ items: [], has_more: false, quota_remaining: 2, backoff: 1 }));

    await expect(fetchStackExchangeSource({ entry, repository, signal: new AbortController().signal, now, request })).resolves.toMatchObject({
      documents: [],
      deferredUntil: new Date("2026-08-24T00:05:00.000Z"),
    });
    expect(repository.getStackExchangeFetchState).toHaveBeenCalledTimes(2);
  });

  it("bounds question pagination and rejects duplicate question IDs", async () => {
    const calls: Array<{ path: string; headers: Record<string, string> }> = [];
    const request = responseRequest(calls, () => ({ items: [], has_more: true, quota_remaining: 10 }));

    const result = await fetchStackExchangeSource({ entry, repository: fakeRepository(), signal: new AbortController().signal, now, request });

    expect(result.documents).toEqual([]);
    expect(calls.map(({ path }) => new URL(`https://api.stackexchange.com${path}`).searchParams.get("page"))).toEqual(["1", "2", "3", "4", "5"]);

    const duplicate = responseRequest([], () => ({
      items: [question(11), question(11)],
      has_more: false,
      quota_remaining: 10,
    }));
    await expect(fetchStackExchangeSource({ entry, repository: fakeRepository(), signal: new AbortController().signal, now, request: duplicate })).rejects.toThrow(/question IDs/i);
  });

  it("fails closed for unknown licenses and attacker author links", async () => {
    const invalidLicense = responseRequest([], () => ({
      items: [question(11, { content_license: "CC BY-SA 5.0" })],
      has_more: false,
      quota_remaining: 10,
    }));
    await expect(fetchStackExchangeSource({ entry, repository: fakeRepository(), signal: new AbortController().signal, now, request: invalidLicense })).rejects.toThrow(/license/i);

    const calls: Array<{ path: string; headers: Record<string, string> }> = [];
    const request = responseRequest(calls, (path) => path.includes("/answers")
      ? { items: [], has_more: false, quota_remaining: 9 }
      : { items: [question(11, { owner: { user_id: 7, display_name: "<b>A</b>", link: "https://attacker.example/users/7/evil" } })], has_more: false, quota_remaining: 10 });
    const result = await fetchStackExchangeSource({ entry, repository: fakeRepository(), signal: new AbortController().signal, now, request });
    expect(result.documents[0]?.text).toContain("Author: A");
    expect(result.documents[0]?.text).toContain("Author URL: unavailable");
    expect(calls.every(({ path }) => path.startsWith("/2.3/"))).toBe(true);
  });
});

type ApiPayload = { items: unknown[]; has_more: boolean; quota_remaining: number };
type RawResponse = { body: string | Uint8Array; contentType: string; statusCode?: number; contentLength?: string };

function responseRequest(
  calls: Array<{ path: string; headers: Record<string, string> }>,
  payload: (path: string) => ApiPayload,
): PublicHttpsRequest {
  return ((options, callback) => {
    const headers = (options.headers ?? {}) as Record<string, string>;
    const path = `${options.path}`;
    calls.push({ path, headers });
    const body = Readable.from([Buffer.from(JSON.stringify(payload(path)))]);
    Object.assign(body, {
      statusCode: 200,
      headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(JSON.stringify(payload(path)))) },
    });
    callback(body as never);
    return Object.assign(new EventEmitter(), { end() {} }) as never;
  }) as PublicHttpsRequest;
}

function rawResponseRequest(
  calls: Array<{ path: string; headers: Record<string, string> }>,
  response: (path: string) => RawResponse,
): PublicHttpsRequest {
  return ((options, callback) => {
    const headers = (options.headers ?? {}) as Record<string, string>;
    const path = `${options.path}`;
    calls.push({ path, headers });
    const spec = response(path);
    const source = typeof spec.body === "string" ? Buffer.from(spec.body) : Buffer.from(spec.body);
    const body = Readable.from([source]);
    Object.assign(body, {
      statusCode: spec.statusCode ?? 200,
      headers: { "content-type": spec.contentType, "content-length": spec.contentLength ?? String(source.byteLength) },
    });
    callback(body as never);
    return Object.assign(new EventEmitter(), { end() {} }) as never;
  }) as PublicHttpsRequest;
}

function exactJsonBody(value: Record<string, unknown>): string {
  const target = 8 * 1024 * 1024;
  let padding = "";
  for (;;) {
    const body = JSON.stringify({ ...value, padding });
    const difference = target - Buffer.byteLength(body);
    if (difference === 0) return body;
    if (difference > 0) padding += "x".repeat(difference);
    else padding = padding.slice(0, Math.max(0, padding.length + difference));
  }
}

function fakeRepository(state: StackExchangeFetchState | null = null) {
  return {
    ensureSource: vi.fn(async (_entry?: unknown, _options?: unknown) => undefined),
    getStackExchangeFetchState: vi.fn(async (_sourceId?: string, _options?: unknown) => state),
    compareAndSetStackExchangeFetchState: vi.fn(async (_sourceId?: string, _expected?: unknown, _next?: unknown, _options?: unknown) => true),
  };
}

function question(questionId: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    question_id: questionId,
    title: "Question",
    body: "<p>Body.</p>",
    creation_date: 1_700_000_000,
    last_activity_date: 1_700_000_001,
    content_license: "CC BY-SA 4.0",
    owner: null,
    ...overrides,
  };
}

function answer(answerId: number, questionId: number): Record<string, unknown> {
  return {
    answer_id: answerId,
    question_id: questionId,
    body: "<p>Answer.</p>",
    creation_date: 1_700_000_002,
    content_license: "CC BY-SA 4.0",
    owner: null,
  };
}

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 as const }];
