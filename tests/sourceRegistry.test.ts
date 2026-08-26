import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  checkLive,
  liveValidationSucceeded,
  readSourceConfig,
  runLiveValidation,
  validateRequiredRefreshPolicies,
  validateSourceConfig
} from "../scripts/validate-source-registry";
import {
  REQUIRED_OFFICIAL_SOURCE_IDS,
  sourceIsScheduled,
  validateSourceRegistryEnvelope,
  urlMatchesSourceScope,
  validateSourceRegistry,
  type SourceRegistryEntry
} from "@vennek/cardano-agent";

const official: SourceRegistryEntry = {
  id: "cardano-docs",
  owner: "Cardano",
  trustTier: "official",
  kind: "sitemap",
  url: "https://docs.cardano.org/sitemap.xml",
  allowedDomains: ["docs.cardano.org"],
  topics: ["fundamentals", "developer", "staking"],
  networks: ["mainnet", "preprod", "preview"],
  refresh: "daily"
};

const checkedInEntries = validateSourceConfig(readSourceConfig());
const cardanoFoundation = checkedInEntries.find((entry) => entry.id === "cardano-foundation")!;
const cardanoFoundationGithub = checkedInEntries.find((entry) => entry.id === "cardano-foundation-github")!;
const cardanoStackExchange = checkedInEntries.find((entry) => entry.id === "cardano-stack-exchange")!;

function response(url: string, statusCode = 200, contentType = "text/plain") {
  return { url, statusCode, headers: { "content-type": contentType }, body: {} as never, cancel: () => undefined };
}

