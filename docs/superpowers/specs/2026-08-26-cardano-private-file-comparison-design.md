# Cardano Private File Comparison Design

**Date:** 2026-08-26

**Status:** Approved by the user

**Release slice:** R8c — private, one-shot user-file comparison

## 1. Objective

Allow any Telegram user to attach one text-extractable PDF, DOCX, TXT, or
Markdown document and ask the Cardano agent to compare its claims with current
Cardano evidence. The comparison must retain the existing source hierarchy and
claim verification while keeping the uploaded file private and request-scoped.

Success means a valid private-chat document plus caption produces a grounded
comparison with separate user-file and Cardano citations. File bytes, extracted
text, derived excerpts, and answers never enter conversation history, shared
knowledge, retrieval caches, promotion, logs, or audit records.

## 2. Approved Assumptions

- Telegram cloud Bot API is the only R8c transport.
- One Telegram update contains exactly one document and its comparison caption.
- The update must come from a private chat whose user ID equals the chat ID.
- The caption is the only Cardano retrieval query. File content never drives
  live discovery or shared retrieval.
- Upload-first/ask-later sessions, group chats, multiple files, file-to-file
  comparison, OCR, images, scanned PDFs, spreadsheets, archives, and permanent
  file storage are outside R8c.
- Private content may cross only a separately configured no-retention,
  no-training model route. Missing or invalid private-provider configuration
  fails closed; no fallback provider is permitted.

## 3. Limits and Accepted Formats

- Wire input: 1 byte through 20 MiB, enforced from advisory metadata and again
  while streaming the download.
- Extracted output: 1 through 2,000,000 Unicode code points, with a separate
  UTF-8 byte ceiling sufficient for the maximum Unicode representation.
- Caption: the existing Telegram text boundary, required and non-empty.
- PDF: text-extractable, at most 300 pages, no JavaScript, actions, embedded
  files, attachments, or other active content.
- DOCX: Office Open XML Word document only; macro/template variants, encryption,
  traversal, symlinks, excessive entry count, excessive expanded bytes,
  `vbaProject`, ActiveX, embedded OLE/packages, `altChunk`, external
  relationships, and attached templates are rejected.
- TXT and Markdown: strict UTF-8 only. Raw HTML is not an accepted upload type.
- Extension and Telegram MIME are advisory. Magic bytes and structural checks
  determine the actual accepted type; disagreement is rejected.

## 4. Architecture

R8c uses a separate `telegram-private-compare` queue and a separate private
document extractor service. It does not extend `answerQuestion`, the R8b
promotion endpoint, or the shared knowledge repository.

The webhook and poller validate the Telegram envelope, then enqueue only an
AES-256-GCM encrypted metadata envelope containing the bounded caption,
Telegram file ID, advisory file metadata, update ID, user ID, and chat ID.
Associated data binds the envelope to the queue name and those three IDs.
PgBoss keeps an unfinished job for retry for at most one hour and removes the
payload promptly after terminal completion.

The agent worker decrypts the envelope, revalidates owner binding, calls
Telegram `getFile`, and streams the file from Telegram's fixed HTTPS file
origin. Redirects, credentials in returned paths, absolute URLs, dot segments,
fragments, queries, oversized bodies, invalid lengths, slow responses, and
unexpected content encodings are rejected. Bot tokens, download URLs, file IDs,
names, captions, and content are never logged.

The worker sends bytes to a token-authenticated extractor on an internal Docker
network. The extractor sniffs the real type, performs format-specific safety
checks, and parses inside a worker thread. Its container is non-root, read-only,
capability-free, no-new-privileges, resource-limited, and network-isolated. It
returns only bounded title and text. All request buffers are released and
overwritten best-effort in `finally`; crash recovery relies only on the
one-hour encrypted queue envelope, so Telegram is the retry source of bytes.

## 5. Reuse and Dependencies

Reuse the existing AES-GCM encryption helper, Telegram admission/idempotency,
bounded HTTP patterns, `chunkDocument`, PDF.js worker approach, Cardano
retrieval, model client, claim verifier, answer-size limits, localized failure
style, and Docker sandbox controls.

