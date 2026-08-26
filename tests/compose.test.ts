import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runWithCleanup } from "../scripts/verify-private-extractor-compose.js";

const composeEnvNames = new Set(
  readFileSync(".env.example", "utf8")
    .split(/\r?\n/)
    .map((line) => line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/)?.[1])
    .filter((name): name is string => name !== undefined),
);

function composeTestEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const childEnv = { ...process.env, ...overrides };
  for (const name of composeEnvNames) delete childEnv[name];
  childEnv.WEBHOOK_PORT = "9090";
  return childEnv;
}

const dockerCompose = spawnSync("docker", ["compose", "version"], {
  cwd: process.cwd(),
  encoding: "utf8",
  env: composeTestEnv(),
});
const hasDockerCompose = dockerCompose.status === 0;
const sentinelPromotionKey = "sentinel-promotion-key";

describe.skipIf(!hasDockerCompose)("rendered Compose contract", () => {
  it("uses one app image and keeps runtime boundaries fixed", () => {
    const result = spawnSync(
      "docker",
      ["compose", "--env-file", ".env.example", "config", "--format", "json"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: composeTestEnv({ KNOWLEDGE_PROMOTION_KEY: sentinelPromotionKey }),
      },
    );
    expect(result.status).toBe(0);

    const config = JSON.parse(result.stdout) as {
      services: Record<string, {
        build?: unknown;
        image?: string;
        environment?: Record<string, string | null>;
        ports?: Array<{ host_ip?: string; target?: number; published?: string }>;
        expose?: string[];
        healthcheck?: { test?: string[] };
        networks?: Record<string, unknown>;
        mem_limit?: string;
        memswap_limit?: string;
        cpus?: number;
        pids_limit?: number;
        read_only?: boolean;
        cap_drop?: string[];
        security_opt?: string[];
        user?: string;
        init?: boolean;
        tmpfs?: string[];
        command?: string[];
      }>;
      networks: Record<string, { internal?: boolean }>;
    };
    const appServices = ["migrate", "provision-app-role", "provision-knowledge-role", "telegram-webhook", "agent-worker", "knowledge-worker"];
    const images = appServices.map((name) => config.services[name]?.image);

    expect(new Set(images).size).toBe(1);
    expect(config.services.migrate?.build).toBeDefined();
    expect(appServices.filter((name) => config.services[name]?.build !== undefined)).toEqual(["migrate"]);
    const webhookEnvironment = config.services["telegram-webhook"]?.environment;
    const workerEnvironment = config.services["agent-worker"]?.environment;
    expect(webhookEnvironment?.DATABASE_URL).toBe(
      "postgresql://vennek_app:replace-with-a-long-app-password@postgres:5432/vennek",
    );
    expect(webhookEnvironment?.TELEGRAM_WEBHOOK_SECRET).toBe(
      "replace-with-at-least-32-url-safe-characters",
    );
    expect(webhookEnvironment?.VENNEK_ENCRYPTION_KEY).toBe(
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    );
    expect(workerEnvironment?.DATABASE_URL).toBe(
      "postgresql://vennek_app:replace-with-a-long-app-password@postgres:5432/vennek",
    );
    expect(workerEnvironment?.VENNEK_ENCRYPTION_KEY).toBe(
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    );
    expect(workerEnvironment?.TELEGRAM_BOT_TOKEN).toBe("replace-with-telegram-bot-token");
    expect(workerEnvironment?.LITELLM_BASE_URL).toBe("http://litellm:4000");
    expect(workerEnvironment?.LITELLM_API_KEY).toBe("replace-with-litellm-master-key");
    expect(workerEnvironment?.VENNEK_MODEL_FAST).toBe("cardano-fast");
    expect(workerEnvironment?.VENNEK_MODEL_QUALITY).toBe("cardano-quality");
    expect(workerEnvironment?.VENNEK_MODEL_VERIFIER).toBe("cardano-verifier");
    expect(workerEnvironment?.VENNEK_EMBEDDING_MODEL).toBe("cardano-embedding");
    expect(workerEnvironment?.KNOWLEDGE_PROMOTION_URL).toBe("http://knowledge-worker:8082");
    expect(workerEnvironment?.KNOWLEDGE_PROMOTION_KEY_ID).toBe("agent-worker-v1");
    expect(workerEnvironment?.KNOWLEDGE_PROMOTION_KEY).toBe(
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    );
    for (const name of ["KNOWLEDGE_PROMOTION_PORT", "SEARXNG_BASE_URL"]) {
      expect(workerEnvironment?.[name]).toBeUndefined();
    }
    for (const name of [
      "LITELLM_BASE_URL",
      "LITELLM_API_KEY",
      "VENNEK_MODEL_FAST",
      "VENNEK_MODEL_QUALITY",
      "VENNEK_MODEL_VERIFIER",
      "VENNEK_EMBEDDING_MODEL",
      "TELEGRAM_BOT_TOKEN",
    ]) {
      expect(webhookEnvironment?.[name]).toBeUndefined();
    }
    expect(workerEnvironment?.TELEGRAM_WEBHOOK_SECRET).toBeUndefined();
    const knowledgeEnvironment = config.services["knowledge-worker"]?.environment;
    expect(knowledgeEnvironment?.DATABASE_KNOWLEDGE_URL).toBe(
      "postgresql://vennek_knowledge:replace-with-a-long-knowledge-password@postgres:5432/vennek",
    );
    expect(knowledgeEnvironment?.PDF_EXTRACTOR_URL).toBe("http://pdf-extractor:8081");
    expect(knowledgeEnvironment?.PDF_EXTRACTOR_TOKEN).toBe("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    expect(knowledgeEnvironment?.KNOWLEDGE_PROMOTION_PORT).toBe("8082");
    expect(knowledgeEnvironment?.KNOWLEDGE_PROMOTION_KEY_ID).toBe("agent-worker-v1");
    expect(knowledgeEnvironment?.KNOWLEDGE_PROMOTION_KEY).toBe(
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    );
    expect(knowledgeEnvironment?.SEARXNG_BASE_URL).toBe("https://search.example.test/");
    for (const name of [
      "TELEGRAM_BOT_TOKEN",
      "TELEGRAM_WEBHOOK_SECRET",
      "VENNEK_ENCRYPTION_KEY",
      "VENNEK_CONVERSATION_KEY",
      "VENNEK_MODEL_FAST",
      "VENNEK_MODEL_QUALITY",
      "VENNEK_MODEL_VERIFIER",
      "DATABASE_OWNER_URL",
      "KNOWLEDGE_PROMOTION_URL",
    ]) {
      expect(knowledgeEnvironment?.[name]).toBeUndefined();
    }
    expect(config.services["knowledge-worker"]?.ports).toBeUndefined();
    expect(config.services["knowledge-worker"]?.expose).toEqual(["8082"]);
    for (const name of [
      "KNOWLEDGE_PROMOTION_URL",
      "KNOWLEDGE_PROMOTION_KEY_ID",
      "KNOWLEDGE_PROMOTION_KEY",
      "KNOWLEDGE_PROMOTION_PORT",
      "SEARXNG_BASE_URL",
    ]) {
      expect(webhookEnvironment?.[name]).toBeUndefined();
    }
    expect(new Set(
      Object.entries(config.services)
        .filter(([, service]) => service.environment?.KNOWLEDGE_PROMOTION_KEY !== undefined)
        .map(([name]) => name),
    )).toEqual(new Set(["agent-worker", "knowledge-worker"]));
    expect(config.services["telegram-webhook"]?.environment?.PORT).toBe("8080");
    expect(config.services["telegram-webhook"]?.ports).toHaveLength(1);
    expect(config.services["telegram-webhook"]?.ports).toContainEqual(expect.objectContaining({
      host_ip: "127.0.0.1",
      target: 8080,
      published: "9090",
    }));
    expect(config.services["telegram-webhook"]?.healthcheck?.test?.join(" ")).toContain("127.0.0.1:8080");
    for (const name of ["telegram-webhook", "agent-worker", "knowledge-worker"]) {
      expect(config.services[name]?.environment?.DATABASE_OWNER_URL).toBeUndefined();
    }
    const extractor = config.services["pdf-extractor"];
    expect(extractor?.image).toBe(images[0]);
    expect(extractor?.command).toEqual(["node", "packages/cardano-agent/dist/knowledge/pdfExtractorServer.js"]);
    expect(extractor?.ports).toBeUndefined();
    expect(extractor?.networks).toEqual({ "pdf-sandbox": null });
    expect(extractor?.mem_limit).toBe("268435456");
    expect(extractor?.memswap_limit).toBe("268435456");
    expect(extractor?.cpus).toBe(0.5);
    expect(extractor?.pids_limit).toBe(64);
    expect(extractor?.read_only).toBe(true);
    expect(extractor?.cap_drop).toEqual(["ALL"]);
    expect(extractor?.security_opt).toContain("no-new-privileges:true");
    expect(extractor?.user).toBe("1000:1000");
    expect(extractor?.init).toBe(true);
    expect(extractor?.tmpfs?.[0]).toContain("/tmp:size=16m");
    expect(config.networks["pdf-sandbox"]?.internal).toBe(true);
    for (const name of ["postgres", "migrate", "provision-app-role", "provision-knowledge-role", "litellm", "telegram-webhook", "agent-worker"]) {
      expect(config.services[name]?.networks?.["pdf-sandbox"]).toBeUndefined();
    }
    expect(config.services["agent-worker"]?.networks).toEqual({ default: null, "private-document-sandbox": null });
    expect(config.services["knowledge-worker"]?.networks).toEqual({ default: null, "pdf-sandbox": null });

    const privateExtractor = config.services["private-document-extractor"];
    expect(privateExtractor?.image).toBe(images[0]);
    expect(privateExtractor?.command).toEqual(["node", "packages/cardano-agent/dist/privateComparison/privateDocumentServer.js"]);
    expect(privateExtractor?.ports).toBeUndefined();
    expect(privateExtractor?.expose).toEqual(["8083"]);
    expect(privateExtractor?.networks).toEqual({ "private-document-sandbox": null });
    expect(privateExtractor?.environment?.PRIVATE_DOCUMENT_EXTRACTOR_TOKEN).toBe(
      "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
    );
    expect(privateExtractor?.environment?.PRIVATE_DOCUMENT_EXTRACTOR_PORT).toBe("8083");
    expect(privateExtractor?.mem_limit).toBe("268435456");
    expect(privateExtractor?.memswap_limit).toBe("268435456");
    expect(privateExtractor?.cpus).toBe(0.5);
    expect(privateExtractor?.pids_limit).toBe(64);
    expect(privateExtractor?.read_only).toBe(true);
    expect(privateExtractor?.cap_drop).toEqual(["ALL"]);
    expect(privateExtractor?.security_opt).toContain("no-new-privileges:true");
    expect(privateExtractor?.user).toBe("1000:1000");
    expect(privateExtractor?.init).toBe(true);
    expect(privateExtractor?.tmpfs?.[0]).toContain("/tmp:size=16m");
    expect(privateExtractor?.healthcheck?.test?.join(" ")).toContain("127.0.0.1:8083");
    expect(privateExtractor?.healthcheck?.test?.join(" ")).toContain("r.status === 200");
    expect(config.networks["private-document-sandbox"]?.internal).toBe(true);
    expect(config.services["agent-worker"]?.networks).toEqual({
      default: null,
      "private-document-sandbox": null,
    });
    expect(workerEnvironment?.PRIVATE_DOCUMENT_EXTRACTOR_URL).toBe("http://private-document-extractor:8083");
    expect(workerEnvironment?.PRIVATE_DOCUMENT_EXTRACTOR_TOKEN).toBe(
      "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
    );
    expect(workerEnvironment?.VENNEK_PRIVATE_MODEL_QUALITY).toBe("cardano-private-quality");
    expect(workerEnvironment?.VENNEK_PRIVATE_MODEL_VERIFIER).toBe("cardano-private-verifier");
    expect(config.services["knowledge-worker"]?.networks?.["private-document-sandbox"]).toBeUndefined();
    expect(config.services["pdf-extractor"]?.networks).toEqual({ "pdf-sandbox": null });
    for (const name of [
      "PRIVATE_DOCUMENT_EXTRACTOR_URL",
      "PRIVATE_DOCUMENT_EXTRACTOR_TOKEN",
      "VENNEK_PRIVATE_MODEL_QUALITY",
      "VENNEK_PRIVATE_MODEL_VERIFIER",
    ]) {
      expect(webhookEnvironment?.[name]).toBeUndefined();
    }
  });
});

describe("webhook private intake deployment contract", () => {
  it("requires only the encryption key for private intake and no model or extractor settings", () => {
    const compose = readFileSync("docker-compose.yml", "utf8");
    const webhookBlock = compose.slice(compose.indexOf("  telegram-webhook:"), compose.indexOf("  agent-worker:"));
    expect(webhookBlock).toContain("VENNEK_ENCRYPTION_KEY: ${VENNEK_ENCRYPTION_KEY:?VENNEK_ENCRYPTION_KEY is required}");
    for (const name of ["LITELLM_BASE_URL", "LITELLM_API_KEY", "VENNEK_MODEL_FAST", "VENNEK_PRIVATE_MODEL_QUALITY", "PRIVATE_DOCUMENT_EXTRACTOR_URL", "PRIVATE_DOCUMENT_EXTRACTOR_TOKEN"]) {
      expect(webhookBlock).not.toContain(name);
    }
  });
});

describe("PDF extractor verifier contract", () => {
  it("checks compiled import reachability and valid recovery", () => {
    const verifier = readFileSync("scripts/verify-pdf-extractor-compose.ts", "utf8");
    expect(verifier).not.toContain("process.moduleLoadList");
    expect(verifier).toContain("pdfExtractorWorker.js");
    expect(verifier).toContain("pdfjs-dist");
    expect(verifier).toContain("pollValidExtraction");
    expect(verifier).toContain("environment?.PDF_EXTRACTOR_TOKEN");
    expect(verifier).not.toContain("process.env.PDF_EXTRACTOR_TOKEN ??");
    expect(verifier).toContain("pollAgentExtraction");
    expect(verifier).toContain("ENOTFOUND");
  });
});

describe("LiteLLM embedding route contract", () => {
  it("declares the Cardano embedding alias and its provider environment", () => {
    const config = readFileSync("config/litellm.example.yaml", "utf8");
    const compose = readFileSync("docker-compose.yml", "utf8");
    const env = readFileSync(".env.example", "utf8");

    expect(config).toContain("model_name: cardano-embedding");
    expect(config).toContain("model: os.environ/OPENAI_EMBEDDING_MODEL");
    expect(config).toContain("api_key: os.environ/OPENAI_API_KEY");
    expect(env).toContain("OPENAI_EMBEDDING_MODEL=text-embedding-3-small");
    expect(compose).toContain("OPENAI_EMBEDDING_MODEL: ${OPENAI_EMBEDDING_MODEL:?OPENAI_EMBEDDING_MODEL is required}");
  });

});

describe("LiteLLM private route contract", () => {
  it("maps each private alias to one operator-supplied model without fallback", () => {
    const config = readFileSync("config/litellm.example.yaml", "utf8");
    const compose = readFileSync("docker-compose.yml", "utf8");
    const env = readFileSync(".env.example", "utf8");
    expect(config).toContain("model_name: cardano-private-quality");
    expect(config).toContain("model: os.environ/PRIVATE_OPENAI_QUALITY_MODEL");
    expect(config).toContain("model_name: cardano-private-verifier");
    expect(config).toContain("model: os.environ/PRIVATE_OPENAI_VERIFIER_MODEL");
    expect(config.match(/model_name: cardano-private-quality/g)).toHaveLength(1);
    expect(config.match(/model_name: cardano-private-verifier/g)).toHaveLength(1);
    expect(env).toContain("PRIVATE_OPENAI_QUALITY_MODEL=replace-with-approved-private-quality-model");
    expect(env).toContain("PRIVATE_OPENAI_VERIFIER_MODEL=replace-with-approved-private-verifier-model");
    expect(compose).toContain("PRIVATE_OPENAI_QUALITY_MODEL: ${PRIVATE_OPENAI_QUALITY_MODEL:?PRIVATE_OPENAI_QUALITY_MODEL is required}");
    expect(compose).toContain("PRIVATE_OPENAI_VERIFIER_MODEL: ${PRIVATE_OPENAI_VERIFIER_MODEL:?PRIVATE_OPENAI_VERIFIER_MODEL is required}");
  });
});

describe("private extractor verifier contract", () => {
  it("always cleans up and surfaces teardown failures", async () => {
    let cleaned = false;
    const primaryError = new Error("primary");
    await expect(runWithCleanup(async () => {
      throw primaryError;
    }, async () => {
      cleaned = true;
    })).rejects.toBe(primaryError);
    expect(cleaned).toBe(true);
    await expect(runWithCleanup(async () => "ok", async () => {
      throw new Error("teardown");
    })).rejects.toThrow("teardown");
    const cleanupError = new Error("cleanup");
    try {
      await runWithCleanup(async () => {
        throw primaryError;
      }, async () => {
        throw cleanupError;
      });
      throw new Error("expected dual failure");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([primaryError, cleanupError]);
    }
  });

  it("uses deterministic temporary fixtures and validates the internal service", () => {
    const verifier = readFileSync("scripts/verify-private-extractor-compose.ts", "utf8");
    expect(verifier).toContain("mkdtemp");
    expect(verifier).toContain("private-document-extractor");
    expect(verifier).toContain("/v1/extract/private-document");
    expect(verifier).toContain("PRIVATE_DOCUMENT_EXTRACTOR_TOKEN");
    expect(verifier).toContain("DOCX");
    expect(verifier).toContain("PDF");
    expect(verifier).toContain("unsafe");
    expect(verifier).toContain("spoof");
    expect(verifier).toContain("JavaScript");
    expect(verifier).toContain("OpenAction");
    expect(verifier).toContain("primaryError");
    expect(verifier).toContain("cleanupError");
    expect(verifier).not.toContain(".catch(() => undefined)");
    expect(verifier).toContain("down");
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as { scripts?: Record<string, string> };
    expect(packageJson.scripts?.["verify:private-extractor-compose"]).toContain("--smoke");
  });
});

describe("poller deployment example scope", () => {
  it("does not carry private worker extractor or provider settings", () => {
    const deployEnv = readFileSync("deploy/vennek.env.example", "utf8");
    for (const name of [
      "PRIVATE_DOCUMENT_EXTRACTOR_URL",
      "PRIVATE_DOCUMENT_EXTRACTOR_TOKEN",
      "VENNEK_PRIVATE_MODEL_QUALITY",
      "VENNEK_PRIVATE_MODEL_VERIFIER",
      "PRIVATE_OPENAI_API_KEY",
      "PRIVATE_OPENAI_QUALITY_MODEL",
      "PRIVATE_OPENAI_VERIFIER_MODEL",
    ]) {
      expect(deployEnv).not.toContain(`${name}=`);
    }
  });
});

describe("knowledge promotion deployment examples", () => {
  it("use the same canonical promotion settings in both env examples", () => {
    const expected = {
      KNOWLEDGE_PROMOTION_KEY_ID: "agent-worker-v1",
      KNOWLEDGE_PROMOTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      KNOWLEDGE_PROMOTION_PORT: "8082",
      KNOWLEDGE_PROMOTION_URL: "http://knowledge-worker:8082",
      SEARXNG_BASE_URL: "https://search.example.test/",
    };
    const composeEnv = readFileSync(".env.example", "utf8");
    const deployEnv = readFileSync("deploy/vennek.env.example", "utf8");
    for (const [name, value] of Object.entries(expected)) {
      expect(composeEnv).toContain(`${name}=${value}`);
      expect(deployEnv).toContain(`${name}=${value}`);
    }
  });
});
