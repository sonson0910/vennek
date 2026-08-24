import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import * as https from "node:https";
import { BlockList, isIP } from "node:net";
import type { ClientRequest, IncomingHttpHeaders, IncomingMessage } from "node:http";
import { createCitation, sha256Hex, type ProposalDocument, type SourceType } from "@vennek/shared";

const MAX_FETCH_BYTES = 2 * 1024 * 1024;
const ALLOWED_CONTENT_TYPES = ["text/html", "text/plain", "application/json", "application/xhtml+xml"];

export function normalizeUserProvidedText(input: {
  text: string;
  title?: string;
  url?: string;
  sourceType?: SourceType;
  now?: Date;
}): ProposalDocument {
  const retrievedAt = (input.now ?? new Date()).toISOString();
  const title = input.title?.trim() || inferTitle(input.text);
  const url = input.url ?? `user-provided:${sha256Hex(input.text).slice(0, 16)}`;

  return {
    id: `user-${sha256Hex(`${title}\n${input.text}`).slice(0, 12)}`,
    sourceType: input.sourceType ?? "user-provided",
    url,
    title,
    body: input.text.trim(),
    metadata: {},
    citations: [
      createCitation({
        id: "S1",
        url,
        title,
        snippet: input.text,
        retrievedAt
      })
    ],
    retrievedAt
  };
}

export async function fetchUserProvidedUrl(input: {
  url: string;
  sourceType?: SourceType;
  now?: Date;
  allowedDomains?: string[];
  lookup?: PublicHttpsLookup;
  request?: PublicHttpsRequest;
}): Promise<ProposalDocument> {
  const signal = AbortSignal.timeout(8_000);
  const response = await requestPublicHttps({
    url: input.url,
    allowedDomains: input.allowedDomains ?? [],
    signal,
    headers: { accept: "text/html,text/plain,application/json;q=0.9,application/xhtml+xml;q=0.8" },
    lookup: input.lookup,
    request: input.request
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    response.cancel();
    throw new Error(`HTTP ${response.statusCode}`);
  }

  const raw = await readIncomingMessageTextLimited(response, signal);
  const title = extractTitle(raw) ?? response.url;
  const text = htmlToText(raw);
  if (text.length < 40) {
    throw new Error("Source body too short after normalization");
  }

  return normalizeUserProvidedText({
    text,
    title,
    url: response.url,
    sourceType: input.sourceType,
    now: input.now
  });
}

export async function readResponseTextLimited(response: Response, maxBytes = MAX_FETCH_BYTES): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    await cancelResponseBody(response);
    throw new Error("maxBytes must be a positive safe integer");
  }
  if (!response.body) {
    throw new Error("Source response has no body");
  }

  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (!contentType) {
    await cancelResponseBody(response);
    throw new Error("Missing content-type");
  }
  if (!ALLOWED_CONTENT_TYPES.includes(contentType)) {
    await cancelResponseBody(response);
    throw new Error(`Unsupported content-type: ${contentType}`);
  }

  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength >= 0 && contentLength > maxBytes) {
    await cancelResponseBody(response);
    throw new Error(`Source body too large: ${contentLength} bytes`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await cancelReader(reader);
        throw new Error(`Source body too large: ${totalBytes} bytes`);
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Preserve the validation or HTTP error when transport cleanup fails.
  }
}

async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // Preserve the size error when transport cleanup fails.
  }
}

export function hostMatches(host: string, allowedDomains: string[]): boolean {
  const normalized = host.toLowerCase().replace(/\.$/, "");
  return allowedDomains.some((domain) => {
    const allowed = domain.toLowerCase();
    return normalized === allowed || normalized.endsWith(`.${allowed}`);
  });
}

export async function assertPublicFetchUrl(value: string, allowedDomains: string[] = []): Promise<void> {
  await resolvePublicHttpsUrl(value, allowedDomains, AbortSignal.timeout(8_000));
}

