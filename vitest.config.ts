import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    fileParallelism: process.env.TEST_DATABASE_URL === undefined && process.env.TEST_DATABASE_OWNER_URL === undefined
  },
  resolve: {
    alias: {
      "@vennek/shared": new URL("./packages/shared/src/index.ts", import.meta.url).pathname,
      "@vennek/cardano-governance-skills": new URL("./packages/cardano-governance-skills/src/index.ts", import.meta.url).pathname,
      "@vennek/cardano-agent": new URL("./packages/cardano-agent/src/index.ts", import.meta.url).pathname,
      "@vennek/telegram-bot": new URL("./apps/telegram-bot/src/index.ts", import.meta.url).pathname
    }
  }
});
