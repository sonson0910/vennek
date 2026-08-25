# Cardano Live Discovery Design

**Date:** 2026-08-25

**Status:** Approved in conversation; awaiting review of this written spec

**Immediate release slice:** R8b — authenticated live-source promotion

**Follow-on slice:** R8c — private user-file comparison

## 1. Objective

Allow the public Cardano agent to refresh missing or stale evidence while it is
answering a question, without granting the chat-facing worker write access to
the shared knowledge base.

When indexed evidence is empty or stale, the agent asks the existing knowledge
worker to discover and promote registry-approved Cardano sources. The operation
has a 45-second deadline. The agent then runs the existing retrieval once more
and either answers with citations or states that the available evidence is
insufficient or stale.

Success means:

- any public user can benefit from newly indexed Cardano material;
- only the knowledge worker can mutate knowledge tables;
- an authenticated request cannot be replayed to repeat promotion;
- discovery cannot choose an arbitrary URL supplied by a user or caller;
- no question, URL, document content, provider error, or secret enters the
  promotion audit ledger; and
- discovery failure never causes an unsupported answer.

## 2. Scope and Assumptions

### 2.1 In scope for R8b

- A private, question-only HTTP endpoint owned by `knowledge-worker`.
- HMAC-SHA256 service authentication using Node.js standard-library crypto.
- PostgreSQL-backed request claims, replay protection, and minimal audit data.
- Registry reload, SearXNG discovery, protected fetch, extraction, immutable
  indexing, and one retry of the existing retrieval path.
- Alignment of the transport-independent Agent Core input bound to 16,384
  Unicode code points and 64 KiB UTF-8; Telegram keeps its own stricter
  platform-facing limit.
- Official-source-first discovery with registered community sources as a
  fallback. Unregistered sources are never promoted.
- A maximum of three unique registry sources promoted per request.
- Container configuration, database grants, and trust-boundary tests.

### 2.2 Follow-on R8c contract

Users may later attach a text-extractable PDF, DOCX, TXT, or Markdown file up to
20 MiB and ask the agent to compare it with Cardano evidence. Extracted text is
limited to 2,000,000 Unicode code points. User files are private, per-request
evidence and are never promoted into the shared knowledge base.

R8c will use a separate upload/extraction path, delete request data immediately
after completion, and retain a one-hour cleanup TTL only as a crash-recovery
safety net. It will reject spoofed file types, active content, unsafe DOCX
archives, and cross-session access. OCR, images, scanned PDFs, spreadsheets,
archives, and permanent user-file storage are not part of R8c.

R8c requires its own implementation plan and security review after R8b. This
spec intentionally does not make the discovery endpoint accept files, URLs,
Telegram identifiers, or document content.

### 2.3 Explicit assumptions

- Telegram remains the only public transport in these two release slices, but
  the Agent Core accepts up to 16,384 Unicode code points and 64 KiB UTF-8 so a
  future transport is not constrained by Telegram's message limit.
- The narrower discovery query accepts at most 4,096 Unicode code points and
  16 KiB UTF-8. File content will be reduced to a bounded search intent before
  any future discovery call.
- PostgreSQL, the existing source registry, SearXNG client, hardened fetch,
  extractors, embedder, and indexing repository remain the system components.
- No new agent framework, cache service, queue, or authentication dependency is
  introduced.

## 3. Existing Flow to Reuse

The implementation extends existing seams rather than creating a second RAG
pipeline:

- `answerQuestion` already calls an optional `discover` dependency when initial
  evidence is empty or stale, then retrieves once more.
- `discoverLiveSources` validates queries and searches registered domains.
- `promoteDiscoveredLink` revalidates source scope, uses the protected remote
  fetch boundary, extracts content, and indexes immutable document versions.
- `knowledge-worker` already owns scheduled/manual knowledge synchronization
  under a restricted database role.
- the isolated PDF extractor remains the only PDF parsing boundary.

The smallest correct change is to connect these existing pieces through one
authenticated internal protocol. The Telegram worker does not gain knowledge
DML privileges.

## 4. Architecture and Data Flow

