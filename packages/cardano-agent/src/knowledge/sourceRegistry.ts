import { isIP } from "node:net";
import { hostMatches } from "@vennek/cardano-governance-skills";

export type TrustTier = "official" | "community" | "unverified";
export type IngestionMode = "scheduled" | "monitor-only";
export type StackExchangeScope = { site: "cardano" };
export type SourceKind = "sitemap" | "github" | "page" | "stackexchange";
export type RefreshRate = "hourly" | "daily";
export type CardanoNetwork = "mainnet" | "preprod" | "preview";
export type GithubScope = {
  owner: string;
  repository?: string;
};

type SourceRegistryEntryBase = {
  id: string;
  owner: string;
  trustTier: TrustTier;
  url: string;
  allowedDomains: string[];
  topics: string[];
  networks: CardanoNetwork[];
  refresh: RefreshRate;
  ingestionMode?: IngestionMode;
  liveFallbackIds?: string[];
};

export type SourceRegistryEntry = SourceRegistryEntryBase & (
  | { kind: "github"; github: GithubScope; stackExchange?: never }
  | { kind: "stackexchange"; github?: never; stackExchange: StackExchangeScope }
  | { kind: Exclude<SourceKind, "github" | "stackexchange">; github?: never; stackExchange?: never }
);

export type SourceRegistryEnvelope = {
  official: unknown[];
  community: unknown[];
};

export const REQUIRED_OFFICIAL_SOURCE_IDS = [
  "cardano-org",
  "cardano-docs",
  "cardano-developer-portal",
  "iog-research",
  "iog-github",
  "cardano-foundation",
  "cardano-foundation-github",
  "emurgo",
  "intersect",
  "intersect-github",
  "cardano-cips",
  "project-catalyst",
  "govtool",
  "cardano-node-releases",
  "cardano-ledger",
  "ouroboros-consensus",
  "plutus",
  "aiken"
] as const;

const ENTRY_FIELDS = new Set([
  "id",
  "owner",
  "trustTier",
  "kind",
  "url",
  "allowedDomains",
  "topics",
  "networks",
  "refresh",
  "github",
  "ingestionMode",
  "liveFallbackIds",
  "stackExchange"
]);
const TRUST_TIERS = new Set<TrustTier>(["official", "community", "unverified"]);
const SOURCE_KINDS = new Set<SourceKind>(["sitemap", "github", "page", "stackexchange"]);
const INGESTION_MODES = new Set<IngestionMode>(["scheduled", "monitor-only"]);
const REFRESH_RATES = new Set<RefreshRate>(["hourly", "daily"]);
const NETWORKS = new Set<CardanoNetwork>(["mainnet", "preprod", "preview"]);

const MAX_ID_LENGTH = 80;
const MAX_OWNER_LENGTH = 120;
const MAX_URL_LENGTH = 2_048;
const MAX_ARRAY_LENGTH = 32;
const MAX_REGISTRY_LENGTH = 1_024;
const MAX_DOMAIN_LENGTH = 253;
const MAX_TOPIC_LENGTH = 64;

export function validateSourceRegistry(input: unknown): SourceRegistryEntry[] {
  if (!Array.isArray(input)) {
    throw new Error("Source registry must be an array.");
  }
  if (input.length === 0) {
    throw new Error("Source registry must be a non-empty array.");
  }
  if (input.length > MAX_REGISTRY_LENGTH) {
    throw new Error("Source registry exceeds its maximum length.");
  }

  const entries = input.map((candidate, index) => validateEntry(candidate, index));
  const ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id)) {
      throw new Error(`Duplicate source id: ${entry.id}`);
    }
    ids.add(entry.id);
  }
  validateLiveFallbacks(entries);
  return entries;
}

/** Validate the on-disk registry envelope before flattening its tiered entries. */
export function validateSourceRegistryEnvelope(input: unknown): SourceRegistryEnvelope {
  if (!isRecord(input) || Object.keys(input).some((key) => key !== "official" && key !== "community")) {
    throw new Error("Source registry config must contain only official and community sections.");
  }
  if (!Array.isArray(input.official) || !Array.isArray(input.community)) {
    throw new Error("Source registry config sections must be arrays.");
  }
  for (const [tier, entries] of [["official", input.official], ["community", input.community]] as const) {
    for (const [index, entry] of entries.entries()) {
      if (!isRecord(entry) || entry.trustTier !== tier) {
        throw new Error(`${tier} source entry ${index} must have trustTier ${tier}.`);
      }
    }
  }
  return { official: input.official, community: input.community };
}

