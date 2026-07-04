import { describe, expect, it } from "vitest";
import {
  assertPublicFetchUrl,
  hostMatches,
  isCatalystUrl,
  isGovToolUrl,
  isPrivateAddress,
  normalizeCatalystSnapshot,
  normalizeGovernanceSnapshot
} from "@vennek/cardano-governance-skills";

describe("adapters URL classification and fetch guards", () => {
  it("matches trusted domains by exact host or safe subdomain only", () => {
    expect(hostMatches("projectcatalyst.io", ["projectcatalyst.io"])).toBe(true);
    expect(hostMatches("www.projectcatalyst.io", ["projectcatalyst.io"])).toBe(true);
    expect(hostMatches("projectcatalyst.io.evil.com", ["projectcatalyst.io"])).toBe(false);
  });

  it("classifies Catalyst and GovTool URLs without substring spoofing", () => {
    expect(isCatalystUrl("https://projectcatalyst.io/funds/15/example")).toBe(true);
    expect(isCatalystUrl("https://projectcatalyst.io.evil.test/funds/15/example")).toBe(false);
    expect(isGovToolUrl("https://gov.tools/governance_actions/example")).toBe(true);
    expect(isGovToolUrl("https://gov.tools.attacker.test/governance_actions/example")).toBe(false);
  });

  it("normalizes snapshots into explicit source types", () => {
    expect(normalizeCatalystSnapshot({ text: "Catalyst proposal body long enough for a citation", now: new Date("2026-07-04T00:00:00.000Z") }).sourceType).toBe("catalyst");
    expect(normalizeGovernanceSnapshot({ text: "Governance action body long enough for a citation", now: new Date("2026-07-04T00:00:00.000Z") }).sourceType).toBe("governance-action");
  });

  it("rejects unsafe remote fetch URLs before network fetch", async () => {
    await expect(assertPublicFetchUrl("http://projectcatalyst.io/example")).rejects.toThrow(/Only https/);
    await expect(assertPublicFetchUrl("https://user:pass@projectcatalyst.io/example", ["projectcatalyst.io"])).rejects.toThrow(/Credentials/);
    await expect(assertPublicFetchUrl("https://127.0.0.1/example", ["127.0.0.1"])).rejects.toThrow(/Private/);
    await expect(assertPublicFetchUrl("https://example.com/proposal")).rejects.toThrow(/allowlist/);
  });

  it("detects private IP address ranges", () => {
    expect(isPrivateAddress("10.0.0.1")).toBe(true);
    expect(isPrivateAddress("172.16.0.1")).toBe(true);
    expect(isPrivateAddress("192.168.1.1")).toBe(true);
    expect(isPrivateAddress("169.254.1.1")).toBe(true);
    expect(isPrivateAddress("127.0.0.1")).toBe(true);
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    expect(isPrivateAddress("::1")).toBe(true);
  });
});
