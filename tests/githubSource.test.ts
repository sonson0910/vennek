import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  fetchGithubSource,
  type GithubEndpoint,
  type GithubEndpointState,
  type GithubSourceInput,
  type KnowledgeRepository,
  type SourceRegistryEntry
} from "@vennek/cardano-agent";
import type { PublicHttpsRequest } from "@vennek/cardano-governance-skills";

const repositoryEntry: SourceRegistryEntry = {
  id: "github-test-repo",
  owner: "Test Org",
  trustTier: "official",
  kind: "github",
  url: "https://github.com/test-org/test-repo",
  allowedDomains: ["github.com", "raw.githubusercontent.com", "api.github.com"],
  github: { owner: "test-org", repository: "test-repo" },
  topics: ["developer"],
  networks: ["mainnet"],
  refresh: "daily"
};

const organizationEntry: SourceRegistryEntry = {
  ...repositoryEntry,
  id: "github-test-org",
  url: "https://github.com/test-org",
  github: { owner: "test-org" }
};

const now = new Date("2026-08-24T00:00:00.000Z");

describe("fixed GitHub source retrieval", () => {
  it("fetches an organization through exactly one fixed API endpoint", async () => {
    const calls: string[] = [];
    const request = responseRequest(calls, () => ({ payload: { login: "test-org" } }));
    const { repository } = fakeRepository();

    const result = await fetchGithubSource(input({ entry: organizationEntry, repository, request }));

    expect(calls).toEqual(["/orgs/test-org"]);
    expect(result.documents[0]).toMatchObject({
      endpoint: "organization",
      canonicalUrl: "https://github.com/test-org",
      title: "test-org GitHub organization",
      text: '{\n  "login": "test-org"\n}'
    });
  });

  it("fetches repository, README, releases, and tags in fixed order", async () => {
    const calls: string[] = [];
    const request = responseRequest(calls, (path) => path.endsWith("/readme")
      ? { payload: { encoding: "base64", content: "IyBUZXN0IFJlYWRtZQ==", html_url: "https://attacker.example/evil" } }
      : { payload: path.includes("releases") ? [] : path.includes("tags") ? [] : { name: "test-repo", html_url: "https://attacker.example/evil" } });
    const { repository } = fakeRepository();

    const result = await fetchGithubSource(input({ repository, request }));

    expect(calls).toEqual([
      "/repos/test-org/test-repo",
      "/repos/test-org/test-repo/readme",
      "/repos/test-org/test-repo/releases?per_page=100&page=1",
      "/repos/test-org/test-repo/tags?per_page=100&page=1"
    ]);
    expect(result.documents.map((document) => document.canonicalUrl)).toEqual([
      "https://github.com/test-org/test-repo",
      "https://github.com/test-org/test-repo#readme",
      "https://github.com/test-org/test-repo/releases",
      "https://github.com/test-org/test-repo/tags"
    ]);
    expect(result.documents[1]!.text).toBe("# Test Readme");
  });

  it("uses a safe ETag, treats 304 as unchanged, and discards stale CAS updates", async () => {
    const firstCalls: string[] = [];
    const firstRequest = responseRequest(firstCalls, (path) => ({
      payload: path.endsWith("/readme") ? { encoding: "base64", content: "IyBPSw==" } : { name: "test-repo" },
      headers: {
        etag: '"v1"',
        "x-ratelimit-remaining": "10",
        "x-ratelimit-reset": String(Math.floor(now.getTime() / 1000) + 120)
      }
    }));
    const fake = fakeRepository();
    await fetchGithubSource(input({ repository: fake.repository, request: firstRequest }));

    const secondCalls: string[] = [];
    const secondOptions: Array<Record<string, unknown>> = [];
    const secondRequest = responseRequest(secondCalls, () => ({
      statusCode: 304,
      payload: "",
      capture: secondOptions,
      headers: {
        etag: '"v2"',
        "x-ratelimit-remaining": "9",
        "x-ratelimit-reset": String(Math.floor(now.getTime() / 1000) + 180)
      }
    }));
    const second = await fetchGithubSource(input({ repository: fake.repository, request: secondRequest }));
    expect(second.unchanged).toBe(4);
    expect(second.documents).toHaveLength(0);
    expect(secondOptions[0]?.headers).toMatchObject({ "if-none-match": '"v1"' });
    expect(fake.states.get("repository")).toMatchObject({
      etag: '"v2"',
      rateLimitRemaining: 9,
      rateLimitResetAt: "2026-08-24T00:03:00.000Z"
    });

    fake.forceCasConflict = true;
    await fetchGithubSource(input({ entry: organizationEntry, repository: fake.repository, request: responseRequest([], () => ({ payload: {} })) }));
    expect(fake.repository.compareAndSetGithubEndpointStates).toHaveBeenCalled();
  });

  it("stops on rate limiting and defers without requesting later endpoints", async () => {
    const calls: string[] = [];
    const request = responseRequest(calls, () => ({
      statusCode: 429,
      payload: { message: "rate limited" },
      headers: { "retry-after": "60", "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(now.getTime() / 1000) + 120) }
    }));
    const fake = fakeRepository();
    const result = await fetchGithubSource(input({ repository: fake.repository, request }));
    expect(calls).toHaveLength(1);
    expect(result.deferredUntil).toEqual(new Date("2026-08-24T00:02:00.000Z"));
    expect((fake.states.get("repository") as GithubEndpointState).retryAt).toBe(result.deferredUntil?.toISOString());

    const noRequest = vi.fn() as unknown as PublicHttpsRequest;
    const deferred = await fetchGithubSource(input({ repository: fake.repository, request: noRequest }));
    expect(deferred.deferredUntil).toEqual(result.deferredUntil);
    expect(noRequest).not.toHaveBeenCalled();
  });

  it("treats a reset header alone as an ordinary HTTP 403", async () => {
    const canceled: boolean[] = [];
    const calls: string[] = [];
    const request = responseRequest(calls, () => ({
      statusCode: 403,
      payload: { message: "forbidden" },
      canceled,
      headers: {
        "x-ratelimit-remaining": "10",
        "x-ratelimit-reset": String(Math.floor(now.getTime() / 1_000) + 120)
      }
    }));
    const fake = fakeRepository();

    await expect(fetchGithubSource(input({ repository: fake.repository, request }))).rejects.toThrow(/HTTP 403/);
    expect(calls).toHaveLength(1);
    expect(canceled[0]).toBe(true);
  });

  it("does not expose staged documents or state when rate limiting interrupts a batch", async () => {
    const calls: string[] = [];
    const fake = fakeRepository();
    const request = responseRequest(calls, (path): { statusCode?: number; payload: unknown; headers?: Record<string, string> } => {
      if (path.endsWith("/readme")) return {
        statusCode: 429,
        payload: { message: "rate limited" },
        headers: { "retry-after": "60" }
      };
      return { payload: { name: "test-repo" }, headers: { etag: '"repo-v1"' } };
    });

    const result = await fetchGithubSource(input({ repository: fake.repository, request }));

    expect(calls).toEqual(["/repos/test-org/test-repo", "/repos/test-org/test-repo/readme"]);
    expect(result.documents).toHaveLength(0);
    expect(result.unchanged).toBe(0);
    expect(result.deferredUntil).toEqual(new Date("2026-08-24T00:01:00.000Z"));
    expect(fake.states.get("repository")).toBeUndefined();
    expect(fake.states.get("readme")).toMatchObject({ retryAt: result.deferredUntil?.toISOString() });
    expect(fake.repository.compareAndSetGithubEndpointStates).not.toHaveBeenCalled();
  });

  it("reloads a future retry state when a limiting endpoint CAS loses", async () => {
    const fake = fakeRepository();
    fake.repository.compareAndSetGithubEndpointState = vi.fn(async () => {
      fake.states.set("repository", { retryAt: "2026-08-24T00:05:00.000Z" });
      return false;
    });
    const request = responseRequest([], () => ({ statusCode: 429, payload: {} }));

    const result = await fetchGithubSource(input({ repository: fake.repository, request }));

    expect(result).toEqual({ documents: [], unchanged: 0, deferredUntil: new Date("2026-08-24T00:05:00.000Z") });
  });

  it("does not persist an earlier ETag when a later README extraction fails", async () => {
    const fake = fakeRepository();
    const first = responseRequest([], (path) => path.endsWith("/readme")
      ? { payload: { encoding: "base64", content: "%%%" }, headers: { etag: '"readme-v1"' } }
      : { payload: { name: "test-repo" }, headers: { etag: '"repo-v1"' } });

    await expect(fetchGithubSource(input({ repository: fake.repository, request: first }))).rejects.toThrow(/base64/i);
    expect(fake.states.size).toBe(0);

    const captures: Array<Record<string, unknown>> = [];
    const second = responseRequest([], (path) => ({
      payload: path.endsWith("/readme") ? { encoding: "base64", content: "IyBPSw==" } : { name: "test-repo" },
      capture: captures
    }));
    await fetchGithubSource(input({ repository: fake.repository, request: second }));
    expect(captures[0]?.headers).not.toHaveProperty("if-none-match");
  });

  it("clamps malicious retry headers and stored deferrals to 24 hours", async () => {
    const calls: string[] = [];
    const request = responseRequest(calls, () => ({
      statusCode: 429,
      payload: {},
      headers: { "retry-after": "9007199254740991", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "9007199254740991" }
    }));
    const fake = fakeRepository();
    const result = await fetchGithubSource(input({ repository: fake.repository, request }));
    const expected = new Date(now.getTime() + 24 * 60 * 60 * 1_000);
    expect(result.deferredUntil).toEqual(expected);

    fake.states.set("repository", { retryAt: "2099-01-01T00:00:00.000Z" });
    const noRequest = vi.fn() as unknown as PublicHttpsRequest;
    const stored = await fetchGithubSource(input({ repository: fake.repository, request: noRequest }));
    expect(stored.deferredUntil).toEqual(expected);
    expect(noRequest).not.toHaveBeenCalled();
  });

  it("rejects a README whose decoded body exceeds its independent bound", async () => {
    const oversized = Buffer.alloc(4 * 1024 * 1024 + 1, 97).toString("base64");
    const request = responseRequest([], (path) => path.endsWith("/readme")
      ? { payload: { encoding: "base64", content: oversized } }
      : { payload: {} });
    await expect(fetchGithubSource(input({ repository: fakeRepository().repository, request }))).rejects.toThrow(/base64/i);
  });

  it("rejects invalid README base64, redirects, and private DNS before request", async () => {
    const invalidReadme = responseRequest([], (path) => path.endsWith("/readme")
      ? { payload: { encoding: "base64", content: "%%%" } }
      : { payload: {} });
    await expect(fetchGithubSource(input({ repository: fakeRepository().repository, request: invalidReadme }))).rejects.toThrow(/base64/i);

    const canceled: boolean[] = [];
    const redirect = responseRequest([], () => ({ statusCode: 302, payload: {}, canceled }));
    await expect(fetchGithubSource(input({ repository: fakeRepository().repository, request: redirect }))).rejects.toThrow(/HTTP 302/);
    expect(canceled[0]).toBe(true);

    const privateLookup = async () => [{ address: "127.0.0.1", family: 4 as const }];
    const request = vi.fn() as unknown as PublicHttpsRequest;
    await expect(fetchGithubSource(input({ repository: fakeRepository().repository, request, lookup: privateLookup }))).rejects.toThrow(/Private/i);
    expect(request).not.toHaveBeenCalled();
  });

  it("uses a derived per-endpoint deadline signal and cancels an in-flight body on caller abort", async () => {
    const controller = new AbortController();
    const endpointSignals: AbortSignal[] = [];
    const canceled: boolean[] = [];
    const request = ((options, callback) => {
      endpointSignals.push(options.signal as AbortSignal);
      const body = Readable.from((async function* () {
        try {
          await new Promise((resolve) => setTimeout(resolve, 500));
          yield Buffer.from("{}");
        } finally {
          canceled.push(true);
        }
      })());
      Object.assign(body, {
        statusCode: 200,
        headers: { "content-type": "application/json", "content-length": "2" }
      });
      const originalDestroy = body.destroy.bind(body);
      body.destroy = ((error?: Error) => originalDestroy(error)) as typeof body.destroy;
      callback(body as never);
      return Object.assign(new EventEmitter(), { end() {} }) as never;
    }) as PublicHttpsRequest;

    const startedAt = Date.now();
    const pending = fetchGithubSource(input({ signal: controller.signal, request }));
    setTimeout(() => controller.abort(), 20);

    await expect(pending).rejects.toThrow();
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(endpointSignals[0]).toBeDefined();
    expect(endpointSignals[0]).not.toBe(controller.signal);
    expect(endpointSignals[0]?.aborted).toBe(true);
    expect(canceled.length).toBeGreaterThan(0);
  });

  it("rejects a registry entry whose GitHub tenant or repository scope was altered", async () => {
    const attacker = {
      ...repositoryEntry,
      github: { owner: "attacker", repository: "evil-repo" }
    } as SourceRegistryEntry;
    const request = vi.fn() as unknown as PublicHttpsRequest;
    await expect(fetchGithubSource(input({ entry: attacker, request }))).rejects.toThrow(/scope|source entry/i);
    expect(request).not.toHaveBeenCalled();
  });
});

function input(overrides: Partial<GithubSourceInput> = {}): GithubSourceInput {
  return {
    entry: repositoryEntry,
    repository: fakeRepository().repository,
    signal: new AbortController().signal,
    now,
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    request: responseRequest([], () => ({ payload: {} })),
    ...overrides
  };
}

function fakeRepository(): {
  repository: KnowledgeRepository;
  states: Map<GithubEndpoint, GithubEndpointState | null>;
  forceCasConflict: boolean;
} {
  const states = new Map<GithubEndpoint, GithubEndpointState | null>();
  const fake = {
    forceCasConflict: false,
    states,
    repository: undefined as unknown as KnowledgeRepository
  };
  fake.repository = {
    ensureSource: vi.fn(async () => undefined),
    getGithubEndpointState: vi.fn(async (_sourceId: string, endpoint: GithubEndpoint) => states.get(endpoint) ?? null),
    compareAndSetGithubEndpointState: vi.fn(async (_sourceId: string, endpoint: GithubEndpoint, expected: GithubEndpointState | null, next: GithubEndpointState | null) => {
      if (fake.forceCasConflict) return false;
      const current = states.get(endpoint) ?? null;
      if (JSON.stringify(current) !== JSON.stringify(expected)) return false;
      states.set(endpoint, next);
      return true;
    }),
    compareAndSetGithubEndpointStates: vi.fn(async (updates: Array<{ endpoint: GithubEndpoint; expectedState: GithubEndpointState | null; nextState: GithubEndpointState | null }>) => {
      if (fake.forceCasConflict) return false;
      for (const update of updates) {
        const current = states.get(update.endpoint) ?? null;
        if (JSON.stringify(current) !== JSON.stringify(update.expectedState)) return false;
      }
      for (const update of updates) states.set(update.endpoint, update.nextState);
      return true;
    })
  } as unknown as KnowledgeRepository;
  return fake;
}

function responseRequest(
  calls: string[],
  responseFor: (path: string) => { statusCode?: number; payload: unknown; headers?: Record<string, string>; capture?: Array<Record<string, unknown>>; canceled?: boolean[] }
): PublicHttpsRequest {
  return ((options, callback) => {
    const path = String(options.path);
    calls.push(path);
    const spec = responseFor(path);
    spec.capture?.push(options as Record<string, unknown>);
    const raw = typeof spec.payload === "string" ? spec.payload : JSON.stringify(spec.payload);
    const body = Object.assign(Readable.from([raw]), {
      statusCode: spec.statusCode ?? 200,
      headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(raw)), ...spec.headers }
    });
    const originalDestroy = body.destroy.bind(body);
    body.destroy = ((error?: Error) => {
      if (spec.canceled) spec.canceled.push(true);
      return originalDestroy(error);
    }) as typeof body.destroy;
    callback(body as never);
    return Object.assign(new EventEmitter(), { end() {} }) as never;
  }) as PublicHttpsRequest;
}
