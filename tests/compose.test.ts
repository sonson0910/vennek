import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dockerCompose = spawnSync("docker", ["compose", "version"], {
  cwd: process.cwd(),
  encoding: "utf8",
});
const hasDockerCompose = dockerCompose.status === 0;

describe.skipIf(!hasDockerCompose)("rendered Compose contract", () => {
  it("uses one app image and keeps runtime boundaries fixed", () => {
    const result = spawnSync(
      "docker",
      ["compose", "--env-file", ".env.example", "config", "--format", "json"],
      { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, WEBHOOK_PORT: "9090" } },
    );
    expect(result.status).toBe(0);

    const config = JSON.parse(result.stdout) as {
      services: Record<string, {
        build?: unknown;
        image?: string;
        environment?: Record<string, string | null>;
        ports?: Array<{ host_ip?: string; target?: number; published?: string }>;
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
    for (const name of [
      "VENNEK_ENCRYPTION_KEY",
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
    for (const name of ["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "VENNEK_ENCRYPTION_KEY", "VENNEK_MODEL_FAST", "VENNEK_MODEL_QUALITY", "VENNEK_MODEL_VERIFIER", "DATABASE_OWNER_URL"]) {
      expect(knowledgeEnvironment?.[name]).toBeUndefined();
    }
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
    expect(config.services["agent-worker"]?.networks).toEqual({ default: null });
    expect(config.services["knowledge-worker"]?.networks).toEqual({ default: null, "pdf-sandbox": null });
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
