# Vennek Implementation Report

Generated: 2026-07-04
Updated: 2026-07-04 supervisor hardening pass

## Scope Implemented

- Phase 0 sample-mode source validation skeleton.
- Phase 0 hardening: live source validation input file, failure recording, production threshold, and optional report writing.
- Phase 1 core TypeScript governance skill pack.
- Phase 2 deterministic Telegram/OpenClaw-compatible demo router plus optional Telegram long polling.
- P0 commands:
  - `/proposal`
  - `/compare`
  - `/vote-draft`
  - `/sources`
- P1 safe subset:
  - `/proof` payload-only hash + metadata generation.
  - `/proof-verify` Blockfrost metadata verification for externally submitted txs.

## Key Files

- `packages/shared/src/types.ts`
- `packages/shared/src/citations.ts`
- `packages/shared/src/hashing.ts`
- `packages/cardano-governance-skills/src/commands/*`
- `packages/cardano-governance-skills/src/adapters/*`
- `packages/cardano-governance-skills/src/adapters/blockfrost.ts`
- `packages/cardano-governance-skills/src/safety/outputGuards.ts`
- `packages/cardano-governance-skills/src/store/documentStore.ts`
- `apps/telegram-bot/src/router.ts`
- `apps/telegram-bot/src/main.ts`
- `apps/telegram-bot/src/pollingRuntime.ts`
- `apps/telegram-bot/src/runtimeState.ts`
- `packages/cardano-governance-skills/src/persistence/fileStore.ts`
- `scripts/validate-data-sources.ts`
- `scripts/run-demo.ts`
- `samples/proposals/*`
- `samples/citation-eval-fixtures.json`
- `docs/product/*`
- `docs/architecture/*`
- `docs/deployment/*`
- `docs/demo/*`
- `docs/funding/*`
- `docs/pilot/*`
- `.github/workflows/*`

## Verification

| Command | Status | Notes |
|---|---:|---|
| `npm install --package-lock-only` | Pass | Lockfile/package metadata updated; 0 vulnerabilities reported. |
| `npm test -- --run` | Pass | 13 test files passing + 1 gated Blockfrost integration test skipped without env; 49 tests passed, 1 skipped. |
| `npm run typecheck` | Pass | TypeScript strict check passes. |
| `npm run build` | Pass | Emits package `dist/` builds for Node runtime usage. |
| `npm run verify:imports` | Pass | Native Node imports for `@vennek/shared`, `@vennek/cardano-governance-skills`, and `@vennek/telegram-bot` work after build. |
| `npm run health` | Pass | Built Telegram runtime emits JSON healthcheck. |
| `npm run validate:sources` | Pass | 20/20 sample sources normalized with citations; writes report only because npm script passes `--write-report`. |
| `npm run validate:sources:live` | Pass | 22 live entries: 14 Catalyst, 5 governance-action/GovTool docs, 2 user-provided fallback texts, 1 expected failure with reason; 21 normalized with citations. |
| `npm run eval:citations` | Pass | 5/5 citation support fixtures pass, 100% against 90% threshold; additional human-eval fixture template added for pilot sampling. |
| `npm run demo` | Pass | Runs `/proposal`, `/compare`, `/vote-draft`, `/sources`, `/proof`. |
| `npm audit --audit-level=moderate` | Pass | 0 vulnerabilities. |

## Security Hardening Added

- Telegram command routing defaults to `enableFixtures: false` and `allowLocalFiles: false` so production chat input cannot silently load demo fixtures or local JSON files.
- Local file resolution requires both `allowLocalFiles: true` and an `allowedFileRoot`; paths must resolve inside that root.
- Remote URL fetching now requires HTTPS, rejects credentials in URLs, rejects private/loopback/link-local/multicast/reserved IPs after DNS resolution, rejects unsupported content types, disables redirects, uses an 8s timeout, and enforces a 2 MiB body cap.
- Catalyst/GovTool URL detection now uses exact/safe-subdomain allowlists instead of substring matching.
- Telegram truncation now calculates the suffix exactly and preserves the `Citations:` section where possible.
- Output guard coverage expanded for wallet connector, connect-wallet, transaction submission, funds sending, trading/investment advice, auto-sign, auto-vote, seed phrase, and private key phrases.
- File-backed audit/source/proof persistence added behind `VENNEK_DATA_DIR`; command logs store hashes/redacted previews, source cache stores normalized documents, proof receipts remain payload-only, store directories are `0700`, and files are `0600`.
- Telegram runtime now persists long-polling update offset, handles `SIGTERM`/`SIGINT` through `AbortController`, emits structured JSON logs with hashed chat IDs, exposes a built `--health` command, and has fake-API polling tests for offset advance/send-fail behavior.

## Safety Status

- Sourced outputs include citations or explicit `Source unavailable`.
- All command outputs include `Draft analysis; human decides.`
- `/vote-draft` rejects missing/invalid stance and only drafts for `support`, `oppose`, or `abstain`.
- No wallet connector, signing library, private-key handling, auto-vote, trading, analytics dashboard, Masumi integration, or Aiken contract code was added.
- `/proof` only generates local SHA-256 metadata payload and returns pending/failed status for external tx hash format checks.
- `/proof-verify` reads externally submitted transaction metadata through Blockfrost when configured; it does not sign, submit, or construct transactions.
- `tests/blockfrost.integration.test.ts` is gated by `BLOCKFROST_PROJECT_ID`, `BLOCKFROST_TEST_TX_HASH`, and `BLOCKFROST_TEST_CONTENT_HASH`; it skips in normal CI and can verify a real `vennek.proof.v1` transaction in staging.
- CI workflows added: deterministic PR/push gate and separate scheduled/manual live validation gate.
- Telegram polling redacts token values from handled error messages and does not print secrets.

## Remaining Production Blockers

- Live validation now covers Catalyst, GovTool/governance-action documentation, user-provided fallback text, and expected failure handling.
- Citation quality has a deterministic fixture eval (`npm run eval:citations`), but production should still add human-sampled citation accuracy checks and/or a retrieval eval set.
- Telegram production binding needs a real bot token, process supervision, service monitoring, and operational runbook validation.
- Source cache and command audit logs now have an opt-in file-backed MVP store; high-availability production should still migrate to SQLite/Postgres with retention, backups, and monitoring.
- CI/release discipline is now documented and configured; real repository protection must be enabled on the hosting platform.
- Blockfrost proof verification adapter is mocked/tested and has a gated live integration test; real staging still needs a valid Blockfrost project ID and a transaction containing `vennek.proof.v1` metadata.
- Heuristic analysis is deterministic and testable, but not a full LLM retrieval pipeline.

## Next Steps

- Run real Telegram staging with `TELEGRAM_BOT_TOKEN`, `VENNEK_DATA_DIR`, systemd, restart, health, and log checks.
- Run gated Blockfrost integration with a real project id and known `vennek.proof.v1` testnet/mainnet transaction.
- Pilot with Catalyst reviewers/DReps and measure citation accuracy/usefulness.
