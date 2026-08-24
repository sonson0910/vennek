import { readFileSync } from "node:fs";
import { assertPublicFetchUrl } from "@vennek/cardano-governance-skills";
import {
  REQUIRED_OFFICIAL_SOURCE_IDS,
  validateSourceRegistry,
  type SourceRegistryEntry,
  type TrustTier
} from "@vennek/cardano-agent";

const CONFIG_URL = new URL("../config/cardano-sources.json", import.meta.url);
const LIVE_TIMEOUT_MS = 8_000;
const SUPPORTED_CONTENT_TYPES = new Set([
  "application/atom+xml",
  "application/json",
  "application/pdf",
  "application/rss+xml",
  "application/xhtml+xml",
  "application/xml",
  "text/html",
  "text/markdown",
  "text/plain",
  "text/xml"
]);

type SourceConfig = {
  official: unknown[];
  community: unknown[];
};

export function readSourceConfig(): SourceConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(CONFIG_URL, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Unable to parse source registry JSON: ${error instanceof Error ? error.message : "invalid JSON"}`);
  }
  if (!isRecord(parsed) || Object.keys(parsed).some((key) => key !== "official" && key !== "community")) {
    throw new Error("Source registry config must contain only official and community sections.");
  }
  if (!Array.isArray(parsed.official) || !Array.isArray(parsed.community)) {
    throw new Error("Source registry config sections must be arrays.");
  }
  return { official: parsed.official, community: parsed.community };
}

export function validateSourceConfig(config: SourceConfig): SourceRegistryEntry[] {
  validateSectionTier(config.official, "official");
  validateSectionTier(config.community, "community");
  return validateSourceRegistry([...config.official, ...config.community]);
}

function validateSectionTier(entries: unknown[], tier: TrustTier): void {
  for (const [index, entry] of entries.entries()) {
    if (!isRecord(entry) || entry.trustTier !== tier) {
      throw new Error(`${tier} source entry ${index} must have trustTier ${tier}.`);
    }
  }
}

async function checkLive(entry: SourceRegistryEntry): Promise<string | undefined> {
  let safeUrl: string;
  try {
    safeUrl = await assertPublicFetchUrl(entry.url, entry.allowedDomains);
  } catch (error) {
    return `URL rejected (${safeReason(error)}).`;
  }

  const head = await fetchWithTimeout(safeUrl, { method: "HEAD", redirect: "error" });
  const headType = contentType(head.response);
  const headOk = head.response?.ok && headType !== undefined;
  if (head.response) {
    await cancelBody(head.response);
  }
  if (headOk) {
    return undefined;
  }

  const headReason = head.error
    ? `HEAD failed (${safeReason(head.error)})`
    : head.response && !head.response.ok
      ? `HEAD returned HTTP ${head.response.status}`
      : "HEAD returned an unsupported content type";
  const get = await fetchWithTimeout(safeUrl, {
    method: "GET",
    redirect: "error",
    headers: { Range: "bytes=0-0" }
  });
  const getType = contentType(get.response);
  const getOk = get.response?.ok && getType !== undefined;
  if (get.response) {
    await cancelBody(get.response);
  }
  if (getOk) {
    return undefined;
  }
  const getReason = get.error
    ? safeReason(get.error)
    : get.response && !get.response.ok
      ? `HTTP ${get.response.status}`
      : "unsupported content type";
  return `${headReason}; GET fallback failed (${getReason}).`;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit
): Promise<{ response?: Response; error?: unknown }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LIVE_TIMEOUT_MS);
  try {
    return { response: await fetch(url, { ...init, signal: controller.signal }) };
  } catch (error) {
    return { error };
  } finally {
    clearTimeout(timeout);
  }
}

function contentType(response?: Response): string | undefined {
  const value = response?.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  return value && SUPPORTED_CONTENT_TYPES.has(value) ? value : undefined;
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Keep the HTTP result as the live validation outcome.
  }
}

function safeReason(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") {
    return "timeout";
  }
  if (error instanceof Error && error.message.includes("Credentials")) {
    return "credentials are not accepted";
  }
  if (error instanceof Error && error.message.includes("https")) {
    return "HTTPS is required";
  }
  return "network or URL validation error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function main(): Promise<void> {
  try {
    const config = readSourceConfig();
    const entries = validateSourceConfig(config);
    const officialIds = new Set(config.official.map((entry) => isRecord(entry) && typeof entry.id === "string" ? entry.id : ""));
    const covered = REQUIRED_OFFICIAL_SOURCE_IDS.filter((id) => officialIds.has(id)).length;
    if (covered !== REQUIRED_OFFICIAL_SOURCE_IDS.length) {
      throw new Error(`Official source coverage is ${covered}/${REQUIRED_OFFICIAL_SOURCE_IDS.length}.`);
    }
    console.log(`Official source coverage: ${covered}/${REQUIRED_OFFICIAL_SOURCE_IDS.length}`);
    console.log(`Community sources: ${config.community.length}`);
    console.log(`Validated registry entries: ${entries.length}`);

    if (process.argv.includes("--live")) {
      for (const entry of entries) {
        const failure = await checkLive(entry);
        console.log(`${entry.id}: ${failure ?? "ok"}`);
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Source registry validation failed.");
    process.exitCode = 1;
  }
}

void main();