function validateEntry(candidate: unknown, index: number): SourceRegistryEntry {
  if (!isRecord(candidate)) {
    throw new Error(`Source entry ${index} must be an object.`);
  }
  for (const key of Object.keys(candidate)) {
    if (!ENTRY_FIELDS.has(key)) {
      throw new Error(`Unknown field in source entry ${index}: ${key}`);
    }
  }

  const id = boundedString(candidate.id, "id", MAX_ID_LENGTH, index);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
    throw new Error(`Source entry ${index} id must be lowercase hyphenated text.`);
  }
  const owner = boundedString(candidate.owner, "owner", MAX_OWNER_LENGTH, index);
  const trustTier = enumValue(candidate.trustTier, TRUST_TIERS, "trustTier", index);
  const kind = enumValue(candidate.kind, SOURCE_KINDS, "kind", index);
  const url = boundedString(candidate.url, "url", MAX_URL_LENGTH, index);
  const allowedDomains = validateDomains(candidate.allowedDomains, index);
  const topics = validateTopics(candidate.topics, index);
  const networks = validateNetworks(candidate.networks, index);
  const refresh = enumValue(candidate.refresh, REFRESH_RATES, "refresh", index);
  const ingestionMode = candidate.ingestionMode === undefined
    ? undefined
    : enumValue(candidate.ingestionMode, INGESTION_MODES, "ingestionMode", index);
  const liveFallbackIds = validateLiveFallbackIds(candidate.liveFallbackIds, index);
  const github = validateGithubScope(candidate.github, kind, index);

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error(`Source entry ${index} url is malformed.`);
  }
  if (parsedUrl.protocol !== "https:") {
    throw new Error(`Source entry ${index} url must use HTTPS.`);
  }
  if (parsedUrl.username || parsedUrl.password) {
    throw new Error(`Source entry ${index} url must not contain credentials.`);
  }
  const hostname = parsedUrl.hostname;
  if (isIP(hostname.replace(/^\[|\]$/g, ""))) {
    throw new Error(`Source entry ${index} url must not use an IP literal.`);
  }
  if (kind === "github" && github?.repository === undefined && requiresGithubRepository(parsedUrl)) {
    throw new Error(`Source entry ${index} github repository is required for repository or release URLs.`);
  }
  const stackExchange = validateStackExchangeScope(candidate.stackExchange, kind, url, allowedDomains, index);
  const common = {
    id,
    owner,
    trustTier,
    url,
    allowedDomains,
    topics,
    networks,
    refresh,
    ...(ingestionMode === undefined ? {} : { ingestionMode }),
    ...(liveFallbackIds === undefined ? {} : { liveFallbackIds })
  };
  const entry: SourceRegistryEntry = kind === "github"
    ? { ...common, kind, github: github! }
    : kind === "stackexchange"
      ? { ...common, kind, stackExchange: stackExchange! }
      : { ...common, kind };
  if (!urlMatchesSourceScope(url, entry)) {
    throw new Error(`Source entry ${index} url is outside the allowed domain or declared source scope.`);
  }
  return entry;
}

/** Returns whether a source participates in scheduled ingestion. */
export function sourceIsScheduled(entry: SourceRegistryEntry): boolean {
  return entry.ingestionMode !== "monitor-only";
}

function validateLiveFallbackIds(value: unknown, index: number): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const ids = nonEmptyArray(value, "liveFallbackIds", index, 16) as string[];
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id !== "string" || id.length > MAX_ID_LENGTH || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
      throw new Error(`Source entry ${index} liveFallbackIds contains an invalid lowercase hyphenated id.`);
    }
    if (seen.has(id)) {
      throw new Error(`Duplicate live fallback id in source entry ${index}: ${id}`);
    }
    seen.add(id);
  }
  return ids;
}

function validateLiveFallbacks(entries: SourceRegistryEntry[]): void {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  for (const entry of entries) {
    if (entry.liveFallbackIds === undefined) {
      continue;
    }
    if (entry.trustTier !== "official" || entry.ingestionMode !== "monitor-only") {
      throw new Error(`Source entry ${entry.id} liveFallbackIds require an official monitor-only source.`);
    }
    for (const fallbackId of entry.liveFallbackIds) {
      if (fallbackId === entry.id) {
        throw new Error(`Source entry ${entry.id} live fallback cannot reference itself.`);
      }
      const fallback = byId.get(fallbackId);
      if (!fallback) {
        throw new Error(`Source entry ${entry.id} live fallback does not exist: ${fallbackId}`);
      }
      if (fallback.trustTier !== "official") {
        throw new Error(`Source entry ${entry.id} live fallback must be official: ${fallbackId}`);
      }
      if (!sourceIsScheduled(fallback)) {
        throw new Error(`Source entry ${entry.id} live fallback must be scheduled: ${fallbackId}`);
      }
      if (fallback.owner !== entry.owner) {
        throw new Error(`Source entry ${entry.id} live fallback owner must match: ${fallbackId}`);
      }
      if (fallback.liveFallbackIds !== undefined) {
        throw new Error(`Source entry ${entry.id} live fallback cannot declare fallbacks: ${fallbackId}`);
      }
    }
  }
}

