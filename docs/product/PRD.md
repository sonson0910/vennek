# Vennek PRD

## Product

Vennek is a source-grounded Cardano governance analysis assistant for Catalyst reviewers and DReps.

## MVP Users

- Catalyst reviewers comparing proposal evidence.
- DReps drafting transparent governance rationale.

## P0 Commands

- `/proposal <url_or_text_or_id>` summarizes problem, requested funding/action, impact, feasibility, risks, missing evidence, and citations.
- `/compare <id1> <id2>` compares two proposal documents with a fixed rubric: impact, feasibility, budget/resources, lexical evidence signals, and risk. Evidence signals are keyword coverage only, not evidence quality or a score.
- `/vote-draft <id> <support|oppose|abstain>` drafts wording for the human-selected stance only. Telegram's command menu also exposes `/vote_draft` because BotFather command names cannot contain hyphens.
- `/sources <id>` lists source URLs, snippets, retrieval timestamp, and cache/source status.

## P1 Included in Skeleton

- `/proof <text>` generates SHA-256 content hash and `vennek.proof.v1` metadata payload only.
- `/proof-verify <tx_hash> <expected_content_hash>` verifies externally submitted `vennek.proof.v1` metadata through Blockfrost when configured. Telegram's command menu also exposes `/proof_verify` because BotFather command names cannot contain hyphens.

## Non-Goals

No wallet risk, analytics dashboard, trading, Masumi integration, Aiken contracts, automatic voting, automatic signing, wallet connector, or key handling.

## Acceptance

- `npm test -- --run`, `npm run typecheck`, `npm run build`, and `npm run verify:imports` pass.
- `npm audit --audit-level=moderate` reports 0 vulnerabilities.
- Sample source validation passes with >=20 fixtures and >=15 normalized/cited documents.
- Live source validation must pass with current operator-provided sources covering Catalyst, governance-action/GovTool, and user-provided URL/text fallback plus an expected failure with a reason. The checked-in snapshot (`samples/proposals/validation-results.json`, generated 2026-07-04) passed this mixed-coverage gate; operators and release runs must rerun `npm run validate:sources:live` for current source freshness, credentials, and network conditions.
- Each source-stated claim renders as quoted/sourced text with a claim-level citation when a matching provenance span exists; otherwise it is marked `[source unavailable]`. Generated first-person rationale uses fixed, source-neutral wording.
- Evidence signals are explicitly lexical keyword coverage, not evidence quality or a score.
- Output uses human decision framing.
- No command recommends a vote.
- Telegram routes do not load demo fixtures or local files by default.
- Remote URL fetches reject unsafe schemes, credentials, private IP ranges, unsupported content types, redirects, and oversized bodies.
- Remote sources use a strict MIME allowlist and a streaming 2 MiB body cap. Optional local file imports canonicalize the root and target, reject symlinks/outside-root/non-regular files, and validate the `ProposalDocument` schema.
- Telegram polling requires an explicit comma-separated direct/group chat allowlist; polling fails closed when it is absent or invalid, while CLI and health mode remain unaffected.

## Production Readiness Gates Not Yet Satisfied

- File-backed audit/source/proof persistence works for MVP with private file modes; pasted user text is hash-audited/preview-redacted but not source-cached, and public fetched sources are clone-redacted before caching. Proof-command audit previews are fully redacted; other command audit previews are bounded and heuristic-redacted but may contain unlabeled sensitive text. Operators must never submit secrets to commands and must protect the data directory and backups with `0700` directories and `0600` files. Defaults are a 10 MiB audit log with one backup plus 500 source and 500 proof files; oversized audit entries are rejected. High-availability production still needs SQLite/Postgres retention, backups, and monitoring.
- `npm run demo` generates an informational deterministic transcript; it is not a verification gate.
- Telegram runtime now persists update offset atomically and has healthcheck/structured logs/fake-API tests; production still needs a real bot token, service supervision, and operational monitoring.
- Citation quality has deterministic fixture evaluation; production still needs human-sampled citation accuracy during pilot.
- Real Cardano indexer integration if `/proof` tx verification is claimed.
- Pilot metrics with Catalyst reviewers/DReps; pilot docs/forms/runbook are prepared but real participants are still required.
