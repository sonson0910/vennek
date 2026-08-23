# OpenClaw / Telegram Demo Notes

The MVP exposes a router that can be bound to Telegram or OpenClaw:

```ts
import { routeTelegramText } from "@vennek/telegram-bot";

const response = await routeTelegramText("/proposal catalyst-review-workbench");
```

## CLI Mode

CLI mode does not require a token and remains useful for smoke checks:

```bash
npx tsx apps/telegram-bot/src/main.ts /proposal catalyst-review-workbench
```

## Telegram Polling

For a minimal production polling process, set the bot token and allowlist in deployment secrets and pass `--poll`:

```bash
TELEGRAM_BOT_TOKEN=... VENNEK_TELEGRAM_ALLOWED_CHAT_IDS=12345,-1001234567890 npx tsx apps/telegram-bot/src/main.ts --poll
```

`VENNEK_TELEGRAM_ALLOWED_CHAT_IDS` is required only for polling, uses comma-separated direct/group chat IDs, and fails closed when missing or invalid. CLI and `--health` are unaffected. The process uses Telegram `getUpdates` long polling with native `fetch`, routes authorized text messages through `routeTelegramText`, and replies with `sendMessage`. Keep `TELEGRAM_BOT_TOKEN` and the allowlist in the process environment or secret manager only; do not commit or print secrets. Run one poller instance per bot token so Telegram offsets stay coherent.

Credential-gated staging and operational limits remain:

- a real Telegram bot token and staging environment;
- a real Blockfrost project ID and known proof transaction for `/proof-verify` staging verification;
- service supervision and monitoring of structured runtime logs and persisted offsets.
