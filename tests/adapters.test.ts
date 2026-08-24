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
  readResponseTextLimited,
  requestPublicHttps,
  type PublicHttpsRequest
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
    for (const address of [
      "10.0.0.1",
      "100.64.0.1",
      "172.16.0.1",
      "192.168.1.1",
      "192.0.2.1",
      "198.18.0.1",
      "169.254.1.1",
      "127.0.0.1",
      "2001:db8::1",
      "2002::1",
      "fe90::1",
      "::ffff:127.0.0.1",
      "64:ff9b::1"
    ]) {
      expect(isPrivateAddress(address)).toBe(true);
    }
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    expect(isPrivateAddress("2001:4860:4860::8888")).toBe(false);
    expect(isPrivateAddress("::1")).toBe(true);
  });

  it("pins one validated public DNS answer while preserving HTTPS hostname and SNI", async () => {
    const controller = new AbortController();
    let requestOptions: Record<string, unknown> | undefined;
    let destroyed = false;
    const fakeRequest: PublicHttpsRequest = ((options, callback) => {
      requestOptions = options as Record<string, unknown>;
      callback({
        statusCode: 200,
        headers: { "content-type": "text/html" },
        destroy: () => {
          destroyed = true;
        }
      } as never);
      return { once: () => undefined, end: () => undefined } as never;
    }) as PublicHttpsRequest;
    const lookup = vi.fn(async (_hostname, options) => {
      expect(options.all).toBe(true);
      expect(options.order).toBe("ipv4first");
      expect(options.signal).toBe(controller.signal);
      return [{ address: "93.184.216.34", family: 4 }];
    });

    const response = await requestPublicHttps({
      url: "https://example.com:443/source?x=1",
      allowedDomains: ["example.com"],
      signal: controller.signal,
      lookup,
      request: fakeRequest
    });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(requestOptions?.hostname).toBe("example.com");
    expect(requestOptions?.servername).toBe("example.com");
    expect(requestOptions?.agent).toBe(false);
    expect((requestOptions?.headers as Record<string, string>)["accept-encoding"]).toBe("identity");
    response.cancel();
    expect(destroyed).toBe(true);
  });

  it("rejects a mixed public and private DNS answer set before requesting", async () => {
    const request = vi.fn() as unknown as PublicHttpsRequest;
    await expect(requestPublicHttps({
      url: "https://example.com/source",
      allowedDomains: ["example.com"],
      signal: new AbortController().signal,
      lookup: async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "100.64.0.1", family: 4 }
      ],
      request
    })).rejects.toThrow(/Private/);
    expect(request).not.toHaveBeenCalled();
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

  it("cancels a non-ok response body before throwing HTTP errors", async () => {
    let cancelCalled = false;
    const response = {
      ok: false,
      status: 503,
      body: {
        cancel: async () => {
          cancelCalled = true;
        }
      }
    } as unknown as Response;
    vi.stubGlobal("fetch", vi.fn(async () => response));

    await expect(fetchUserProvidedUrl({
      url: "https://8.8.8.8/source",
      allowedDomains: ["8.8.8.8"]
    })).rejects.toThrow(/HTTP 503/);
    expect(cancelCalled).toBe(true);
  });

  it("cancels the body when the helper rejects an unsupported content-type", async () => {
    let cancelCalled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      cancel() {
        cancelCalled = true;
      }
    }), {
      headers: {
        "content-type": "application/octet-stream",
        "content-length": "999"
      }
    });

    await expect(readResponseTextLimited(response, 10)).rejects.toThrow(/Unsupported content-type/);
    expect(cancelCalled).toBe(true);
  });

  it("cancels the body when the helper rejects an oversized declaration", async () => {
    let cancelCalled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(4));
        controller.close();
      },
      cancel() {
        cancelCalled = true;
      }
    }), {
      headers: {
        "content-type": "text/plain",
        "content-length": "11"
      }
    });

    await expect(readResponseTextLimited(response, 10)).rejects.toThrow(/Source body too large/);
    expect(cancelCalled).toBe(true);
  });

  it("cancels the body when the helper rejects a missing content-type", async () => {
    let cancelCalled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      cancel() {
        cancelCalled = true;
      }
    }));

    await expect(readResponseTextLimited(response, 10)).rejects.toThrow(/content-type/i);
    expect(cancelCalled).toBe(true);
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
    }), { headers: { "content-type": "text/plain" } });

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
    }), { headers: { "content-type": "text/plain; charset=utf-8" } });

    await expect(readResponseTextLimited(response, bytes.byteLength)).resolves.toBe("éclair");
  });

  it("rejects responses without a body", async () => {
    await expect(readResponseTextLimited(new Response(null))).rejects.toThrow(/body/i);
  });
});