Declare direct runtime dependencies instead of relying on transitive installs:

- `file-type` for magic-byte identification;
- `yauzl` for lazy DOCX ZIP preflight; and
- `mammoth` for raw DOCX text extraction after preflight succeeds.

Node standard-library HTTP, crypto, streams, worker threads, and URL validation
remain the transport and isolation primitives. No upload framework, object
store, session database, vector database, or second agent framework is added.

## 6. Comparison and Provenance

The worker retrieves Cardano evidence using the bounded caption and the existing
official-first retrieval path. It chunks extracted private text in memory and
selects a bounded set of relevant excerpts without writing embeddings or chunks
to PostgreSQL. R8c initially uses deterministic lexical scoring for private
excerpt selection; private embeddings are unnecessary until the evaluation
harness proves recall is insufficient.

The comparison prompt contains two explicit, untrusted evidence namespaces:

- `U1..Un`: private uploaded-file excerpts with a safe display title and no URL;
- `E1..En`: existing Cardano evidence with public provenance and trust tier.

The model must treat both namespaces as data, never instructions. A comparison
claim must cite at least one `U*` and one `E*`. Cardano-only context claims may
cite `E*` only and continue to obey official/community/conflict rules. A private
citation renders as the bounded file label without a URL; public citations use
the existing renderer. No synthetic HTTPS URL is created for private evidence.

Generated output passes strict JSON parsing, known-ID validation, wallet-secret
scanning, claim verification, and final answer bounds before delivery. The
caption, answer, and file-derived material bypass `ConversationRepository`.

## 7. Provider Boundary

R8c requires explicit private aliases for generation and verification in the
LiteLLM configuration. Each alias maps to one operator-approved provider/model
with no fallback. Deployment documentation records that the provider contract
must disable training and retention for submitted content. Runtime validates
the aliases as dedicated private routes and refuses comparison when they are
absent; it cannot independently prove a provider's contractual policy.

Private file content is not sent to the embedding provider in R8c. Public
Cardano retrieval retains the existing embedding route because only the caption
and public knowledge participate.

## 8. Errors and Cleanup

User-facing errors are localized and disclose only these categories: unsupported
format, file too large, text unavailable, unsafe document, comparison provider
unavailable, insufficient Cardano evidence, or temporary processing failure.
Parser/provider details, identifiers, filenames, paths, tokens, and content are
excluded from responses and structured logs.

Every terminal path marks the update processed or failed without retaining the
private payload. Download, extraction, retrieval, completion, verification,
delivery, timeout, abort, and retry exhaustion all execute cleanup in `finally`.
Queued encrypted metadata expires after one hour when a worker crashes before
terminal cleanup.

## 9. Deployment Flow

```text
Telegram webhook/poller
    -> encrypted telegram-private-compare job (PgBoss, <= 1 hour)
    -> agent-worker
       -> Telegram getFile + bounded HTTPS download
       -> private-document-extractor (internal network)
       -> Cardano retrieval using caption only
       -> private model aliases for compare + verify
       -> Telegram sendMessage
       -> immediate cleanup
```

The existing public PDF extractor remains unchanged for knowledge ingestion.
The private extractor uses a distinct token, endpoint, worker slot, container,
and internal network so public uploads cannot starve knowledge synchronization.

## 10. Commands

```bash
npm test -- --run tests/privateDocumentIntake.test.ts tests/privateDocumentExtractor.test.ts
npm test -- --run tests/privateComparison.test.ts tests/privateComparisonRuntime.test.ts
npm test -- --run tests/webhookRuntime.test.ts tests/pollingRuntime.test.ts tests/agentQueue.test.ts tests/agentWorker.test.ts
npm test -- --run
npm run typecheck
npm run build
npm run verify:imports
npm run validate:registry
npm audit --omit=dev
docker compose --env-file .env.example config --quiet
git diff --check
```

## 11. Project Structure

