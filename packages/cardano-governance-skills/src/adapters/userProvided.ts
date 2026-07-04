import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
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
}): Promise<ProposalDocument> {
  const safeUrl = await assertPublicFetchUrl(input.url, input.allowedDomains);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);

  try {
    const response = await fetch(safeUrl, {
      signal: controller.signal,
      redirect: "error",
      headers: {
        "accept": "text/html,text/plain,application/json;q=0.9,application/xhtml+xml;q=0.8"
      }
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
    if (contentType && !ALLOWED_CONTENT_TYPES.includes(contentType)) {
      throw new Error(`Unsupported content-type: ${contentType}`);
    }

    const contentLength = Number(response.headers.get("content-length") ?? "0");
    if (contentLength > MAX_FETCH_BYTES) {
      throw new Error(`Source body too large: ${contentLength} bytes`);
    }

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_FETCH_BYTES) {
      throw new Error(`Source body too large: ${buffer.byteLength} bytes`);
    }

    const raw = new TextDecoder().decode(buffer);
    const title = extractTitle(raw) ?? safeUrl;
    const text = htmlToText(raw);
    if (text.length < 40) {
      throw new Error("Source body too short after normalization");
    }

    return normalizeUserProvidedText({
      text,
      title,
      url: safeUrl,
      sourceType: input.sourceType,
      now: input.now
    });
  } finally {
    clearTimeout(timeout);
  }
}

export function hostMatches(host: string, allowedDomains: string[]): boolean {
  const normalized = host.toLowerCase().replace(/\.$/, "");
  return allowedDomains.some((domain) => {
    const allowed = domain.toLowerCase();
    return normalized === allowed || normalized.endsWith(`.${allowed}`);
  });
}

export async function assertPublicFetchUrl(value: string, allowedDomains: string[] = []): Promise<string> {
  const url = new URL(value);
  if (url.protocol !== "https:") {
    throw new Error("Only https URLs are accepted for remote source fetching.");
  }

  if (url.username || url.password) {
    throw new Error("Credentials in source URLs are not accepted.");
  }

  const host = url.hostname;
  if (allowedDomains.length === 0 || !hostMatches(host, allowedDomains)) {
    throw new Error("Remote URL source host is not on the configured allowlist. Paste text instead for untrusted sources.");
  }

  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: false });
  if (addresses.length === 0) {
    throw new Error("Source host did not resolve.");
  }

  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new Error("Private, loopback, link-local, multicast, and reserved hosts are not accepted.");
    }
  }

  return url.toString();
}

export function isPrivateAddress(address: string): boolean {
  if (address.includes(":")) {
    const lower = address.toLowerCase();
    return (
      lower === "::1" ||
      lower === "::" ||
      lower.startsWith("fc") ||
      lower.startsWith("fd") ||
      lower.startsWith("fe80:") ||
      lower.startsWith("ff")
    );
  }

  const octets = address.split(".").map((part) => Number(part));
  if (octets.length !== 4 || octets.some((part) => Number.isNaN(part))) {
    return true;
  }
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a === 169 && b === 254 ||
    a === 172 && b >= 16 && b <= 31 ||
    a === 192 && b === 168 ||
    a >= 224
  );
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
