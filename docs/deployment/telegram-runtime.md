# Telegram Runtime Deployment

This is the minimal production runtime path for the Vennek Telegram bot.

## Required Secrets

Store these values in an environment file with mode `0600` (for example `/etc/vennek/vennek.env`):

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

From the repository after `npm run build`, load the `0600` environment file without echoing it and start the built runtime:

```bash
chmod 0600 /etc/vennek/vennek.env
set -a
. /etc/vennek/vennek.env
set +a
npm run start:telegram
```

Never put a `TELEGRAM_BOT_TOKEN` assignment in a shell command or history. For service-managed staging, use the systemd unit below with the same mode-`0600` `EnvironmentFile`.

Runtime behavior:

- reads last Telegram offset from `<VENNEK_DATA_DIR>/runtime/telegram-state.json`;
- writes offset atomically after each skipped or successfully processed update;
- requires the chat allowlist before routing, fetching, Blockfrost access, or persistence;
- applies an in-memory per-chat limit of 10 updates per 60 seconds;
- unauthorized and rate-limited updates write the offset and a sanitized runtime log, but do not route a command or create command audit, source-cache, or proof-receipt side effects;
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
chmod 0600 ~/.config/vennek/vennek.env
set -a
. ~/.config/vennek/vennek.env
set +a
npm run staging:smoke
```

This loads the token without echoing it; never place a token assignment in the command line or shell history.

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
