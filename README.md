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
npm run demo
```

The demo and `npm run validate:sources` use offline fixtures under `samples/proposals`. For production pre-submit checks, place at least 20 real URL/text entries in `samples/proposals/live-sources.txt` or pass a custom file:

```bash
npm run validate:sources:live
npm run validate:sources:live -- --file path/to/sources.txt
```

Live source fetching is best-effort and must never fabricate data when retrieval fails. Current live validation covers Catalyst URLs; add GovTool/governance-action and user-provided fallback coverage before production/funding claims.

## Telegram Polling

CLI mode works without a token:

```bash
npx tsx apps/telegram-bot/src/main.ts /sources catalyst-review-workbench
```

Build before running production scripts:

```bash
npm run build
npm run health
```

Polling mode requires a deployment secret and uses Telegram long polling:

```bash
TELEGRAM_BOT_TOKEN=... VENNEK_TELEGRAM_ALLOWED_CHAT_IDS=12345,-1001234567890 npx tsx apps/telegram-bot/src/main.ts --poll
```

`VENNEK_TELEGRAM_ALLOWED_CHAT_IDS` is required only for polling and is a comma-separated allowlist of direct/group chat IDs. Polling fails closed when it is missing or invalid; CLI and health mode are unaffected. Production polling does not route unauthorized or rate-limited updates.

Enable file-backed audit/source/proof persistence with:

```bash
VENNEK_DATA_DIR=./data TELEGRAM_BOT_TOKEN=... VENNEK_TELEGRAM_ALLOWED_CHAT_IDS=12345,-1001234567890 npx tsx apps/telegram-bot/src/main.ts --poll
```

Production Telegram routes do not load demo fixtures or local files by default. Demo fixtures can be enabled explicitly for local demos with `VENNEK_ENABLE_FIXTURES=true`.

The comparison evidence section reports lexical keyword coverage only; it is not an evidence-quality score. Source-stated claims are rendered as quoted/sourced text with claim-level citations, while generated first-person rationale stays source-neutral.

## Safety Contract

All sourced command outputs must include citations or explicit source-unavailable status. Every command says `Draft analysis; human decides.` Vennek does not choose a vote stance, does not auto-vote, and does not sign or submit Cardano transactions.
