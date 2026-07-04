# Release Checklist

Use this checklist before presenting Vennek as a pilot/staging build.

## Scope Guard

- [ ] Positioning remains: Cardano Governance Copilot for Catalyst reviewers and DReps.
- [ ] No TapTools replacement claim.
- [ ] No AI Agent OS claim.
- [ ] No wallet connector, signing, auto-vote, or transaction submission.
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
npm run demo
npm audit --audit-level=moderate
```

Required result:

- [ ] Tests pass.
- [ ] Typecheck pass.
- [ ] Build pass.
- [ ] Package import verification pass.
- [ ] Healthcheck emits JSON.
- [ ] Mixed live source validation passes.
- [ ] Citation eval passes threshold.
- [ ] Demo smoke test passes.
- [ ] Audit reports 0 moderate+ vulnerabilities.

## Staging Gate

- [ ] `TELEGRAM_BOT_TOKEN` configured in secret manager or `0600` env file.
- [ ] `VENNEK_DATA_DIR` points to durable storage.
- [ ] `VENNEK_ENABLE_FIXTURES=false`.
- [ ] Exactly one poller per Telegram bot token.
- [ ] `npm run health` passes with staging env.
- [ ] Systemd or process supervisor restarts on failure.
- [ ] JSON logs are collected.
- [ ] Offset persists across restart.

## Blockfrost Gate

- [ ] `BLOCKFROST_PROJECT_ID` configured.
- [ ] `BLOCKFROST_NETWORK` selected: `mainnet`, `preprod`, or `preview`.
- [ ] Integration test has known tx hash containing `vennek.proof.v1` metadata.
- [ ] `/proof-verify` verifies expected content hash.
- [ ] No wallet/signing/submission code path exists.

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
