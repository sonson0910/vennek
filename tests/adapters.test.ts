import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertPublicFetchUrl,
  fetchUserProvidedUrl,
  hostMatches,
  isCatalystUrl,
  isGovToolUrl,
  isPrivateAddress,
  normalizeCatalystSnapshot,
  normalizeGovernanceSnapshot,
  readResponseTextLimited
} from "@vennek/cardano-governance-skills";

afterEach(() => {
  vi.unstubAllGlobals();
});

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

  it("rejects a byte response with no content-type before reading its body", async () => {
    const response = new Response(new Uint8Array([1, 2, 3]));
    vi.stubGlobal("fetch", vi.fn(async () => response));

    await expect(fetchUserProvidedUrl({
      url: "https://8.8.8.8/source",
      allowedDomains: ["8.8.8.8"]
    })).rejects.toThrow(/content-type/i);
  });

  it("rejects unsupported content-types before reading the body", async () => {
    let reads = 0;
    const response = {
      ok: true,
      headers: new Headers({ "content-type": "application/octet-stream" }),
      body: { getReader: () => { reads += 1; throw new Error("body should not be read"); } }
    } as unknown as Response;
    vi.stubGlobal("fetch", vi.fn(async () => response));

    await expect(fetchUserProvidedUrl({
      url: "https://8.8.8.8/source",
      allowedDomains: ["8.8.8.8"]
    })).rejects.toThrow(/Unsupported content-type/);
    expect(reads).toBe(0);
  });

  it("rejects an oversized declared content-length without reading the body", async () => {
    let reads = 0;
    const response = {
      ok: true,
      headers: new Headers({
        "content-length": String(2 * 1024 * 1024 + 1),
        "content-type": "text/plain"
      }),
      body: { getReader: () => { reads += 1; throw new Error("body should not be read"); } }
    } as unknown as Response;
    vi.stubGlobal("fetch", vi.fn(async () => response));

    await expect(fetchUserProvidedUrl({
      url: "https://8.8.8.8/source",
      allowedDomains: ["8.8.8.8"]
    })).rejects.toThrow(/Source body too large/);
    expect(reads).toBe(0);
  });

  it("cancels a stream as soon as it crosses the byte limit", async () => {
    let cancelCalled = false;
    let pulls = 0;
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(11));
      },
      cancel() {
        cancelCalled = true;
      }
    }));

    await expect(readResponseTextLimited(response, 10)).rejects.toThrow(/Source body too large/);
    expect(cancelCalled).toBe(true);
    expect(pulls).toBe(1);
  });

  it("decodes UTF-8 split across chunks at exactly the byte limit", async () => {
    const bytes = new TextEncoder().encode("éclair");
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 1));
        controller.enqueue(bytes.slice(1));
        controller.close();
      }
    }));

    await expect(readResponseTextLimited(response, bytes.byteLength)).resolves.toBe("éclair");
  });

  it("rejects responses without a body", async () => {
    await expect(readResponseTextLimited(new Response(null))).rejects.toThrow(/body/i);
  });
});
