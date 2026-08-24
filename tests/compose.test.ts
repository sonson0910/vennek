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
      { cwd: process.cwd(), encoding: "utf8" },
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
    expect(config.services["agent-worker"]?.environment?.TELEGRAM_WEBHOOK_SECRET).toBe(
      "replace-with-at-least-32-url-safe-characters",
    );
    expect(config.services["telegram-webhook"]?.environment?.PORT).toBe("8080");
    expect(config.services["telegram-webhook"]?.ports).toContainEqual(expect.objectContaining({
      host_ip: "127.0.0.1",
      target: 8080,
      published: "8080",
    }));
    expect(config.services["telegram-webhook"]?.healthcheck?.test?.join(" ")).toContain("127.0.0.1:8080");
    for (const name of ["telegram-webhook", "agent-worker"]) {
      expect(config.services[name]?.environment?.DATABASE_OWNER_URL).toBeUndefined();
    }
  });
});