```text
Telegram question
  -> Agent Core persists accepted text
  -> hybrid retrieval
  -> enough fresh evidence? ---------------------------> grounded answer
  -> no
  -> agent-worker signs { question }
  -> POST /internal/knowledge/promote
  -> knowledge-worker authenticates and claims request in PostgreSQL
  -> reload source registry
  -> search official registered domains
  -> if no promotable match, search registered community domains
  -> validate and promote at most 3 unique source IDs
  -> finish audit row (no source details)
  -> agent-worker runs hybrid retrieval once more
  -> grounded answer, or explicit insufficient/stale-evidence response
```

The internal endpoint listens only inside the Compose network and has no
published host port. Network placement is defense in depth; HMAC authentication
is the service-identity boundary.

Only one promotion request runs at a time per knowledge-worker process. Extra
authenticated requests are recorded as `busy` and receive a retryable response;
there is no in-process backlog. PostgreSQL replay protection remains global
across processes and restarts.

## 5. Internal Promotion Protocol

### 5.1 Request

```http
POST /internal/knowledge/promote
Content-Type: application/json
X-Vennek-Key-Id: agent-worker-v1
X-Vennek-Request-Id: <UUID>
X-Vennek-Timestamp: <Unix seconds>
X-Vennek-Nonce: <128-bit base64url>
X-Vennek-Signature: <HMAC-SHA256 base64url>

{"question":"<NFC-normalized, trimmed question>"}
```

The JSON object contains exactly `question`. Raw body size is capped at 64 KiB
before parsing and aggregate request headers are capped at 8 KiB. The decoded
question must be non-empty, at most 4,096 Unicode code points and 16 KiB UTF-8,
and contain no control characters, `site:` operator, or detected wallet secret.

The agent client may receive language as part of the existing callback input,
but it serializes only `question`. It never sends a URL, source ID, user/chat ID,
Telegram update ID, conversation history, file, or provider credential.

### 5.2 Canonical signature

The shared secret is a canonical base64 encoding of exactly 32 random bytes.
The sender hashes the exact transmitted body and signs this newline-delimited
ASCII string:

```text
VENNEK-PROMOTION-V1
POST
/internal/knowledge/promote
<key-id>
<request-id>
<timestamp>
<nonce>
<base64url-sha256-of-exact-raw-body>
```

The receiver validates header syntax, rejects timestamps outside a ±60-second
window, recomputes the signature, and compares decoded fixed-length signatures
with `crypto.timingSafeEqual`. Authentication happens before JSON parsing or
database writes. The HMAC key is never transmitted and is supplied through the
deployment secret environment only.

### 5.3 Responses

- `204 No Content`: authenticated request completed, including `promoted` or
  `no_match`; the caller retrieves again in either case.
- `400 Bad Request`: authenticated but structurally invalid request.
- `401 Unauthorized`: missing, malformed, unknown-key, stale-timestamp, or
  invalid-signature request.
- `409 Conflict`: the request is still running, or only one of request ID and
  nonce matches an existing claim.
- `503 Service Unavailable`: `busy`, `timeout`, or sanitized upstream failure.

When both request ID and nonce match a completed claim, the server returns the
HTTP status derived from its stored safe outcome (`204`, `400`, or `503`) without
rerunning discovery. A stale timestamp is still rejected before this lookup.

Responses never contain discovered links, source content, provider errors, or
audit details. The Agent Core treats every non-204 result as unavailable live
discovery, keeps bounded original evidence, and never exposes internal errors.

The client uses a 50-second request timeout; the knowledge operation has one
shared 45-second deadline propagated through search, fetch, extraction,
embedding, and database calls.

## 6. Replay and Audit Model

A new migration creates `knowledge_promotion_requests` with:

- `request_id uuid primary key`;
- `caller_id text not null`;
- `nonce_digest bytea not null unique`, constrained to 32 bytes;
- `state text not null` constrained to `started`, `succeeded`, or `failed`;
- nullable `outcome text` constrained to `promoted`, `no_match`, `busy`,
  `timeout`, `upstream_failed`, or `invalid_authenticated_request`;
- `promoted_count smallint` constrained from zero through three;
- bounded non-negative `latency_ms`;
- `received_at timestamptz not null`; and
- nullable `completed_at timestamptz` consistent with `state`.

The table does not store the question or its hash, request body, URL, source ID,
document content, response content, Telegram identity, raw exception, or secret.
A question hash is intentionally excluded because short prompts are vulnerable
to dictionary recovery.

After HMAC verification, one transaction inserts the request ID and
SHA-256 nonce digest before discovery begins. Unique constraints provide the
cross-replica replay decision. A duplicate never invokes discovery. A request
left in `started` after a crash remains non-rerunnable and returns conflict.

Rows older than 30 days are deleted in bounded batches of at most 1,000 at
knowledge-worker startup and, while requests continue, no more than once per
hour. Timestamp freshness still rejects old signed requests after their audit
rows are pruned.

The knowledge database role receives only the exact table privileges required
for this ledger, in addition to its existing knowledge DML and isolated
`knowledge_boss` privileges. The application role receives no write access to
knowledge or promotion audit tables.

## 7. Discovery and Promotion Rules

1. Reload and validate the source registry for every authenticated request.
2. Search official registered domains first through the configured SearXNG
   origin. Search registered community domains only when the official pass
   yields no promotable result.
3. Normalize and deduplicate links, then keep only links matching exactly one
   registry entry.
4. Deduplicate by source ID and process at most three links.
5. Revalidate registry scope inside `promoteDiscoveredLink`; never trust the
   search result or caller.
6. Preserve the hardened HTTPS-only fetch protections, DNS/IP validation,
   redirect validation, response-size bounds, extractor isolation, immutable
   versions, and embedding-model consistency.
7. Abort remaining work when the shared deadline expires.
8. Record only the safe aggregate outcome and promoted count.

Official evidence keeps priority over community evidence in retrieval and
answer rendering. Current official conflicts are shown with publisher and date;
the agent does not silently choose a winner.

## 8. Error Handling and Availability

- Invalid unauthenticated traffic is rejected before parsing and is not audited.
- Authenticated malformed input is recorded only as
  `invalid_authenticated_request`.
- SearXNG, remote-fetch, extraction, embedding, and database errors are reduced
  to `upstream_failed`, except deadline expiry which becomes `timeout`.
- A process-wide active-request flag is released in `finally`.
- Promotion failures do not delete earlier immutable knowledge versions.
- The existing retrieval result remains available when discovery fails.
- Empty evidence produces the localized insufficient-evidence response.
- Stale evidence may be used only with its existing stale qualification.

## 9. Project Structure

R8b should use the fewest focused additions that preserve the trust boundary:

```text
apps/telegram-bot/src/
  knowledgePromotionProtocol.ts  shared canonical signing and validation
  knowledgePromotionClient.ts    agent-worker internal client
  knowledgePromotionServer.ts    knowledge-worker private endpoint
  agentWorker.ts                  inject existing discover callback
  main.ts                         runtime composition only

packages/cardano-agent/src/knowledge/
  promotionAudit.ts              transactional claim and terminal update
  liveDiscovery.ts               reuse/extend official-first discovery

packages/cardano-agent/migrations/
  006_knowledge_promotion_requests.sql

scripts/
  provision-knowledge-role.ts    exact audit grants

docker-compose.yml               private endpoint and secret wiring
```

Names may be collapsed during implementation when an existing module can own
the behavior without mixing client and server secrets. No one-implementation
factory, general RPC framework, or new HTTP dependency is justified.

R8c file intake, private temporary evidence, and comparison tests will live in
its own later plan and must not be added opportunistically during R8b.

## 10. Code Style

Use the repository's strict TypeScript, explicit dependency inputs, safe error
messages, and Node.js standard library. Trust-boundary validators accept
`unknown`, return a narrow immutable value, and reject extra fields.

```ts
export function validatePromotionBody(value: unknown): { question: string } {
  if (!isPlainRecord(value) || Object.keys(value).length !== 1) {
    throw new Error("Promotion body must contain exactly question.");
  }
  return { question: validateDiscoveryQuestion(value.question) };
}
```

Tests exercise observable behavior rather than private implementation details.
Security-sensitive comparisons and hashes use `node:crypto`; UUIDs and nonces
use `crypto.randomUUID` and `crypto.randomBytes`.

## 11. Commands

Run from the repository worktree:

```bash
npm test -- --run apps/telegram-bot/test/knowledgePromotionProtocol.test.ts
npm test -- --run apps/telegram-bot/test/knowledgePromotionServer.test.ts
npm test -- --run apps/telegram-bot/test/agentRuntime.test.ts
npm test -- --run packages/cardano-agent/test/knowledge/promotionAudit.integration.test.ts
npm run typecheck
npm run build
npm run verify:imports
npm run validate:registry
docker compose config
```

