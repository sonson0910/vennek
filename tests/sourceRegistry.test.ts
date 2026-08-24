import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  REQUIRED_OFFICIAL_SOURCE_IDS,
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
  it("accepts a bounded official source without normalizing it", () => {
    expect(validateSourceRegistry([official])).toEqual([official]);
  });

  it("rejects duplicate ids and non-HTTPS sources", () => {
    expect(() => validateSourceRegistry([official, official])).toThrow(/duplicate/i);
    expect(() => validateSourceRegistry([{ ...official, url: "http://docs.cardano.org" }])).toThrow(/https/i);
  });

  it("requires every URL host to be in allowedDomains", () => {
    expect(() => validateSourceRegistry([{ ...official, allowedDomains: ["example.com"] }])).toThrow(/allowed domain/i);
  });

  it("rejects unknown fields, credentials, and IP literals", () => {
    expect(() => validateSourceRegistry([{ ...official, unexpected: true }])).toThrow(/unknown field/i);
    expect(() => validateSourceRegistry([{ ...official, url: "https://user:pass@docs.cardano.org" }])).toThrow(/credential/i);
    expect(() => validateSourceRegistry([{ ...official, url: "https://127.0.0.1" }])).toThrow(/ip literal/i);
    expect(() => validateSourceRegistry([{ ...official, allowedDomains: ["127.0.0.1"] }])).toThrow(/ip literal/i);
  });

  it("rejects empty arrays and invalid enum values", () => {
    expect(() => validateSourceRegistry([])).toThrow(/non-empty/i);
    expect(() => validateSourceRegistry([{ ...official, allowedDomains: [] }])).toThrow(/non-empty/i);
    expect(() => validateSourceRegistry([{ ...official, topics: [] }])).toThrow(/non-empty/i);
    expect(() => validateSourceRegistry([{ ...official, networks: [] }])).toThrow(/non-empty/i);
    expect(() => validateSourceRegistry([{ ...official, trustTier: "trusted" }])).toThrow(/trustTier/i);
    expect(() => validateSourceRegistry([{ ...official, kind: "blog" }])).toThrow(/kind/i);
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
    expect(REQUIRED_OFFICIAL_SOURCE_IDS.every((id) => ids.has(id))).toBe(true);
    expect(config.community.length).toBeGreaterThanOrEqual(2);
    expect(validateSourceRegistry([...config.official, ...config.community])).toHaveLength(
      config.official.length + config.community.length
    );
  });
});
