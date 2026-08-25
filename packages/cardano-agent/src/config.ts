import { validatePrivateDocumentToken } from "./privateComparison/privateDocumentProtocol.js";

export interface AgentConfig {
  databaseUrl: string;
  encryptionKey: Buffer;
  liteLlmBaseUrl: URL;
  liteLlmApiKey: string;
  searxngBaseUrl?: URL;
  models: {
    fast: string;
    quality: string;
    verifier: string;
    embedding: string;
  };
  privateDocumentExtractorUrl?: URL;
  privateDocumentExtractorToken?: string;
  privateModels?: {
    quality: string;
    verifier: string;
  };
}

type Environment = NodeJS.ProcessEnv | Record<string, string | undefined>;
export type AgentConfigOptions = Readonly<{
  mode?: "text" | "worker";
  requirePrivateComparison?: boolean;
}>;

export function parseAgentConfig(env: Environment, options: AgentConfigOptions = {}): AgentConfig {
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) {
      throw new Error(`${name} is required`);
    }
    return value;
  };

  const encryptionKeyValue = required("VENNEK_ENCRYPTION_KEY");
  if (
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encryptionKeyValue) ||
    encryptionKeyValue.length % 4 !== 0
  ) {
    throw new Error("VENNEK_ENCRYPTION_KEY must be valid base64");
  }

  const encryptionKey = Buffer.from(encryptionKeyValue, "base64");
  if (
    encryptionKey.toString("base64") !== encryptionKeyValue ||
    encryptionKey.length !== 32
  ) {
    throw new Error("VENNEK_ENCRYPTION_KEY must decode to exactly 32 bytes");
  }

  const liteLlmBaseUrlValue = required("LITELLM_BASE_URL");
  let liteLlmBaseUrl: URL;
  try {
    liteLlmBaseUrl = new URL(liteLlmBaseUrlValue);
  } catch {
    throw new Error("LITELLM_BASE_URL must be a valid URL");
  }
  if (liteLlmBaseUrl.username || liteLlmBaseUrl.password) {
    throw new Error("LITELLM_BASE_URL must not include credentials");
  }
  if (!["http:", "https:"].includes(liteLlmBaseUrl.protocol)) {
    throw new Error("LITELLM_BASE_URL must use http or https");
  }

  const searxngValue = env.SEARXNG_BASE_URL;
  let searxngBaseUrl: URL | undefined;
  if (searxngValue !== undefined) {
    try {
      searxngBaseUrl = new URL(searxngValue.trim());
    } catch {
      throw new Error("SEARXNG_BASE_URL must be a valid URL");
    }
    if (
      !["http:", "https:"].includes(searxngBaseUrl.protocol) ||
      searxngBaseUrl.username ||
      searxngBaseUrl.password ||
      searxngBaseUrl.pathname !== "/" ||
      searxngBaseUrl.search ||
      searxngBaseUrl.hash ||
      !searxngValue.trim()
    ) {
      throw new Error("SEARXNG_BASE_URL must be an HTTP(S) origin without credentials or path");
    }
  }

  const config: AgentConfig = {
    databaseUrl: required("DATABASE_URL"),
    encryptionKey,
    liteLlmBaseUrl,
    liteLlmApiKey: required("LITELLM_API_KEY"),
    ...(searxngBaseUrl ? { searxngBaseUrl } : {}),
    models: {
      fast: required("VENNEK_MODEL_FAST"),
      quality: required("VENNEK_MODEL_QUALITY"),
      verifier: required("VENNEK_MODEL_VERIFIER"),
      embedding: required("VENNEK_EMBEDDING_MODEL"),
    },
  };
  if (options.mode === "worker" || options.requirePrivateComparison === true) {
    const extractorUrl = parsePrivateExtractorUrl(required("PRIVATE_DOCUMENT_EXTRACTOR_URL"));
    const extractorToken = required("PRIVATE_DOCUMENT_EXTRACTOR_TOKEN");
    validatePrivateDocumentToken(extractorToken);
    const privateQuality = parsePrivateModel(required("VENNEK_PRIVATE_MODEL_QUALITY"));
    const privateVerifier = parsePrivateModel(required("VENNEK_PRIVATE_MODEL_VERIFIER"));
    if (privateQuality === privateVerifier) throw new Error("Private model aliases must be distinct");
    config.privateDocumentExtractorUrl = extractorUrl;
    config.privateDocumentExtractorToken = extractorToken;
    config.privateModels = { quality: privateQuality, verifier: privateVerifier };
  }
  return config;
}

export function parseAgentWorkerConfig(env: Environment): AgentConfig {
  return parseAgentConfig(env, { mode: "worker" });
}

function parsePrivateExtractorUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("PRIVATE_DOCUMENT_EXTRACTOR_URL must be a valid URL");
  }
  if (
    url.protocol !== "http:" ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("PRIVATE_DOCUMENT_EXTRACTOR_URL must be an internal HTTP origin without credentials or path");
  }
  return url;
}

function parsePrivateModel(value: string): string {
  if (
    Buffer.byteLength(value, "utf8") > 128 ||
    Array.from(value).length > 128 ||
    !/^cardano-private-[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)
  ) {
    throw new Error("Private model aliases must be bounded cardano-private-* aliases");
  }
  return value;
}