const NON_GLOBAL_IPV4 = new BlockList();
for (const [subnet, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4]
] as const) {
  NON_GLOBAL_IPV4.addSubnet(subnet, prefix, "ipv4");
}

const GLOBAL_IPV6 = new BlockList();
GLOBAL_IPV6.addSubnet("2000::", 3, "ipv6");
const NON_GLOBAL_IPV6 = new BlockList();
for (const [subnet, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20]
] as const) {
  NON_GLOBAL_IPV6.addSubnet(subnet, prefix, "ipv6");
}

export function isPrivateAddress(address: string): boolean {
  const normalized = address.replace(/^\[|\]$/g, "");
  const family = isIP(normalized);
  if (family === 4) {
    return NON_GLOBAL_IPV4.check(normalized, "ipv4") === true;
  }
  if (family !== 6) {
    return true;
  }
  return !GLOBAL_IPV6.check(normalized, "ipv6") || NON_GLOBAL_IPV6.check(normalized, "ipv6");
}

export type PublicHttpsLookup = (
  hostname: string,
  options: { all: true; order: "ipv4first"; signal: AbortSignal }
) => Promise<LookupAddress[]>;

export type PublicHttpsResponse = {
  url: string;
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: IncomingMessage;
  cancel: () => void;
};

export type PublicHttpsRequest = (
  options: https.RequestOptions,
  callback: (response: IncomingMessage) => void
) => ClientRequest;
type PinnedHttpsRequestOptions = https.RequestOptions & { autoSelectFamily: false };

