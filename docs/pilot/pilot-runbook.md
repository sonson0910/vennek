# Pilot Runbook

## Pre-Pilot Checklist

```bash
npm test -- --run
npm run typecheck
npm run build
npm run verify:imports
npm run health
npm run validate:sources:live
npm run eval:citations
npm audit --audit-level=moderate
```

Required environment:

```bash
TELEGRAM_BOT_TOKEN=...
VENNEK_DATA_DIR=/var/lib/vennek
VENNEK_ENABLE_FIXTURES=false
```

## Run

```bash
npm run start:telegram
```

Use exactly one poller per Telegram bot token.

## Monitor

Watch JSON logs for:

- `telegram_polling_started`
- `telegram_update_processed`
- `telegram_update_skipped`
- `telegram_polling_error`
- `telegram_polling_stopped`

Check state:

```text
<VENNEK_DATA_DIR>/runtime/telegram-state.json
<VENNEK_DATA_DIR>/audit-logs/commands.jsonl
<VENNEK_DATA_DIR>/source-cache/
<VENNEK_DATA_DIR>/proof-receipts/
```

## Stop

Send `SIGTERM` through systemd/docker/process manager. Runtime uses `AbortController` and logs `telegram_polling_stopped`.

## Success Criteria

- 8 recruited pilot users.
- 5 active users after two weeks.
- 50 proposal/action analyses.
- 10 human-reviewed vote drafts.
- >=80% usefulness rating.
- >=90% sampled citation accuracy.
- 0 custody/signing/vote recommendation incidents.

## Rollback

- Stop the poller.
- Preserve `VENNEK_DATA_DIR` for audit.
- Restart last known passing build.
- If source ingestion fails, use pasted text fallback and document the limitation.
