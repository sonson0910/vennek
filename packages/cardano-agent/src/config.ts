export interface AgentConfig {
  databaseUrl: string;
  encryptionKey: Buffer;
  liteLlmBaseUrl: URL;
  liteLlmApiKey: string;
  models: {
    fast: string;
    quality: string;
    verifier: string;
    embedding: string;
  };
}

type Environment = NodeJS.ProcessEnv | Record<string, string | undefined>;

export function parseAgentConfig(env: Environment): AgentConfig {
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

  return {
    databaseUrl: required("DATABASE_URL"),
    encryptionKey,
    liteLlmBaseUrl,
    liteLlmApiKey: required("LITELLM_API_KEY"),
    models: {
      fast: required("VENNEK_MODEL_FAST"),
      quality: required("VENNEK_MODEL_QUALITY"),
      verifier: required("VENNEK_MODEL_VERIFIER"),
      embedding: required("VENNEK_EMBEDDING_MODEL"),
    },
  };
}
