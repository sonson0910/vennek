import { isIP } from "node:net";
import { hostMatches } from "@vennek/cardano-governance-skills";

export type TrustTier = "official" | "community" | "unverified";
export type SourceKind = "sitemap" | "github" | "feed" | "page";
export type RefreshRate = "hourly" | "daily";
export type CardanoNetwork = "mainnet" | "preprod" | "preview";

export type SourceRegistryEntry = {
  id: string;
  owner: string;
  trustTier: TrustTier;
  kind: SourceKind;
  url: string;
  allowedDomains: string[];
  topics: string[];
  networks: CardanoNetwork[];
  refresh: RefreshRate;
};

export const REQUIRED_OFFICIAL_SOURCE_IDS = [
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
  "refresh"
]);
const TRUST_TIERS = new Set<TrustTier>(["official", "community", "unverified"]);
const SOURCE_KINDS = new Set<SourceKind>(["sitemap", "github", "feed", "page"]);
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

  const ids = new Set<string>();
  return input.map((candidate, index) => {
    const entry = validateEntry(candidate, index);
    if (ids.has(entry.id)) {
      throw new Error(`Duplicate source id: ${entry.id}`);
    }
    ids.add(entry.id);
    return entry;
  });
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
  if (!hostMatches(hostname, allowedDomains)) {
    throw new Error(`Source entry ${index} url host is outside the allowed domain list.`);
  }

  return {
    id,
    owner,
    trustTier,
    kind,
    url,
    allowedDomains,
    topics,
    networks,
    refresh
  };
}

function validateDomains(value: unknown, index: number): string[] {
  const domains = nonEmptyArray(value, "allowedDomains", index, MAX_ARRAY_LENGTH) as string[];
  const seen = new Set<string>();
  for (const domain of domains) {
    if (typeof domain !== "string" || domain.length === 0 || domain.length > MAX_DOMAIN_LENGTH) {
      throw new Error(`Source entry ${index} allowedDomains contains an invalid domain.`);
    }
    if (domain !== domain.toLowerCase() || isIP(domain.replace(/^\[|\]$/g, "")) || domain.includes("/") || domain.endsWith(".")) {
      throw new Error(`Source entry ${index} allowedDomains contains an IP literal or malformed domain.`);
    }
    const labels = domain.split(".");
    if (
      labels.length < 2 ||
      labels.some((label) => label.length === 0 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))
    ) {
      throw new Error(`Source entry ${index} allowedDomains contains a malformed domain.`);
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