describe("Cardano source registry", () => {
  it("validates the exact tiered registry envelope before flattening", () => {
    expect(validateSourceRegistryEnvelope({ official: [official], community: [] })).toMatchObject({ official: [official], community: [] });
    expect(() => validateSourceRegistryEnvelope({ official: [official], community: [], extra: [] })).toThrow(/only official/i);
    expect(() => validateSourceRegistryEnvelope({ official: [{ ...official, trustTier: "community" }], community: [] })).toThrow(/official/i);
  });

  it("accepts a bounded official source without normalizing it", () => {
    expect(validateSourceRegistry([official])).toEqual([official]);
  });

  it("rejects duplicate ids and non-HTTPS sources", () => {
    expect(() => validateSourceRegistry([official, official])).toThrow(/duplicate/i);
    expect(() => validateSourceRegistry([{ ...official, url: "http://docs.cardano.org" }])).toThrow(/https/i);
  });

  it("validates monitor-only official fallbacks and scheduling metadata", () => {
    const fallback: SourceRegistryEntry = { ...official, id: "official-fallback", ingestionMode: "scheduled" };
    const monitor: SourceRegistryEntry = {
      ...official,
      id: "official-monitor",
      ingestionMode: "monitor-only",
      liveFallbackIds: [fallback.id]
    };
    expect(validateSourceRegistry([monitor, fallback])).toMatchObject([
      { id: monitor.id, ingestionMode: "monitor-only", liveFallbackIds: [fallback.id] },
      { id: fallback.id, ingestionMode: "scheduled" }
    ]);
    expect(sourceIsScheduled(monitor)).toBe(false);
    expect(sourceIsScheduled(fallback)).toBe(true);

    expect(() => validateSourceRegistry([{ ...official, ingestionMode: "on-demand" }])).toThrow(/ingestionMode/i);
    expect(() => validateSourceRegistry([{ ...monitor, liveFallbackIds: ["missing-source"] }])).toThrow(/fallback.*missing|does not exist/i);
    expect(() => validateSourceRegistry([{ ...monitor, liveFallbackIds: [monitor.id] }, fallback])).toThrow(/self/i);
    expect(() => validateSourceRegistry([
      { ...monitor, liveFallbackIds: ["community-fallback"] },
      { ...fallback, id: "community-fallback", trustTier: "community" }
    ])).toThrow(/official/i);
    expect(() => validateSourceRegistry([
      { ...monitor, liveFallbackIds: ["monitor-fallback"] },
      { ...fallback, id: "monitor-fallback", ingestionMode: "monitor-only" }
    ])).toThrow(/scheduled/i);
    expect(() => validateSourceRegistry([
      { ...monitor, liveFallbackIds: ["other-owner"] },
      { ...fallback, id: "other-owner", owner: "Other Owner" }
    ])).toThrow(/owner/i);
    expect(() => validateSourceRegistry([
      { ...monitor, liveFallbackIds: Array.from({ length: 17 }, (_, index) => `fallback-${index}`) },
      ...Array.from({ length: 17 }, (_, index) => ({ ...fallback, id: `fallback-${index}` }))
    ])).toThrow(/maximum length|16/i);
    expect(() => validateSourceRegistry([
      { ...monitor, liveFallbackIds: ["fallback-one"] },
      { ...fallback, id: "fallback-one", liveFallbackIds: ["fallback-two"], ingestionMode: "monitor-only" },
      { ...fallback, id: "fallback-two" }
    ])).toThrow(/scheduled|fallback/i);
  });

  it("rejects invalid fallback lists", () => {
    const monitor: SourceRegistryEntry = { ...official, id: "official-monitor", ingestionMode: "monitor-only" };
    expect(() => validateSourceRegistry([{ ...monitor, liveFallbackIds: [] }])).toThrow(/non-empty/i);
    expect(() => validateSourceRegistry([{ ...monitor, liveFallbackIds: ["bad_ID"] }])).toThrow(/lowercase hyphenated/i);
    expect(() => validateSourceRegistry([{ ...monitor, liveFallbackIds: ["fallback", "fallback"] }])).toThrow(/duplicate/i);
    expect(() => validateSourceRegistry([{ ...official, liveFallbackIds: ["official-monitor"] }, monitor])).toThrow(/official.*monitor-only|monitor-only.*official/i);
  });

  it("requires every URL host to be in allowedDomains", () => {
    expect(() => validateSourceRegistry([{ ...official, allowedDomains: ["example.com"] }])).toThrow(/allowed domain/i);
  });

  it("rejects unknown fields, credentials, and IP literals", () => {
    expect(() => validateSourceRegistry([{ ...official, unexpected: true }])).toThrow(/unknown field/i);
    expect(() => validateSourceRegistry([{ ...official, url: "https://user:pass@docs.cardano.org" }])).toThrow(/credential/i);
    expect(() => validateSourceRegistry([{ ...official, url: "https://127.0.0.1" }])).toThrow(/ip literal/i);
    expect(() => validateSourceRegistry([{ ...official, allowedDomains: ["127.0.0.1"] }])).toThrow(/ip literal/i);
    expect(() => validateSourceRegistry([{ ...official, allowedDomains: ["127.0.0.01"] }])).toThrow(/ip literal/i);
  });

  it("enforces explicit GitHub owner and repository scopes", () => {
    const org = {
      ...official,
      id: "iog-github",
      kind: "github" as const,
      url: "https://github.com/input-output-hk",
      allowedDomains: ["github.com", "raw.githubusercontent.com", "api.github.com"],
      github: { owner: "input-output-hk" }
    };
    const repo = {
      ...org,
      id: "cardano-cips",
      url: "https://github.com/cardano-foundation/CIPs",
      github: { owner: "cardano-foundation", repository: "CIPs" }
    };
    expect(validateSourceRegistry([org, repo])).toHaveLength(2);
    expect(urlMatchesSourceScope("https://github.com/input-output-hk/cardano-node", org)).toBe(true);
    expect(urlMatchesSourceScope("https://raw.githubusercontent.com/input-output-hk/cardano-node/main/README.md", org)).toBe(true);
    expect(urlMatchesSourceScope("https://api.github.com/repos/input-output-hk/cardano-node/releases", org)).toBe(true);
    expect(urlMatchesSourceScope("https://github.com/cardano-foundation/CIPs/pull/1", repo)).toBe(true);
    expect(urlMatchesSourceScope("https://raw.githubusercontent.com/cardano-foundation/CIPs/main/README.md", repo)).toBe(true);
    expect(urlMatchesSourceScope("https://api.github.com/repos/cardano-foundation/CIPs/releases", repo)).toBe(true);
    expect(urlMatchesSourceScope("https://api.github.com/orgs/cardano-foundation/repos", repo)).toBe(false);
    expect(urlMatchesSourceScope("https://github.com/attacker/cardano-node", org)).toBe(false);
    expect(urlMatchesSourceScope("https://github.com/input-output-hk-evil/cardano-node", org)).toBe(false);
    expect(urlMatchesSourceScope("https://github.com/cardano-foundation/CIPs-evil", repo)).toBe(false);
    expect(urlMatchesSourceScope("https://github.com/cardano-foundation%2FCIPs", repo)).toBe(false);
    expect(urlMatchesSourceScope("https://github.com/cardano-foundation\\CIPs", repo)).toBe(false);
    expect(urlMatchesSourceScope("https://evil.github.com/input-output-hk/cardano-node", org)).toBe(false);
  });

  it("validates the fixed Cardano Stack Exchange source tuple", () => {
    const stackExchange: SourceRegistryEntry = {
      id: "cardano-stack-exchange",
      owner: "Cardano Stack Exchange",
      trustTier: "community",
      kind: "stackexchange",
      url: "https://api.stackexchange.com/2.3/questions",
      allowedDomains: ["api.stackexchange.com", "cardano.stackexchange.com"],
      stackExchange: { site: "cardano" },
      topics: ["community", "developer", "fundamentals"],
      networks: ["mainnet", "preprod", "preview"],
      refresh: "daily"
    };
    expect(validateSourceRegistry([stackExchange])).toEqual([stackExchange]);
    expect(validateSourceRegistry([{ ...stackExchange, allowedDomains: [...stackExchange.allowedDomains].reverse() }])).toMatchObject([
      { allowedDomains: ["cardano.stackexchange.com", "api.stackexchange.com"] }
    ]);
    const inheritedSite = Object.create({ site: "cardano" }) as Record<string, unknown>;
    expect(() => validateSourceRegistry([{ ...stackExchange, stackExchange: inheritedSite }])).toThrow(/site|metadata/i);
    const validated = validateSourceRegistry([stackExchange]);
    expect(validated[0]?.stackExchange).not.toBe(stackExchange.stackExchange);
    expect(() => validateSourceRegistry([{ ...stackExchange, url: "https://api.stackexchange.com/2.3/questions/" }])).toThrow(/stack exchange.*url|exact/i);
    expect(() => validateSourceRegistry([{ ...stackExchange, allowedDomains: ["cardano.stackexchange.com"] }])).toThrow(/stack exchange.*domain|exact/i);
    expect(() => validateSourceRegistry([{ ...stackExchange, allowedDomains: ["api.stackexchange.com", "cardano.stackexchange.com", "example.com"] }])).toThrow(/stack exchange.*domain|exact/i);
    expect(() => validateSourceRegistry([{ ...stackExchange, stackExchange: { site: "ethereum" } }])).toThrow(/site|cardano/i);
    expect(() => validateSourceRegistry([{ ...stackExchange, stackExchange: { site: "cardano", extra: true } }])).toThrow(/unknown|metadata/i);
  });

  it("requires strict GitHub metadata and repository scope fields", () => {
    const base = {
      ...official,
      id: "github-source",
      kind: "github" as const,
      url: "https://github.com/example-org/example-repo",
      allowedDomains: ["github.com"],
      github: { owner: "example-org", repository: "example-repo" }
    };
    expect(() => validateSourceRegistry([{ ...base, github: undefined }])).toThrow(/github metadata/i);
    expect(() => validateSourceRegistry([{ ...base, github: { owner: "example-org", unexpected: true } }])).toThrow(/unknown field/i);
    expect(() => validateSourceRegistry([{ ...base, kind: "page", github: base.github }])).toThrow(/only valid/i);
    expect(() => validateSourceRegistry([{ ...base, github: { owner: "example-org" } }])).toThrow(/repository is required/i);
  });

  it("rejects empty arrays and invalid enum values", () => {
    expect(() => validateSourceRegistry([])).toThrow(/non-empty/i);
    expect(() => validateSourceRegistry([{ ...official, allowedDomains: [] }])).toThrow(/non-empty/i);
    expect(() => validateSourceRegistry([{ ...official, topics: [] }])).toThrow(/non-empty/i);
    expect(() => validateSourceRegistry([{ ...official, networks: [] }])).toThrow(/non-empty/i);
    expect(() => validateSourceRegistry([{ ...official, trustTier: "trusted" }])).toThrow(/trustTier/i);
    expect(() => validateSourceRegistry([{ ...official, kind: "blog" }])).toThrow(/kind/i);
    expect(() => validateSourceRegistry([{ ...official, kind: "feed" }])).toThrow(/kind/i);
    expect(() => validateSourceRegistry([{ ...official, refresh: "weekly" }])).toThrow(/refresh/i);
  });

  it("rejects malformed or duplicate domains, topics, and networks", () => {
    expect(() => validateSourceRegistry([{ ...official, allowedDomains: ["docs.cardano.org", "docs.cardano.org"] }])).toThrow(/duplicate domain/i);
    expect(() => validateSourceRegistry([{ ...official, allowedDomains: ["https://docs.cardano.org"] }])).toThrow(/domain/i);
    expect(() => validateSourceRegistry([{ ...official, topics: ["developer", "developer"] }])).toThrow(/duplicate topic/i);
    expect(() => validateSourceRegistry([{ ...official, networks: ["mainnet", "mainnet"] }])).toThrow(/duplicate network/i);
  });

  it("covers every required official family and keeps config sections tiered", () => {
    const config = JSON.parse(readFileSync(new URL("../config/cardano-sources.json", import.meta.url), "utf8")) as {
      official: SourceRegistryEntry[];
      community: SourceRegistryEntry[];
    };
    expect(Object.keys(config).sort()).toEqual(["community", "official"]);
    expect(config.official.every((entry) => entry.trustTier === "official")).toBe(true);
    expect(config.community.every((entry) => entry.trustTier === "community")).toBe(true);
    const ids = new Set(config.official.map((entry) => entry.id));
    expect(REQUIRED_OFFICIAL_SOURCE_IDS).toContain("cardano-org");
    expect(REQUIRED_OFFICIAL_SOURCE_IDS.every((id) => ids.has(id))).toBe(true);
    expect(config.official.find((entry) => entry.id === "cardano-foundation")?.url).toBe("https://cardanofoundation.org/");
    expect(config.official.find((entry) => entry.id === "cardano-foundation")).toMatchObject({
      ingestionMode: "monitor-only",
      liveFallbackIds: ["cardano-foundation-github"]
    });
    expect(config.official.find((entry) => entry.id === "cardano-foundation-github")).toMatchObject({
      trustTier: "official",
      ingestionMode: "scheduled"
    });
    expect(config.community.find((entry) => entry.id === "cardano-stack-exchange")).toMatchObject({
      kind: "stackexchange",
      url: "https://api.stackexchange.com/2.3/questions",
      allowedDomains: ["api.stackexchange.com", "cardano.stackexchange.com"],
      stackExchange: { site: "cardano" }
    });
    expect(config.community.length).toBeGreaterThanOrEqual(2);
    expect(validateSourceRegistry([...config.official, ...config.community])).toHaveLength(
      config.official.length + config.community.length
    );
  });

  it("enforces the required refresh policy table", () => {
    const config = JSON.parse(readFileSync(new URL("../config/cardano-sources.json", import.meta.url), "utf8")) as {
      official: SourceRegistryEntry[];
      community: SourceRegistryEntry[];
    };
    const entries = validateSourceConfig(config);
    expect(() => validateRequiredRefreshPolicies(entries.map((entry) => entry.id === "intersect" ? { ...entry, refresh: "daily" } : entry))).toThrow(/intersect.*hourly/i);
    expect(() => validateRequiredRefreshPolicies(entries.filter((entry) => entry.id !== "cardano-org"))).toThrow(/cardano-org.*missing/i);
  });

  it("uses one source deadline across HEAD and GET fallback", async () => {
    const calls: Array<{ method?: string; headers?: Record<string, string>; signal: AbortSignal }> = [];
    const request = async (input: { method?: string; headers?: Record<string, string>; signal: AbortSignal }) => {
      calls.push(input);
      return {
        url: official.url,
        statusCode: input.method === "HEAD" ? 405 : 200,
        headers: { "content-type": "text/plain" },
        body: {} as never,
        cancel: () => undefined
      };
    };
    const signal = new AbortController().signal;
    const before = JSON.stringify(official);
    await expect(checkLive(official, signal, request)).resolves.toBeUndefined();
    expect(calls.map((call) => call.method)).toEqual(["HEAD", "GET"]);
    expect(calls[1]?.headers).toEqual({ Range: "bytes=0-0" });
    expect(calls[0]?.signal).toBe(calls[1]?.signal);
    expect(JSON.stringify(official)).toBe(before);
  });

  it("fails a hanging ordinary range GET at its source deadline", async () => {
    const results = await runLiveValidation([official], {
      sourceTimeoutMs: 20,
      overallTimeoutMs: 1_000,
      request: async (input) => input.method === "HEAD"
        ? response(input.url, 405)
        : await new Promise<never>((_resolve, reject) => input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true }))
    });
    expect(results[0]).toEqual(expect.objectContaining({ status: "failed", reason: expect.stringMatching(/timeout/) }));
  });

  it("fails a hanging probe at the overall deadline", async () => {
    const results = await runLiveValidation([official], {
      sourceTimeoutMs: 1_000,
      overallTimeoutMs: 20,
      request: async (input) => await new Promise<never>((_resolve, reject) => input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true }))
    });
    expect(results[0]).toEqual(expect.objectContaining({ status: "failed", reason: expect.stringMatching(/timeout/) }));
  });

  it("resolves a rate-limited Cardano Foundation primary through its healthy declared fallback", async () => {
    const calls: string[] = [];
    const results = await runLiveValidation([cardanoFoundation, cardanoFoundationGithub], {
      request: async (input) => {
        calls.push(`${input.method}:${input.url}`);
        return input.url === cardanoFoundation.url ? response(input.url, 429) : response(input.url);
      }
    });
    expect(results).toEqual([
      expect.objectContaining({ id: "cardano-foundation", status: "degraded-with-fallback", fallbackId: "cardano-foundation-github", blocking: true, reason: expect.stringMatching(/429/) }),
      expect.objectContaining({ id: "cardano-foundation-github", status: "healthy", blocking: true })
    ]);
    expect(calls).toHaveLength(3);
    expect(calls).toEqual(expect.arrayContaining([
      `HEAD:${cardanoFoundation.url}`, `GET:${cardanoFoundation.url}`,
      `HEAD:${cardanoFoundationGithub.url}`
    ]));
    expect(liveValidationSucceeded(results)).toBe(true);
  });

  it("fails a required family when both the primary and its fallback fail", async () => {
    const results = await runLiveValidation([cardanoFoundation, cardanoFoundationGithub], {
      request: async (input) => response(input.url, 503)
    });
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "cardano-foundation", status: "failed", blocking: true }),
      expect.objectContaining({ id: "cardano-foundation-github", status: "failed", blocking: true })
    ]));
    expect(liveValidationSucceeded(results)).toBe(false);
  });

  it("keeps a failed community Stack Exchange probe visible but nonblocking", async () => {
    const results = await runLiveValidation([cardanoFoundationGithub, cardanoStackExchange], {
      request: async (input) => response(input.url, input.url.includes("stackexchange") ? 503 : 200)
    });
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "cardano-foundation-github", status: "healthy", blocking: true }),
      expect.objectContaining({ id: "cardano-stack-exchange", status: "failed", blocking: false })
    ]));
    expect(liveValidationSucceeded(results)).toBe(true);
  });

  it("probes Stack Exchange once with its fixed hardened API query", async () => {
    const calls: Array<{ url: string; method?: string; allowedDomains: string[]; headers?: Record<string, string> }> = [];
    await expect(checkLive({ ...cardanoStackExchange, url: "https://evil.example/query?site=evil" }, undefined, async (input) => {
      calls.push({ url: input.url, method: input.method, allowedDomains: input.allowedDomains, headers: input.headers });
      return response(input.url, 200, "application/json; charset=utf-8");
    })).resolves.toBeUndefined();
    expect(calls).toEqual([{
      url: "https://api.stackexchange.com/2.3/questions?filter=default&pagesize=1&site=cardano",
      method: "GET",
      allowedDomains: ["api.stackexchange.com"],
      headers: { "user-agent": "vennek-source-registry/1.0" }
    }]);
  });

  it("rejects an HTML Stack Exchange success response", async () => {
    const results = await runLiveValidation([cardanoStackExchange], {
      request: async (input) => response(input.url, 200, "text/html; charset=utf-8")
    });
    expect(results[0]).toEqual(expect.objectContaining({ status: "failed", blocking: false, reason: "unsupported content type" }));
  });

  it("uses only the first raw-healthy declared fallback", async () => {
    const entries = validateSourceRegistry([
      { ...official, id: "family-primary", ingestionMode: "monitor-only", liveFallbackIds: ["first-fallback", "second-fallback"] },
      { ...official, id: "first-fallback", url: "https://docs.cardano.org/first", ingestionMode: "scheduled" },
      { ...official, id: "second-fallback", url: "https://docs.cardano.org/second", ingestionMode: "scheduled" }
    ]);
    const results = await runLiveValidation(entries, {
      request: async (input) => response(input.url, input.url.endsWith("/second") ? 200 : 503)
    });
    expect(results.find((result) => result.id === "family-primary")).toMatchObject({ status: "degraded-with-fallback", fallbackId: "second-fallback" });
  });

  it("does not treat an omitted fallback probe as healthy", async () => {
    const primary = { ...cardanoFoundation, liveFallbackIds: ["omitted-fallback"] };
    const results = await runLiveValidation([primary], { request: async (input) => response(input.url, 503) });
    expect(results[0]).toEqual(expect.objectContaining({ id: primary.id, status: "failed", blocking: true }));
    expect(results[0]?.fallbackId).toBeUndefined();
    expect(liveValidationSucceeded(results)).toBe(false);
  });

  it("fails empty results and never exposes response bodies or URLs in safe state", async () => {
    const results = await runLiveValidation([official], {
      request: async () => { throw new Error("https://secret.example/path response body: private"); }
    });
    expect(liveValidationSucceeded([])).toBe(false);
    expect(results[0]).toEqual(expect.objectContaining({ status: "failed", reason: expect.stringMatching(/HTTPS is required/) }));
    expect(JSON.stringify(results)).not.toMatch(/secret|private|https:/i);
  });
});
