# Telegram Runtime Deployment

This is the minimal production runtime path for the Vennek Telegram bot.

## Required Secrets

```bash
TELEGRAM_BOT_TOKEN=...
VENNEK_TELEGRAM_ALLOWED_CHAT_IDS=12345,-1001234567890
VENNEK_DATA_DIR=/var/lib/vennek
```

`VENNEK_TELEGRAM_ALLOWED_CHAT_IDS` is required only in polling mode and is a comma-separated allowlist of direct and approved group chat IDs. Polling startup fails closed when it is absent or invalid; CLI and `--health` are unaffected.

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
TELEGRAM_BOT_TOKEN=... VENNEK_TELEGRAM_ALLOWED_CHAT_IDS=12345,-1001234567890 VENNEK_DATA_DIR=/var/lib/vennek node apps/telegram-bot/dist/main.js --poll
```

Runtime behavior:

- reads last Telegram offset from `<VENNEK_DATA_DIR>/runtime/telegram-state.json`;
- writes offset atomically after each skipped or successfully processed update;
- requires the chat allowlist before routing, fetching, Blockfrost access, or persistence;
- applies an in-memory per-chat limit of 10 updates per 60 seconds;
- unauthorized and rate-limited updates advance the offset without routing or side effects;
- delivers with at most 3 send-only attempts; HTTP 429 is retryable, while permanent HTTP 4xx errors except 429 or an exhausted retry budget produce a sanitized `telegram_delivery_abandoned` event and advance the offset;
- cancellation during delivery/retry preserves the offset; a send that resolves successfully is committed even if cancellation arrives immediately afterward;
- logs structured JSON events with hashed chat IDs, not raw message text;
- abandoned-event logs contain no raw message text, and there is no persistent dead-letter queue;
- handles `SIGTERM`/`SIGINT` via `AbortController` and abortable sleep;
- keeps command persistence fail-open so user responses are not blocked by audit-store failures.

## Source Boundaries

- Remote source fetching requires HTTPS, a strict allowed MIME type, and a streaming 2 MiB byte cap.
- Optional local file imports canonicalize the allowed root and target, reject symlinks, outside-root/non-regular files, oversized files, and invalid `ProposalDocument` schemas. Production Telegram keeps local files disabled.

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