function validateGithubScope(value: unknown, kind: SourceKind, index: number): GithubScope | undefined {
  if (kind !== "github") {
    if (value !== undefined) {
      throw new Error(`Source entry ${index} github metadata is only valid for github sources.`);
    }
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`Source entry ${index} github metadata must be an object.`);
  }
  for (const key of Object.keys(value)) {
    if (key !== "owner" && key !== "repository") {
      throw new Error(`Unknown field in source entry ${index} github metadata: ${key}`);
    }
  }
  const owner = value.owner;
  if (typeof owner !== "string" || owner.length === 0 || owner.length > 100 || !/^[A-Za-z0-9-]+$/.test(owner)) {
    throw new Error(`Source entry ${index} github owner is invalid.`);
  }
  const repository = value.repository;
  if (repository !== undefined && (typeof repository !== "string" || repository.length === 0 || repository.length > 100 || !/^[A-Za-z0-9._-]+$/.test(repository))) {
    throw new Error(`Source entry ${index} github repository is invalid.`);
  }
  return repository === undefined ? { owner } : { owner, repository };
}

function validateStackExchangeScope(
  value: unknown,
  kind: SourceKind,
  url: string,
  allowedDomains: string[],
  index: number
): StackExchangeScope | undefined {
  if (kind !== "stackexchange") {
    if (value !== undefined) {
      throw new Error(`Source entry ${index} stackExchange metadata is only valid for stackexchange sources.`);
    }
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`Source entry ${index} stackExchange metadata must be an object.`);
  }
  if (Object.keys(value).some((key) => key !== "site")) {
    throw new Error(`Unknown field in source entry ${index} stackExchange metadata.`);
  }
  if (value.site !== "cardano") {
    throw new Error(`Source entry ${index} stackExchange site must be cardano.`);
  }
  if (url !== "https://api.stackexchange.com/2.3/questions") {
    throw new Error(`Source entry ${index} stackexchange URL must be exact.`);
  }
  const expectedDomains = ["api.stackexchange.com", "cardano.stackexchange.com"];
  if (allowedDomains.length !== expectedDomains.length || expectedDomains.some((domain) => !allowedDomains.includes(domain))) {
    throw new Error(`Source entry ${index} stackexchange allowedDomains must be exact.`);
  }
  return value as StackExchangeScope;
}

function validateDomains(value: unknown, index: number): string[] {
  const domains = nonEmptyArray(value, "allowedDomains", index, MAX_ARRAY_LENGTH) as string[];
  const seen = new Set<string>();
  for (const domain of domains) {
    if (typeof domain !== "string" || domain.length === 0 || domain.length > MAX_DOMAIN_LENGTH) {
      throw new Error(`Source entry ${index} allowedDomains contains an invalid domain.`);
    }
    if (domain !== domain.toLowerCase() || domain.includes("/") || domain.endsWith(".")) {
      throw new Error(`Source entry ${index} allowedDomains contains an IP literal or malformed domain.`);
    }
    const labels = domain.split(".");
    if (
      labels.length < 2 ||
      labels.some((label) => label.length === 0 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))
    ) {
      throw new Error(`Source entry ${index} allowedDomains contains a malformed domain.`);
    }
    try {
      const canonical = new URL(`https://${domain}/`).hostname;
      if (canonical !== domain || isIP(canonical)) {
        throw new Error("IP literal");
      }
    } catch {
      throw new Error(`Source entry ${index} allowedDomains contains an IP literal or malformed domain.`);
    }
    if (seen.has(domain)) {
      throw new Error(`Duplicate domain in source entry ${index}: ${domain}`);
    }
    seen.add(domain);
  }
  return domains;
}

function validateTopics(value: unknown, index: number): string[] {
  const topics = nonEmptyArray(value, "topics", index, MAX_ARRAY_LENGTH) as string[];
  const seen = new Set<string>();
  for (const topic of topics) {
    if (typeof topic !== "string" || topic.length === 0 || topic.length > MAX_TOPIC_LENGTH || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(topic)) {
      throw new Error(`Source entry ${index} topics contains a malformed topic.`);
    }
    if (seen.has(topic)) {
      throw new Error(`Duplicate topic in source entry ${index}: ${topic}`);
    }
    seen.add(topic);
  }
  return topics;
}

