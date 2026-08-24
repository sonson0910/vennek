import { spawnSync } from "node:child_process";
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
      }>;
    };
    const appServices = ["migrate", "provision-app-role", "telegram-webhook", "agent-worker"];
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
    for (const name of [
      "VENNEK_ENCRYPTION_KEY",
      "LITELLM_BASE_URL",
      "LITELLM_API_KEY",
      "VENNEK_MODEL_FAST",
      "VENNEK_MODEL_QUALITY",
      "VENNEK_MODEL_VERIFIER",
      "TELEGRAM_BOT_TOKEN",
    ]) {
      expect(webhookEnvironment?.[name]).toBeUndefined();
    }
    expect(workerEnvironment?.TELEGRAM_WEBHOOK_SECRET).toBeUndefined();
    expect(config.services["telegram-webhook"]?.environment?.PORT).toBe("8080");
    expect(config.services["telegram-webhook"]?.ports).toHaveLength(1);
    expect(config.services["telegram-webhook"]?.ports).toContainEqual(expect.objectContaining({
      host_ip: "127.0.0.1",
      target: 8080,
      published: "9090",
    }));
    expect(config.services["telegram-webhook"]?.healthcheck?.test?.join(" ")).toContain("127.0.0.1:8080");
    for (const name of ["telegram-webhook", "agent-worker"]) {
      expect(config.services[name]?.environment?.DATABASE_OWNER_URL).toBeUndefined();
    }
  });
});
