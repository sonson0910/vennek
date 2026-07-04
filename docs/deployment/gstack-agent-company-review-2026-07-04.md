# GStack Agent Company Review — Vennek

Date: 2026-07-04T12:58:59Z
Repo: `sonson0910/vennek`
Local path: `/mnt/Projects/elly_code/vennek`

## Scope

Run a gstack-style "agent company" pass over Vennek after the initial GitHub push:

- CEO / Product / Funding lens
- Engineering Manager / QA lens
- CSO / Release lens
- Documentation lens
- Live staging verification

This review treats Vennek as a Cardano governance copilot for Catalyst reviewers and DReps. It does not inspect or print secrets.

## Executive verdict

**Status: PASS WITH FOLLOW-UPS**

Vennek is coherent enough for a technical MVP and early pilot demo:

- Telegram bot is running.
- Blockfrost preprod is configured.
- Proof fixture verifies against a real preprod transaction.
- CI, tests, typecheck, build, audit, and staging smoke pass.
- No secret material was committed in this review.

The main remaining product gap is not code: Vennek still needs real reviewer/DRep pilot feedback, time-saved metrics, and human citation-quality sampling before it should claim funding-grade traction.

## Company-role findings

| Role | Verdict | Findings | Action taken |
|---|---|---|---|
| CEO / Product | Pass with pilot gap | Positioning is clear: governance decision-support, not trading analytics. Biggest gap is evidence of real users and measurable workflow improvement. | No code change. Captured follow-up: run 1-3 pilot users and collect metrics. |
| Engineering Manager | Pass with fixes | Router supported hyphen commands, while Telegram BotFather menu uses underscore commands. This made menu-selected `/vote_draft` and `/proof_verify` likely fail. | Added underscore aliases and tests. |
| QA | Pass with fixes | Proof UX had a hash-format footgun: local `/proof` emits `sha256:<hex>`, while on-chain fixture stores bare 64-byte hex due Cardano metadata text size. | Normalized `sha256:` prefixes during verification and added regression test. |
| CSO | Pass with fixes | Runtime polling error logs could preserve token-like strings from thrown errors. | Added runtime error sanitization and regression test. |
| Release / Ops | Pass with fixes | Restart logged an expected abort as an error during shutdown. | Suppressed abort-triggered polling errors and restarted service cleanly. |
| Docs | Pass with fixes | README/PRD did not explain Telegram underscore aliases. | Updated README and PRD. |

## Fixes applied

### 1. Telegram command menu aliases

Files:

- `apps/telegram-bot/src/router.ts`
- `tests/router.test.ts`
- `README.md`
- `docs/product/PRD.md`

Change:

- `/vote_draft` now routes to the same implementation as `/vote-draft`.
- `/proof_verify` now routes to the same implementation as `/proof-verify`.

Reason:

Telegram BotFather command menu names cannot contain hyphens, but the product docs and internal CLI-style command names used hyphens. Supporting both keeps CLI/docs readable and Telegram UX functional.

### 2. Proof hash normalization

Files:

- `packages/cardano-governance-skills/src/adapters/blockfrost.ts`
- `tests/blockfrost.test.ts`

Change:

- Expected and on-chain `content_hash` values are compared after stripping an optional `sha256:` prefix.

Reason:

The local proof payload uses `sha256:<hex>`. The preprod metadata fixture uses bare hex because Cardano metadata text chunks have a practical 64-byte limit for this fixture. Users copying either form should get the same verification result when the underlying digest matches.

### 3. Polling runtime log redaction

Files:

- `apps/telegram-bot/src/pollingRuntime.ts`
- `tests/pollingRuntime.test.ts`

Change:

- Polling runtime errors are sanitized before logging.
- Token-like values and `token <value>` patterns are redacted.

Reason:

Operational logs should not preserve token-like material if an upstream error message includes it.

### 4. Clean shutdown logging

File:

- `apps/telegram-bot/src/pollingRuntime.ts`

Change:

- If the abort signal is already set, polling exits the loop instead of logging the expected abort as `telegram_polling_error`.

Reason:

Service restarts should not look like runtime incidents.

### 5. Follow-up subagent findings absorbed

Additional gstack company reviewers finished after the first patch landed. Their findings were triaged and the following fixes were applied:

- Arbitrary remote URL fetching is now allowlist-gated; untrusted sources should be pasted as text. This reduces SSRF/DNS-rebinding risk for attacker-controlled domains.
- `npm run staging:smoke` now verifies `VENNEK_DATA_DIR` is writable, not merely configured.
- `deploy/vennek.env.example` now matches the system service sandbox path: `/var/lib/vennek`.
- The dev-only preprod transaction fixture script is documented as a non-production exception to the no-custody runtime policy.
- `SECURITY.md` and `.github/dependabot.yml` were added for vulnerability reporting and dependency/action update automation.

## Verification evidence

Commands run locally:

```text
npm test -- --run
npm run typecheck
npm run build
npm audit --audit-level=moderate
npm run staging:smoke
systemctl --user restart vennek-telegram.service
systemctl --user is-active vennek-telegram.service
```

Results:

```text
Test Files: 13 passed, 1 skipped
Tests: 51 passed, 1 skipped
Typecheck: pass
Build: pass
npm audit: 0 vulnerabilities
Staging smoke: pass
Telegram service: active
```

Staging smoke details:

```text
PASS VENNEK_DATA_DIR
PASS telegram.getMe
PASS blockfrost.latestBlock
PASS blockfrost.proofFixture
```

## Current known limitations

These are not blockers for the technical MVP, but they are blockers for stronger product/funding claims:

1. **No real pilot evidence yet** — `docs/pilot/results.md` still needs actual reviewer/DRep runs.
2. **Citation quality is fixture-tested, not human-sampled at scale** — keep claims modest until real samples are reviewed.
3. **No production monitoring beyond systemd/journal smoke** — add uptime/alerting before calling this production-grade.
4. **No PR-based release discipline yet** — repo was pushed directly to `main`; future changes should use PRs once the repo matures.
5. **Live Blockfrost integration is env-gated** — CI can run deterministic checks, but real proof verification depends on configured secrets/vars.

## Recommended next steps

1. Run a real Telegram demo with these menu-compatible commands:
   - `/proposal catalyst-review-workbench`
   - `/compare catalyst-review-workbench drep-rationale-kit`
   - `/vote_draft drep-rationale-kit abstain`
   - `/sources catalyst-review-workbench`
   - `/proof <rationale text>`
   - `/proof_verify <tx_hash> <content_hash>`
2. Invite 1-3 Catalyst reviewers or DReps for a pilot.
3. Track:
   - time saved per review;
   - citation precision/recall sampled by humans;
   - rationale quality feedback;
   - confusing UX moments;
   - commands users actually repeat.
4. Add repo secrets/vars for live validation only if desired:
   - `BLOCKFROST_PROJECT_ID` as a secret;
   - `BLOCKFROST_NETWORK`, `BLOCKFROST_TEST_TX_HASH`, `BLOCKFROST_TEST_CONTENT_HASH` as vars.

## Final status

**GStack company pass completed.**

The repo is stronger after this pass: Telegram command UX, proof verification UX, runtime logging, docs, tests, build, audit, staging smoke, and service restart are all verified.
