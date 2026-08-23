import type { CommandContext } from "@vennek/shared";
import { parseAllowedChatIds } from "./accessControl.js";
import { createTelegramApi, runPolling, type RuntimeLogLevel } from "./pollingRuntime.js";
import { routeTelegramText } from "./router.js";
import { validateRuntimeState } from "./runtimeState.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--health")) {
    const state = validateRuntimeState(process.env.VENNEK_DATA_DIR);
    logJson("info", "healthcheck", { ok: true, persistenceEnabled: Boolean(process.env.VENNEK_DATA_DIR), offset: state.offset });
    return;
  }

  if (args.includes("--poll")) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      throw new Error("TELEGRAM_BOT_TOKEN is required when --poll is passed.");
    }
    const allowedChatIds = parseAllowedChatIds(process.env.VENNEK_TELEGRAM_ALLOWED_CHAT_IDS);

    const controller = new AbortController();
    const stop = (): void => controller.abort();
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    try {
      await runPolling({
        api: createTelegramApi(token, controller.signal),
        allowedChatIds,
        context: runtimeContext(),
        logger: (level, event, fields) => logJson(level, event, fields),
        signal: controller.signal
      });
    } finally {
      process.off("SIGTERM", stop);
      process.off("SIGINT", stop);
    }
    return;
  }

  const input = args.join(" ").trim() || "/proposal catalyst-review-workbench";
  const output = await routeTelegramText(input, runtimeContext());
  console.log(output);
}

function runtimeContext(): CommandContext {
  return {
    persistenceRoot: process.env.VENNEK_DATA_DIR,
    enableFixtures: process.env.VENNEK_ENABLE_FIXTURES === "true",
    blockfrostProjectId: process.env.BLOCKFROST_PROJECT_ID,
    blockfrostNetwork: parseBlockfrostNetwork(process.env.BLOCKFROST_NETWORK)
  };
}

function parseBlockfrostNetwork(value: string | undefined): CommandContext["blockfrostNetwork"] {
  return value === "preprod" || value === "preview" || value === "mainnet" ? value : undefined;
}

function logJson(level: RuntimeLogLevel, event: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ level, event, timestamp: new Date().toISOString(), ...fields });
  if (level === "error") {
    console.error(line);
    return;
  }
  console.log(line);
}

main().catch((error) => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const message = error instanceof Error ? error.message : String(error);
  console.error(token ? message.replaceAll(token, "[redacted]") : message);
  process.exitCode = 1;
});