function validateNetworks(value: unknown, index: number): CardanoNetwork[] {
  const networks = nonEmptyArray(value, "networks", index, 3);
  const seen = new Set<string>();
  for (const network of networks) {
    if (typeof network !== "string" || !NETWORKS.has(network as CardanoNetwork)) {
      throw new Error(`Source entry ${index} networks contains an invalid network.`);
    }
    if (seen.has(network)) {
      throw new Error(`Duplicate network in source entry ${index}: ${network}`);
    }
    seen.add(network);
  }
  return networks as CardanoNetwork[];
}

function nonEmptyArray(value: unknown, name: string, index: number, maxLength: number): unknown[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Source entry ${index} ${name} must be a non-empty array.`);
  }
  if (value.length > maxLength) {
    throw new Error(`Source entry ${index} ${name} exceeds its maximum length.`);
  }
  return value;
}

function boundedString(value: unknown, name: string, maxLength: number, index: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Source entry ${index} ${name} must be a bounded non-empty string.`);
  }
  return value;
}

function enumValue<T extends string>(value: unknown, allowed: Set<T>, name: string, index: number): T {
  if (typeof value !== "string" || !allowed.has(value as T)) {
    throw new Error(`Source entry ${index} has an invalid ${name}.`);
  }
  return value as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Checks a URL against both its transport allowlist and its optional GitHub tenant scope. */
export function urlMatchesSourceScope(
  value: string,
  entry: Pick<SourceRegistryEntry, "kind" | "allowedDomains" | "github">
): boolean {
  let url: URL;
  try {
    if (value.includes("\\") || /%(?:2f|5c)/i.test(value)) {
      return false;
    }
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || (url.port !== "" && url.port !== "443") || url.username || url.password) {
    return false;
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (!hostMatches(hostname, entry.allowedDomains)) {
    return false;
  }
  if (entry.kind !== "github") {
    return entry.github === undefined;
  }
  if (!entry.github) {
    return false;
  }

  const sharedHost = hostname === "github.com" || hostname === "raw.githubusercontent.com" || hostname === "api.github.com";
  if (!sharedHost && (hostname.endsWith(".github.com") || hostname.endsWith(".raw.githubusercontent.com"))) {
    return false;
  }
  if (!sharedHost) {
    return true;
  }

  const segments = decodedPathSegments(value, url.pathname);
  if (!segments) {
    return false;
  }
  if (hostname === "api.github.com") {
    if (segments[0] === "repos") {
      return segments[1] === entry.github.owner &&
        (entry.github.repository === undefined
          ? segments.length >= 3
          : segments[2] === entry.github.repository && segments.length >= 3);
    }
    return entry.github.repository === undefined &&
      (segments[0] === "orgs" || segments[0] === "users") &&
      segments[1] === entry.github.owner;
  }

  const ownerMatches = segments[0] === entry.github.owner;
  if (!ownerMatches) {
    return false;
  }
  if (hostname === "raw.githubusercontent.com" && segments.length < 2) {
    return false;
  }
  return entry.github.repository === undefined ||
    (segments[1] === entry.github.repository && segments.length >= 2);
}

function requiresGithubRepository(url: URL): boolean {
  const hostname = url.hostname.toLowerCase();
  if (hostname !== "github.com" && hostname !== "raw.githubusercontent.com" && hostname !== "api.github.com") {
    return false;
  }
  const segments = decodedPathSegments(url.toString(), url.pathname);
  if (!segments) {
    return true;
  }
  if (hostname === "api.github.com") {
    return segments[0] === "repos" && segments.length >= 3;
  }
  return hostname === "raw.githubusercontent.com" ? segments.length >= 2 : segments.length >= 2;
}

function decodedPathSegments(rawValue: string, pathname: string): string[] | undefined {
  if (rawValue.includes("\\") || /%(?:2f|5c)/i.test(rawValue)) {
    return undefined;
  }
  const rawSegments = pathname.split("/");
  if (rawSegments[0] !== "") {
    return undefined;
  }
  if (rawSegments.at(-1) === "") {
    rawSegments.pop();
  }
  if (rawSegments.some((segment, index) => index > 0 && segment === "")) {
    return undefined;
  }
  try {
    const segments = rawSegments.slice(1).map((segment) => decodeURIComponent(segment));
    return segments.some((segment) => segment === "." || segment === ".." || segment.includes("/") || segment.includes("\\"))
      ? undefined
      : segments;
  } catch {
    return undefined;
  }
}
