# Vennek Telegram bot staging — 2026-07-04

## Bot

- Username: `@cardano_claw_bot`
- Link: https://t.me/cardano_claw_bot
- Bot ID: `8948172528`
- First name: `cardano_agent`
- Can join groups: `true`
- Can read all group messages: `false`

The bot token is stored only in the local staging env file and is intentionally not recorded in this report.

## Local staging config

- Env file: `/home/son/.config/vennek/vennek.env` (`0600`)
- Data dir: `/home/son/.local/share/vennek` (`0700`)
- User systemd service: `/home/son/.config/systemd/user/vennek-telegram.service`

## Verification

`npm run staging:smoke` passed the configured checks:

```text
PASS VENNEK_DATA_DIR
PASS telegram.getMe
PASS blockfrost.latestBlock
SKIP blockfrost.proofFixture - BLOCKFROST_PROJECT_ID, BLOCKFROST_TEST_TX_HASH, and BLOCKFROST_TEST_CONTENT_HASH are required for proof fixture verification.
```

The service is running:

```text
Active: active (running)
Exec: node apps/telegram-bot/dist/main.js --poll
Log: telegram_polling_started
```

## Bot profile

Set via Telegram Bot API:

- Commands: `/proposal`, `/compare`, `/vote_draft`, `/sources`, `/proof`, `/proof_verify`
- Short description: `Cardano governance copilot with citations. Human decides.`
- Description: `Vennek/Cardano Claw governance copilot for cited proposal analysis, comparisons, vote rationale drafts, source audits, and optional proof verification. Human decides.`
