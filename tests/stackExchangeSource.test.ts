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
      "/2.3/questions/11/answers?order=desc&sort=activity&pagesize=100&filter=withbody&site=cardano",
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

function fakeRepository(state: StackExchangeFetchState | null = null) {
  return {
    ensureSource: vi.fn(async () => undefined),
    getStackExchangeFetchState: vi.fn(async () => state),
    compareAndSetStackExchangeFetchState: vi.fn(async () => true),
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

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 as const }];
