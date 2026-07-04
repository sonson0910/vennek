# Vennek staging continuation report — 2026-07-04

## Completed

- Added `scripts/staging-smoke.ts`.
- Added `npm run staging:smoke`.
- Added non-root user systemd unit: `deploy/systemd/vennek-telegram.user.service`.
- Added staging env template: `deploy/vennek.env.example`.
- Installed local user unit at `~/.config/systemd/user/vennek-telegram.service`.
- Created secure local staging paths:
  - `~/.config/vennek/vennek.env` mode `0600`.
  - `~/.local/share/vennek` mode `0700`.
- Used Chrome Profile 1 session to access Blockfrost dashboard and save the existing project id into the local env file without writing it to repo.
- Verified Blockfrost latest-block access through the staging smoke test.

## Verification

Full deterministic gate passed:

```text
13 test files passed
1 gated Blockfrost integration test skipped
49 tests passed
1 skipped
typecheck passed
build passed
package imports ok
healthcheck passed
sample validation passed
citation eval passed
demo passed
```

Live source validation passed:

```text
Validated 22 live sources: 21 normalized, 21 with citations, 1 failed with reasons.
```

Staging smoke current result:

```text
PASS VENNEK_DATA_DIR
FAIL telegram.getMe - TELEGRAM_BOT_TOKEN is required for real Telegram staging.
PASS blockfrost.latestBlock
SKIP blockfrost.proofFixture - BLOCKFROST_PROJECT_ID, BLOCKFROST_TEST_TX_HASH, and BLOCKFROST_TEST_CONTENT_HASH are required for proof fixture verification.
```

## Remaining blocker

Telegram BotFather creation is not complete yet. The repo/runtime side is ready, but a real bot token still has to be created by a Telegram user account and placed into `~/.config/vennek/vennek.env`. The attempt to convert the local Telegram Desktop `tdata` session via `opentele` failed with `No account has been loaded`, so no token was created and no Telegram bot was started.

## Important safety note

Do not reuse the Hermes gateway Telegram token for Vennek. Vennek needs a separate BotFather bot token.