/** Resolves once, rejects mixed DNS answers, and connects to the selected safe address. */
export async function requestPublicHttps(input: {
  url: string;
  allowedDomains: string[];
  signal: AbortSignal;
  method?: "HEAD" | "GET";
  headers?: Record<string, string>;
  lookup?: PublicHttpsLookup;
  request?: PublicHttpsRequest;
}): Promise<PublicHttpsResponse> {
  const resolved = await resolvePublicHttpsUrl(input.url, input.allowedDomains, input.signal, input.lookup);
  input.signal.throwIfAborted();
  const requestImpl = input.request ?? ((options, callback) => https.request(options, callback));
  const headers: Record<string, string> = Object.fromEntries(
    Object.entries(input.headers ?? {}).filter(([name]) => name.toLowerCase() !== "accept-encoding")
  );
  headers["accept-encoding"] = "identity";
  const requestOptions: PinnedHttpsRequestOptions = {
    protocol: "https:",
    hostname: resolved.hostname,
    servername: resolved.hostname,
    port: 443,
    path: `${resolved.url.pathname}${resolved.url.search}` || "/",
    method: input.method ?? "GET",
    headers,
    agent: false,
    family: resolved.family,
    autoSelectFamily: false,
    signal: input.signal,
    lookup: (_hostname, options, callback) => {
      if (options.all) {
        callback(null, [{ address: resolved.address, family: resolved.family }]);
      } else {
        callback(null, resolved.address, resolved.family);
      }
    }
  } as PinnedHttpsRequestOptions;

  return new Promise<PublicHttpsResponse>((resolve, reject) => {
    let settled = false;
    let request: ClientRequest | undefined;
    const abort = () => {
      request?.destroy(input.signal.reason as Error | undefined);
      if (!settled) {
        reject(input.signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
      }
    };
    const cleanup = () => input.signal.removeEventListener("abort", abort);
    input.signal.addEventListener("abort", abort, { once: true });
    try {
      request = requestImpl(requestOptions, (response) => {
        if (response.statusCode === undefined) {
          response.destroy();
          cleanup();
          reject(new Error("HTTPS response did not include a status code."));
          return;
        }
        settled = true;
        cleanup();
        resolve({
          url: resolved.url.toString(),
          statusCode: response.statusCode,
          headers: response.headers,
          body: response,
          cancel: () => response.destroy()
        });
      });
      request.once("error", (error) => {
        if (!settled) {
          cleanup();
          reject(error);
        }
      });
      request.end();
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

async function readIncomingMessageTextLimited(
  response: PublicHttpsResponse,
  signal: AbortSignal,
  maxBytes = MAX_FETCH_BYTES
): Promise<string> {
  const rawContentType = response.headers["content-type"];
  const contentType = (Array.isArray(rawContentType) ? rawContentType[0] : rawContentType)
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase() ?? "";
  if (!contentType) {
    response.cancel();
    throw new Error("Missing content-type");
  }
  if (!ALLOWED_CONTENT_TYPES.includes(contentType)) {
    response.cancel();
    throw new Error(`Unsupported content-type: ${contentType}`);
  }

  const rawContentLength = response.headers["content-length"];
  const contentLength = Number(Array.isArray(rawContentLength) ? rawContentLength[0] : rawContentLength);
  if (Number.isFinite(contentLength) && contentLength >= 0 && contentLength > maxBytes) {
    response.cancel();
    throw new Error(`Source body too large: ${contentLength} bytes`);
  }

  signal.throwIfAborted();
  const abort = () => response.body.destroy(signal.reason instanceof Error ? signal.reason : undefined);
  signal.addEventListener("abort", abort, { once: true });
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = "";
  try {
    for await (const chunk of response.body) {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk as Uint8Array;
      totalBytes += bytes.byteLength;
      if (totalBytes > maxBytes) {
        response.cancel();
        throw new Error(`Source body too large: ${totalBytes} bytes`);
      }
      text += decoder.decode(bytes, { stream: true });
    }
    signal.throwIfAborted();
    return text + decoder.decode();
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

async function resolvePublicHttpsUrl(
  value: string,
  allowedDomains: string[],
  signal: AbortSignal,
  lookupImpl: PublicHttpsLookup = (hostname, options) => dnsLookup(hostname, options as never) as unknown as Promise<LookupAddress[]>
): Promise<{ url: URL; hostname: string; address: string; family: 4 | 6 }> {
  signal.throwIfAborted();
  let url: URL;
  try {
    if (value.includes("\\") || /%(?:2f|5c)/i.test(value)) {
      throw new Error("Encoded path separators are not accepted.");
    }
    url = new URL(value);
  } catch (error) {
    throw error instanceof Error ? error : new Error("Malformed source URL.");
  }
  if (url.protocol !== "https:") {
    throw new Error("Only https URLs are accepted for remote source fetching.");
  }
  if (url.port !== "" && url.port !== "443") {
    throw new Error("Only HTTPS port 443 is accepted for remote source fetching.");
  }
  if (url.username || url.password) {
    throw new Error("Credentials in source URLs are not accepted.");
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (allowedDomains.length === 0 || !hostMatches(hostname, allowedDomains)) {
    throw new Error("Remote URL source host is not on the configured allowlist. Paste text instead for untrusted sources.");
  }

  const literalFamily = isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await abortableLookup(lookupImpl(hostname, { all: true, order: "ipv4first", signal }), signal);
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error("Private, loopback, link-local, multicast, and reserved hosts are not accepted.");
  }
  const selected = addresses.find(({ address }) => !isPrivateAddress(address));
  if (!selected || (selected.family !== 4 && selected.family !== 6)) {
    throw new Error("Source host did not resolve to a public IP address.");
  }
  return { url, hostname, address: selected.address, family: selected.family };
}

async function abortableLookup<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function inferTitle(text: string): string {
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return firstLine?.slice(0, 120) || "User provided governance source";
}

function extractTitle(raw: string): string | undefined {
  const match = raw.match(/<title[^>]*>(.*?)<\/title>/is);
  return match?.[1]?.replace(/\s+/g, " ").trim();
}

function htmlToText(raw: string): string {
  return raw
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}
