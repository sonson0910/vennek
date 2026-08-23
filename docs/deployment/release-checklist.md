# Release Checklist

Use this checklist before presenting Vennek as a pilot/staging build.

## Scope Guard

- [ ] Positioning remains: Cardano Governance Copilot for Catalyst reviewers and DReps.
- [ ] No TapTools replacement claim.
- [ ] No AI Agent OS claim.
- [ ] No runtime wallet connector, signing, auto-vote, or transaction submission.
- [ ] `/proof` remains payload-only.
- [ ] `/proof-verify` only reads externally submitted metadata through Blockfrost.

## Verification Gate

Run locally:

```bash
npm ci
npm test -- --run
npm run typecheck
npm run build
npm run verify:imports
npm run health
npm run validate:sources
npm run validate:sources:live
npm run eval:citations
npm audit --audit-level=moderate
npm audit --omit=dev --audit-level=moderate
```

Required result:

- [ ] Tests pass.
- [ ] Typecheck pass.
- [ ] Build pass.
- [ ] Package import verification pass.
- [ ] Healthcheck emits JSON.
- [ ] Mixed live source validation passes.
- [ ] Citation eval passes threshold.
- [ ] Full and production-only audits report 0 moderate+ vulnerabilities.

## Demo Transcript (Informational)

`npm run demo` generates a deterministic transcript for review. It is not a verification gate and does not replace tests, typecheck, build, health, source, citation, or audit checks.

## Staging Gate

- [ ] `TELEGRAM_BOT_TOKEN` configured in secret manager or `0600` env file.
- [ ] `VENNEK_TELEGRAM_ALLOWED_CHAT_IDS` configured as the explicit direct/group allowlist.
- [ ] `VENNEK_DATA_DIR` points to durable storage.
- [ ] `VENNEK_ENABLE_FIXTURES=false`.
- [ ] Exactly one poller per Telegram bot token.
- [ ] `npm run health` passes with staging env.
- [ ] Systemd or process supervisor restarts on failure.
- [ ] JSON logs are collected.
- [ ] Offset persists across restart.
- [ ] Allowed chat command is delivered and advances its offset.
- [ ] Rejected chat advances its offset and emits a sanitized runtime log without command routing or command audit/cache/proof side effects.
- [ ] Rate-limited chat advances its offset and emits a sanitized runtime log without command routing or command audit/cache/proof side effects.
- [ ] Permanent/exhausted delivery (“poison”) advances its offset and emits only a sanitized abandoned event; cancellation preserves the offset.

## Blockfrost Gate

- [ ] `BLOCKFROST_PROJECT_ID` configured.
- [ ] `BLOCKFROST_NETWORK` selected: `mainnet`, `preprod`, or `preview`.
- [ ] Integration test has known tx hash containing `vennek.proof.v1` metadata.
- [ ] `/proof-verify <tx_hash> <expected_content_hash>` verifies with a valid 64-hex SHA-256 expected hash.
- [ ] `/proof-verify` rejects an invalid expected hash.
- [ ] No runtime wallet/signing/submission code path exists.
- [ ] Dev-only preprod fixture script, if present, is excluded from deployed runtime and documented as non-production.

Blockfrost verification and staging smoke are credential-gated checks: run them with real `BLOCKFROST_PROJECT_ID`/Telegram staging credentials, record an explicit not-verified result when credentials are absent, and do not replace the gate with a mock.

## Pilot Gate

- [ ] Pilot participants recruited.
- [ ] `docs/pilot/onboarding.md` sent.
- [ ] `docs/pilot/demo-scenarios.md` prepared.
- [ ] `docs/pilot/feedback-form.md` ready.
- [ ] `docs/pilot/results.md` initialized.

## Release Notes

Record:

- Version/tag:
- Commit SHA:
- Verification command output summary:
- Known limitations:
- Rollback plan:
