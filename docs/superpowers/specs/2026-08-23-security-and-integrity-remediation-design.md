# Security and Integrity Remediation Design

## Goal

Resolve every finding from the 2026-08-23 repository review without adding dependencies or expanding Vennek beyond a supervised Telegram pilot.

## Delivery strategy

Ship four independently testable changesets in dependency order:

1. proof and source-integrity correctness;
2. no-custody persistence controls;
3. Telegram access and availability controls;
4. ingestion hardening and release-gate cleanup.

Each changeset must leave the repository buildable and pass its focused regression tests before broader verification. No unrelated refactor is included.

## 1. Proof and source integrity

### Proof verification

`/proof-verify` will require both a transaction hash and an expected SHA-256 content hash. Verification succeeds only when Blockfrost returns a complete `vennek.proof.v1` payload whose required fields have the expected types and whose normalized `content_hash` equals the caller-provided hash. Schema discovery without an expected hash will no longer be labeled verified.

The public command contract, README, PRD, release checklist, and tests will change from:

```text
/proof-verify <tx_hash> [expected_content_hash]
```

to:

```text
/proof-verify <tx_hash> <expected_content_hash>
```

### Claim-level citations

Analysis will stop attaching a document-level citation hint to every claim. Each selected problem, request, impact, feasibility, and risk statement will carry its own supporting excerpt and document-scoped citation ID. A field without a supporting source span will be rendered as unsupported instead of borrowing an unrelated citation.

Comparisons will namespace citation IDs by document so left and right sources cannot both render as `S1`. Runtime validation will require the cited excerpt to be the excerpt used for the adjacent claim; citation presence alone will not count as support.

### Evidence score

Delete the numeric 1-5 “evidence quality” score. Replace it with a factual list of detected evidence signals and missing signals. This avoids creating a second scoring model while preserving the useful comparison information.

### Generated voice

Raw proposal sentences will never be interpolated into first-person rationale prose. `/vote-draft` will use fixed stance-specific wording, then render source statements as clearly labeled quotations with claim-level citations. The existing human-decision frame remains mandatory, but it is no longer the primary safety control.

## 2. No-custody persistence

Pasted text identified by a `user-provided:` source URI will not be written to `source-cache`. Audit entries keep input/output hashes and redacted previews; `/proof` continues to persist only its hash-based receipt.

Fetched public sources may remain cacheable, but all persisted citation snippets and metadata strings pass through the existing redaction policy before writing. The persistence layer owns this rule so callers cannot accidentally bypass it.

The regression contract is:

- a secret-like sentinel placed after the rendered citation prefix never appears in any persisted file;
- no raw pasted proposal body is persisted;
- fetched public documents still produce usable cache records;
- file modes remain `0700`/`0600`.

## 3. Telegram pilot controls

### Allowlist

Polling mode will require `VENNEK_TELEGRAM_ALLOWED_CHAT_IDS`, a comma-separated set of Telegram chat IDs. Direct chats are covered because their chat ID identifies the user; approved groups can be added explicitly. CLI mode remains unaffected. Polling startup fails closed when the allowlist is absent or invalid.

Authorization occurs before routing, fetching, Blockfrost access, or persistence. Rejected chats receive no governance processing and are logged only by hashed chat ID.

### Rate and storage bounds

Use an in-memory fixed-window per-chat limiter with a conservative pilot default. Keep the limiter injectable for deterministic tests, without adding a package or distributed state.

Persistence will enforce simple native limits:

- rotate the audit JSONL file at a documented size ceiling;
- retain a bounded number of source-cache and proof-receipt files;
- prune oldest files before new writes;
- preserve runtime-state space and surface pruning/write failures in structured logs.

These are pilot safeguards, not a general storage framework.

### Poison updates

Telegram API failures will retain their HTTP/API status. Each update gets a bounded number of delivery attempts. A permanent Telegram 4xx or an exhausted retry budget creates a dead-letter audit event and advances the offset, allowing later updates to continue. Transient failures remain retryable within the bound.

## 4. Source ingestion and release gates

### Remote bodies

Replace `response.arrayBuffer()` with a streaming reader that counts decoded bytes and cancels immediately above 2 MiB. Missing or unsupported `Content-Type` is rejected. Existing HTTPS, credential, DNS, allowlist, redirect, and timeout controls remain.

### Local files

When explicitly enabled by a trusted embedding, canonicalize both root and target with `realpath`, reject symlinks and non-regular files, enforce a byte limit, and structurally validate `ProposalDocument` before use. Production Telegram continues to disable local files.

### Dependencies

Update only the vulnerable transitive `postcss` and `nanoid` lockfile resolutions through the existing Vitest/Vite dependency chain. Do not add packages or run a broad major-version upgrade. Both full audit and production-only audit must report zero moderate-or-higher vulnerabilities.

## Error handling

- Validation failures produce user-safe messages and never expose tokens, filesystem paths, or raw secrets.
- Authorization and rate-limit rejection occurs before command side effects.
- Persistence remains fail-open for ordinary command UX, except no-custody filtering is fail-closed before a write.
- Proof verification fails closed on every malformed or incomplete field.
- Dead-letter events contain hashes and structured error categories, not raw Telegram text.

## Test strategy

Every behavior change follows a red-green-refactor cycle with one focused regression test first. Required focused coverage includes:

- schema-only and malformed proof metadata;
- missing expected proof hash;
- claim beyond character 260 receives its own supporting excerpt;
- duplicate `S1` identifiers across comparison sources;
- negated evidence keywords do not produce a numeric quality score;
- recommendation-like source text remains quoted and outside generated voice;
- padded secret-like input is absent from every persisted file;
- non-allowlisted and rate-limited chats cause no side effects;
- permanent send failures no longer block later updates;
- chunked oversized bodies stop at the byte ceiling;
- inside-root symlinks to outside-root files are rejected.

The final gate is:

```bash
npm test -- --run
npm run typecheck
npm run build
npm run verify:imports
npm run health
node --import tsx scripts/validate-data-sources.ts --mode sample
node --import tsx scripts/evaluate-citations.ts
node --import tsx scripts/run-demo.ts
npm audit --audit-level=moderate
npm audit --omit=dev --audit-level=moderate
git diff --check
```

The live Blockfrost test and staging smoke remain explicit deployment gates requiring real credentials; they are not replaced by mocks.

## Rollout and rollback

Deploy in the four changesets above. After the Telegram-control changeset, configure the allowlist before restarting the poller. Validate health, one authorized command, one rejected chat, one proof verification, offset advancement, and disk retention in staging.

Rollback is changeset-by-changeset. Do not roll back the new required expected hash or no-custody persistence filter after any data has been produced under the hardened contract; instead fix forward if those gates fail operationally.

## Out of scope

- database migration, distributed rate limiting, or multi-instance polling;
- an LLM-based safety classifier;
- a new evidence-scoring algorithm;
- arbitrary-domain production fetching;
- automatic voting, signing, wallet access, or transaction submission.
