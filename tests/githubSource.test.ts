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
    expect(result.documents[0]).toMatchObject({ endpoint: "organization", canonicalUrl: "https://github.com/test-org", mime: "application/json" });
    expect(JSON.parse(new TextDecoder().decode(result.documents[0]!.bytes))).toEqual({ login: "test-org" });
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
    expect(new TextDecoder().decode(result.documents[1]!.bytes)).toBe("# Test Readme");
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
    expect(fake.repository.compareAndSetGithubEndpointState).toHaveBeenCalled();
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
