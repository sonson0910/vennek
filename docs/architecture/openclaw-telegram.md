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

For a minimal production polling process, set the bot token in deployment secrets and pass `--poll`:

```bash
TELEGRAM_BOT_TOKEN=... npx tsx apps/telegram-bot/src/main.ts --poll
```

The process uses Telegram `getUpdates` long polling with native `fetch`, routes text messages through `routeTelegramText`, and replies with `sendMessage`. Keep `TELEGRAM_BOT_TOKEN` in the process environment or secret manager only; do not commit or print it. Run one poller instance per bot token so Telegram offsets stay coherent.

Production binding still needs:

- source cache persistence;
- live source validation policy;
- optional external transaction indexer for proof verification.