Before R8b completion, also run the full `npm test` suite against a fresh
PostgreSQL/pgvector test database and an integration smoke test with the real
knowledge-worker endpoint. Exact new test filenames may follow the repository's
existing `*.test.ts` placement during planning.

## 12. Testing Strategy

### Unit and protocol tests

- exact canonical signature vector and exact raw-body hashing;
- wrong key, key ID, method, path, request ID, timestamp, nonce, body, and
  signature;
- fixed-length constant-time signature comparison behavior;
- malformed JSON, extra fields, control characters, wallet secrets, `site:`,
  Unicode normalization, 4,096-character/16-KiB query bounds, 64-KiB raw body,
  and 8-KiB headers;
- transport-independent Agent Core acceptance through 16,384 Unicode code
  points and 64 KiB UTF-8, with rejection above either bound;
- client serialization proves that only `question` crosses the boundary.

### PostgreSQL integration tests

- first claim succeeds;
- duplicate request ID, duplicate nonce with another request ID, in-progress
  replay, completed replay, and crash-left `started` never rerun;
- concurrent claims across independent connections have exactly one winner;
- state/outcome constraints and 30-day bounded pruning;
- application role cannot write knowledge or audit data;
- knowledge role has only the intended audit privileges.

### Service and end-to-end tests

- official-first search, registered community fallback, source-ID deduplication,
  three-promotion cap, and registry reload;
- SSRF, redirects to private networks, DNS rebinding, and out-of-registry URLs
  remain rejected by the existing hardened fetch boundary;
- busy, timeout, SearXNG failure, extraction failure, process interruption, and
  restart have safe responses and audit states;
- successful promotion is visible to the second retrieval and appears in a
  grounded answer with immutable citations;
- failure preserves old evidence and produces the correct localized caveat;
- Compose exposes no promotion port to the host and does not cross Telegram,
  encryption, owner, or database-owner credentials into the wrong service.

After implementation and verification, an independent reviewer and an
independent security reviewer must both pass. Substantiated findings are fixed
and sent back for re-review before the trust-boundary task is complete.

## 13. Boundaries

### Always

- Keep knowledge writes in the knowledge role.
- Authenticate before parsing or database access.
- Claim replay identifiers before executing promotion.
- Revalidate source registry and protected-fetch constraints.
- Propagate one bounded deadline and abort signal.
- Return only safe aggregate status.
- Add migration, concurrency, protocol, role, and integration tests.

### Ask first

- Add a runtime dependency or service.
- Publish an internal port outside the deployment network.
- Change retention beyond the approved audit and file-cleanup windows.
- Permit a new file type or promote user files into shared knowledge.
- Expand the endpoint payload beyond `question`.

### Never

- Commit or log HMAC, Telegram, provider, database, or wallet secrets.
- Accept a caller-supplied URL, source ID, user identity, chat history, or file
  at the discovery endpoint.
- Store question text or a reversible/dictionary-testable derivative in audit.
- Grant the agent worker knowledge DML.
- Use unregistered live-search material as authoritative evidence.
- Run macros, scripts, active content, or remote relationships from user files.

## 14. Success Criteria

R8b is complete only when all of the following are demonstrated:

1. Empty or stale retrieval invokes the authenticated knowledge endpoint once,
   waits at most 50 seconds client-side, and retrieves once more.
2. The knowledge operation cannot exceed 45 seconds and promotes no more than
   three unique registry sources.
3. Only exact, fresh, correctly signed question-only requests can reach
   discovery.
4. Replays are prevented across concurrency, restart, and multiple replicas by
   PostgreSQL constraints and request state.
5. Agent credentials cannot mutate knowledge or promotion audit tables.
6. No sensitive request or source material appears in audit, logs, or responses.
7. Discovery failure yields existing qualified evidence or a localized
   insufficient-evidence response, never an unsupported answer.
8. Targeted tests, full tests, typecheck, build, import verification, registry
   validation, real PostgreSQL integration, and Compose validation pass.
9. Independent correctness and security reviews pass after any findings are
   resolved.

R8c is not part of R8b completion. Its approved product contract is preserved in
section 2.2 and will receive a separate plan so private file handling cannot
weaken the discovery boundary.

## 15. Open Questions

None for R8b. R8c parser/dependency selection will be decided in its own plan
after auditing what can be safely reused from the existing isolated extractor.
