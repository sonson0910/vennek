# Vennek

Vennek is a source-grounded Cardano Governance Copilot MVP skeleton for Catalyst reviewers and DReps.

It provides deterministic local commands for:

- `/proposal <id|url|text>`
- `/compare <id1> <id2>`
- `/vote-draft <id> <support|oppose|abstain>` (`/vote_draft` Telegram menu alias)
- `/sources <id>`
- `/proof <text>` payload-only SHA-256 metadata
- `/proof-verify <tx_hash> <expected_content_hash>` (`/proof_verify` Telegram menu alias) Blockfrost metadata verification only

## Local Run

```bash
npm install
npm test -- --run
npm run typecheck
npm run build
npm run verify:imports
npm run validate:sources
```

`npm run demo` generates an informational deterministic transcript; it is not a verification gate.

The demo and `npm run validate:sources` use offline fixtures under `samples/proposals`. For production pre-submit checks, place at least 20 real URL/text entries in `samples/proposals/live-sources.txt` or pass a custom file:

```bash
npm run validate:sources:live
npm run validate:sources:live -- --file path/to/sources.txt
```

Live source fetching is best-effort and must never fabricate data when retrieval fails. The checked-in live validation snapshot (`samples/proposals/validation-results.json`, generated 2026-07-04) passed with mixed Catalyst, governance-action/GovTool, and user-provided URL/text coverage. Operators and release runs must rerun `npm run validate:sources:live` for current source freshness, credentials, and network conditions; the snapshot is not a current-availability guarantee.

## Telegram Polling

CLI mode works without a token:

```bash
node apps/telegram-bot/dist/main.js /sources catalyst-review-workbench
```

Build before running production scripts:

```bash
npm run build
npm run health
```

Polling mode requires a deployment secret and uses Telegram long polling:

```bash
chmod 0600 /path/to/vennek.env
set -a
. /path/to/vennek.env
set +a
npm run start:telegram
```

Put `TELEGRAM_BOT_TOKEN`, `VENNEK_TELEGRAM_ALLOWED_CHAT_IDS`, and `VENNEK_DATA_DIR` in the `0600` env file; load it without echoing the token and never type a token assignment into shell history. The allowlist is required only for polling and is a comma-separated set of direct/group chat IDs. Polling fails closed when it is missing or invalid; CLI and health mode are unaffected. Unauthorized and rate-limited updates advance the offset and emit a sanitized runtime log, but do not route commands or create command audit, source-cache, or proof-receipt side effects.

Enable file-backed audit/source/proof persistence with:

```bash
chmod 0600 /path/to/vennek.env
set -a
. /path/to/vennek.env
set +a
npm run start:telegram
```

Production Telegram routes do not load demo fixtures or local files by default. Demo fixtures can be enabled explicitly for local demos with `VENNEK_ENABLE_FIXTURES=true`.

The comparison evidence section reports lexical keyword coverage only; it is not an evidence-quality score. Each source-stated claim gets a claim-level citation when a matching provenance span exists; otherwise it is marked `[source unavailable]`. Generated first-person rationale stays source-neutral.

## Safety Contract

Each source-stated claim includes its claim-level citation when a matching provenance span exists; otherwise it is marked `[source unavailable]`. Every command says `Draft analysis; human decides.` Vennek does not choose a vote stance, does not auto-vote, and does not sign or submit Cardano transactions.