```text
apps/telegram-bot/src/
  privateComparisonQueue.ts       encrypted job admission and retention
  privateComparisonRuntime.ts     download, extract, compare, cleanup
  pollingRuntime.ts               Telegram document metadata intake
  webhookRuntime.ts               authenticated document update intake
  main.ts                         worker and service composition

packages/cardano-agent/src/privateComparison/
  privateDocumentProtocol.ts      exact limits and wire validators
  privateDocumentExtractor.ts     format sniffing and safe parsing dispatch
  privateDocumentWorker.ts        isolated PDF/DOCX/text parsing
  comparePrivateDocument.ts       selection, grounding, verification, rendering

tests/
  privateDocumentIntake.test.ts
  privateDocumentExtractor.test.ts
  privateComparison.test.ts
  privateComparisonRuntime.test.ts
```

Names may be collapsed when an existing focused module can safely own the
behavior. No task may widen the R8b endpoint or shared knowledge write grants.

## 12. Testing Strategy

All behavior changes follow red-green-refactor. Unit tests cover exact bounds,
Unicode code points, envelope validation, owner binding, type spoofing, DOCX ZIP
limits and active parts, PDF active content and scanned files, prompt injection,
citations, wallet secrets, error redaction, and cleanup.

Integration tests use real PgBoss/PostgreSQL for encrypted retry/expiry and an
HTTP server for Telegram `getFile` plus bounded streaming. A compiled-process
smoke test crosses the extractor container boundary. Tests assert that private
content does not appear in conversation, knowledge, cache, audit, queue after
completion, logs, or responses.

The final gate includes the complete suite, static/configuration commands,
production dependency audit, Docker isolation inspection, independent
correctness review, and independent security review. Any substantiated finding
is fixed with a failing regression test and re-reviewed.

## 13. Boundaries

Always:

- validate every Telegram, queue, HTTP, archive, parser, model, and database
  boundary;
- keep private bytes/text in memory and delete encrypted metadata promptly;
- fail closed when type, ownership, provider, provenance, or cleanup is unclear;
- preserve existing public-answer and knowledge-ingestion behavior.

Requires an explicit design revision:

- upload-first/ask-later sessions, multiple files, group chats, OCR, additional
  formats, private embeddings, local Bot API server, or retained files.

Never:

- put private bytes, extracted text, excerpts, caption, or answer into shared
  knowledge, promotion, retrieval cache, conversation history, logs, or audit;
- use file content for discovery or public retrieval;
- trust Telegram MIME, filename, `file_size`, or returned `file_path` alone;
- invent public provenance for a private file or silently fall back to a
  non-private model route.

## 14. Alternatives Rejected

1. Upload-first sessions were rejected because they require a durable ownership
   store and cross-message lifecycle that R8c does not need.
2. Reusing `answerQuestion` was rejected because it persists inputs and outputs
   indefinitely and its evidence contract requires public HTTPS provenance.
3. Reusing the knowledge PDF extractor instance was rejected because an
   untrusted public upload could deny service to Cardano ingestion.
4. Writing a DOCX parser was rejected in favor of a preflighted, sandboxed
   existing parser.
5. Private embeddings were deferred because bounded lexical selection avoids an
   additional provider disclosure and persistent/vector infrastructure.

## 15. Success Criteria

1. Valid PDF, DOCX, TXT, and Markdown uploads at both ASCII and astral Unicode
   bounds produce a verified comparison with `U*` and `E*` citations.
2. Oversize, spoofed, malformed, encrypted, active-content, archive-bomb,
   traversal, scanned, empty, slow, redirected, or cross-owner inputs fail
   safely before any private provider call.
3. Replay and retry cannot expose a file to another user or chat.
4. Private content never mutates or enters shared knowledge, promotion,
   retrieval cache, conversation history, logs, or audit.
5. Completed jobs remove encrypted request metadata; abandoned jobs expire in
   at most one hour.
6. Missing private model routes fail closed without fallback.
7. Existing text-only Telegram behavior and R8b boundaries remain unchanged.
8. Targeted tests, full tests, static checks, real PostgreSQL integration,
   compiled extractor smoke, and Compose validation pass.
9. Independent correctness and security reviews pass after all findings are
   resolved.

## 16. Open Questions

None. Any future expansion named in section 13 requires a new design slice.
