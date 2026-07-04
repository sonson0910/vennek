# Telegram Runtime Deployment

This is the minimal production runtime path for the Vennek Telegram bot.

## Required Secrets

```bash
TELEGRAM_BOT_TOKEN=...
VENNEK_DATA_DIR=/var/lib/vennek
```

Optional local demo mode:

```bash
VENNEK_ENABLE_FIXTURES=true
```

Do not enable fixtures in production.

## Healthcheck

```bash
node apps/telegram-bot/dist/main.js --health
```

Expected JSON log:

```json
{"level":"info","event":"healthcheck","ok":true}
```

## Start Polling

```bash
TELEGRAM_BOT_TOKEN=... VENNEK_DATA_DIR=/var/lib/vennek node apps/telegram-bot/dist/main.js --poll
```

Runtime behavior:

- reads last Telegram offset from `<VENNEK_DATA_DIR>/runtime/telegram-state.json`;
- writes offset atomically after each skipped or successfully processed update;
- does not advance offset when `sendMessage` fails;
- logs structured JSON events with hashed chat IDs, not raw message text;
- handles `SIGTERM`/`SIGINT` via `AbortController` and abortable sleep;
- keeps command persistence fail-open so user responses are not blocked by audit-store failures.

## State Files

```text
<VENNEK_DATA_DIR>/
  runtime/telegram-state.json
  audit-logs/commands.jsonl
  source-cache/*.json
  proof-receipts/*.json
```

File permissions:

```text
directories: 0700
files:       0600
```

## Systemd Example

Use `deploy/systemd/vennek-telegram.service` for a system service or `deploy/systemd/vennek-telegram.user.service` for a non-root user staging service. Put secrets in an EnvironmentFile such as `/etc/vennek/vennek.env` or `~/.config/vennek/vennek.env` with mode `0600`.

## Staging Smoke Test

Before starting the poller, run:

```bash
set -a
. ~/.config/vennek/vennek.env
set +a
npm run staging:smoke
```

The smoke test verifies:

- `VENNEK_DATA_DIR` is configured;
- Telegram token is accepted by `getMe` without printing the token;
- Blockfrost project id can read the latest block without printing the key;
- optional proof fixture tx verifies when `BLOCKFROST_TEST_TX_HASH` and `BLOCKFROST_TEST_CONTENT_HASH` are present.

## Operational Notes

- Long polling is acceptable for MVP/pilot. Webhook mode can come later.
- Monitor stderr/stdout JSON logs.
- Back up `VENNEK_DATA_DIR` if audit/source/proof history matters.
- Rotate `commands.jsonl` or migrate to SQLite/Postgres before high-volume production.
