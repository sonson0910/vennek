import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  checkLive,
  liveValidationSucceeded,
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

  it("uses one source deadline across HEAD and GET fallback and aggregates failures", async () => {
    const calls: string[] = [];
    const request = async (input: { method?: string; signal: AbortSignal }) => {
      calls.push(input.method ?? "GET");
      expect(input.signal).toBeInstanceOf(AbortSignal);
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
    expect(calls).toEqual(["HEAD", "GET"]);
    expect(JSON.stringify(official)).toBe(before);

    const failingRequest = async () => ({
      url: official.url,
      statusCode: 503,
      headers: { "content-type": "text/plain" },
      body: {} as never,
      cancel: () => undefined
    });
    const results = await runLiveValidation([official, { ...official, id: "second-source" }], {
      request: failingRequest,
      sourceTimeoutMs: 100,
      overallTimeoutMs: 1_000
    });
    expect(results).toHaveLength(2);
    expect(results.every((result) => !result.ok)).toBe(true);
    expect(liveValidationSucceeded(results)).toBe(false);
  });
});
