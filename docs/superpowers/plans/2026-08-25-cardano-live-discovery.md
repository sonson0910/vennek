# Cardano Live Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect the public Agent Core to the restricted knowledge worker so missing or stale Cardano evidence can be discovered, authenticated, replay-protected, promoted, and retrieved again within a 45-second deadline.

**Architecture:** The agent worker sends only a normalized question to a private HTTP endpoint signed with HMAC-SHA256. The knowledge worker authenticates before parsing, claims request ID and nonce in PostgreSQL, runs the existing registry/SearXNG/hardened-fetch/indexing path for at most three sources, stores only a safe aggregate audit outcome, and returns no content. The existing `answerQuestion` discovery seam then performs its one existing retrieval retry.

**Tech Stack:** Node.js 22 standard library (`node:crypto`, `node:http`), strict TypeScript, PostgreSQL/pgvector, `pg`, existing SearXNG and Cardano knowledge modules, Vitest, Docker Compose.

**Design:** `docs/superpowers/specs/2026-08-25-cardano-live-discovery-design.md`

**Scope boundary:** This plan implements R8b only. R8c private file comparison gets a separate plan after R8b passes correctness and security review.

---

## File Map

### Create

- `apps/telegram-bot/src/knowledgePromotionProtocol.ts` — canonical signing, authentication, exact body validation, and fixed protocol constants.
- `apps/telegram-bot/src/knowledgePromotionClient.ts` — bounded internal client that serializes only `question`.
- `apps/telegram-bot/src/knowledgePromotionServer.ts` — bounded Node HTTP adapter, replay/audit state machine, single-process admission, and safe status mapping.
- `packages/cardano-agent/src/knowledge/promotionAudit.ts` — PostgreSQL claim, completion, replay lookup, and bounded pruning.
- `packages/cardano-agent/migrations/006_knowledge_promotion_requests.sql` — durable replay/audit constraints.
- `tests/knowledgePromotionProtocol.test.ts` — deterministic HMAC and input-boundary tests.
- `tests/knowledgePromotionServer.test.ts` — server behavior, deadline, busy, replay, and response-redaction tests.
- `tests/promotionAudit.integration.test.ts` — real PostgreSQL concurrency and retention tests.
- `tests/knowledgePromotion.integration.test.ts` — real private HTTP server plus PostgreSQL promotion/retrieval smoke test.

### Modify

- `packages/cardano-agent/src/agent/answerQuestion.ts` — separate 16,384-code-point and 64-KiB question bounds.
- `packages/cardano-agent/src/knowledge/liveDiscovery.ts` — tier-selected discovery and bounded question promotion orchestration.
- `packages/cardano-agent/src/index.ts` — export the audit and orchestration contracts.
- `apps/telegram-bot/src/agentWorker.ts` — pass the existing optional `discover` dependency to Agent Core.
- `apps/telegram-bot/src/main.ts` — compose client/server dependencies and lifecycle without crossing credentials.
- `apps/telegram-bot/src/index.ts` — export only the protocol/client contracts needed by package consumers.
- `scripts/provision-knowledge-role.ts` — grant exact promotion-audit table privileges.
- `.env.example` and `deploy/vennek.env.example` — document the internal endpoint and one 32-byte HMAC key.
- `docker-compose.yml` — wire the private endpoint; do not publish its port.
- `tests/answerQuestion.test.ts`, `tests/agentWorker.test.ts`, `tests/liveDiscovery.test.ts`, `tests/agentConfig.test.ts`, `tests/knowledgeRuntime.test.ts`, `tests/runtimeComposition.test.ts`, `tests/compose.test.ts`, `tests/provisionAppRole.integration.test.ts`, and `tests/provisionKnowledgeRole.integration.test.ts` — extend existing behavior checks.
- `docs/superpowers/plans/2026-08-24-cardano-knowledge-rag.md` — mark R8b complete only after all verification and reviews pass.

---

### Task 1: Correct the transport-independent question bound

**Files:**

- Modify: `packages/cardano-agent/src/agent/answerQuestion.ts`
- Modify: `tests/answerQuestion.test.ts`

- [ ] **Step 1: Write failing boundary tests**

Add tests proving that question validation counts Unicode code points separately from UTF-8 bytes and keeps wallet-secret rejection before persistence:

```ts
it("accepts Agent Core questions through 16,384 code points and 64 KiB", async () => {
  const persist = vi.fn().mockResolvedValue({ firstInteraction: false });
  const retrieve = vi.fn().mockResolvedValue([]);
  const text = "😀".repeat(16_384);

  await answerQuestion(
    { telegramUserId: "1", telegramChatId: "1", text },
    { persist, retrieve },
  );

  expect(Buffer.byteLength(text, "utf8")).toBe(65_536);
  expect(persist).toHaveBeenCalledOnce();
});

it("rejects a question above either Agent Core bound before persistence", async () => {
  const persist = vi.fn();
  const dependencies = { persist, retrieve: vi.fn() };

  await expect(answerQuestion(
    { telegramUserId: "1", telegramChatId: "1", text: "a".repeat(16_385) },
    dependencies,
  )).resolves.toMatch(/cannot process|chưa thể xử lý/i);
  await expect(answerQuestion(
    { telegramUserId: "1", telegramChatId: "1", text: "€".repeat(16_384) + "a".repeat(16_385) },
    dependencies,
  )).resolves.toMatch(/cannot process|chưa thể xử lý/i);

  expect(persist).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the tests and confirm the first test fails**

Run:

```bash
npm test -- tests/answerQuestion.test.ts
```

Expected: FAIL because the current shared `boundedText` caps the question at 16,384 bytes.

- [ ] **Step 3: Separate question and stored-text bounds**

Keep existing stored assistant/model output limits unchanged. Add these constants and validator, then use it from `canonicalQuestionInput` and `languageFor`:

```ts
const MAX_QUESTION_CODE_POINTS = 16_384;
const MAX_QUESTION_BYTES = 64 * 1024;

function boundedQuestion(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    Array.from(value).length > MAX_QUESTION_CODE_POINTS ||
    Buffer.byteLength(value, "utf8") > MAX_QUESTION_BYTES ||
    !value.trim()
  ) return undefined;
  return value;
}
```

`languageFor` must apply the same two bounds before normalization; `canonicalQuestionInput` must call `boundedQuestion(text)`. Do not enlarge `MAX_TEXT_LENGTH` or completion-output bounds.

- [ ] **Step 4: Run the focused test**

```bash
npm test -- tests/answerQuestion.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cardano-agent/src/agent/answerQuestion.ts tests/answerQuestion.test.ts
git commit -m "fix: bound long agent questions by code points and bytes"
```

---

### Task 2: Define the HMAC protocol and bounded client

**Files:**

- Create: `apps/telegram-bot/src/knowledgePromotionProtocol.ts`
- Create: `apps/telegram-bot/src/knowledgePromotionClient.ts`
- Create: `tests/knowledgePromotionProtocol.test.ts`
- Modify: `apps/telegram-bot/src/index.ts`

- [ ] **Step 1: Write deterministic protocol tests**

Use a fixed 32-byte key, timestamp, UUID, and nonce so the signature is a stable test vector. Cover method/path/body mutation, ±60-second freshness, exact-object validation, wallet secrets, `site:`, control characters, 4,096-code-point/16-KiB query limits, and canonical base64 key parsing:

```ts
const identity = {
  keyId: "agent-worker-v1",
  key: Buffer.alloc(32, 7),
};
const fixed = {
  now: new Date("2026-08-25T00:00:00.000Z"),
  requestId: "11111111-1111-4111-8111-111111111111",
  nonce: Buffer.alloc(16, 9),
};

it("signs and authenticates the exact transmitted body", () => {
  const signed = signPromotionQuestion(" latest Cardano node ", identity, fixed);
  expect(signed.body).toBe('{"question":"latest Cardano node"}');
  expect(authenticatePromotionRequest({
    method: "POST",
    path: KNOWLEDGE_PROMOTION_PATH,
    headers: new Headers(signed.headers),
    body: Buffer.from(signed.body),
    identity,
    now: fixed.now,
  })).toEqual({
    requestId: fixed.requestId,
    nonceDigest: expect.any(Buffer),
  });
});

it("serializes only question and rejects a redirected or failed request", async () => {
  const fetch = vi.fn(async (_url: URL, init: RequestInit) => {
    expect(JSON.parse(String(init.body))).toEqual({ question: "Cardano?" });
    expect(String(init.body)).not.toMatch(/language|user|chat|url|source/i);
    expect(init.redirect).toBe("error");
    return new Response(null, { status: 204 });
  });
  const client = new KnowledgePromotionClient({
    origin: new URL("http://knowledge-worker:8082/"),
    identity,
    fetch,
  });

  await expect(client.promote({ question: "Cardano?", language: "vi" })).resolves.toBeUndefined();
});
```

- [ ] **Step 2: Run the new test and confirm missing-module failure**

```bash
npm test -- tests/knowledgePromotionProtocol.test.ts
```

Expected: FAIL because the protocol and client modules do not exist.

- [ ] **Step 3: Implement fixed protocol constants and validators**

Create `knowledgePromotionProtocol.ts` around these exported contracts:

```ts
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { findWalletSecret } from "@vennek/cardano-agent";

export const KNOWLEDGE_PROMOTION_PATH = "/internal/knowledge/promote";
export const KNOWLEDGE_PROMOTION_MAX_BODY_BYTES = 64 * 1024;
export const KNOWLEDGE_PROMOTION_MAX_QUERY_CODE_POINTS = 4_096;
export const KNOWLEDGE_PROMOTION_MAX_QUERY_BYTES = 16 * 1024;
export const KNOWLEDGE_PROMOTION_CLOCK_SKEW_SECONDS = 60;

export type PromotionIdentity = Readonly<{ keyId: string; key: Buffer }>;
export type AuthenticatedPromotion = Readonly<{ requestId: string; nonceDigest: Buffer }>;

export function validatePromotionQuestion(value: unknown): string {
  if (typeof value !== "string") throw new Error("Promotion question is invalid.");
  const question = value.normalize("NFC").trim();
  if (
    !question ||
    Array.from(question).length > KNOWLEDGE_PROMOTION_MAX_QUERY_CODE_POINTS ||
    Buffer.byteLength(question, "utf8") > KNOWLEDGE_PROMOTION_MAX_QUERY_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(question) ||
    /\bsite\s*:/iu.test(question) ||
    findWalletSecret(question)
  ) throw new Error("Promotion question is invalid.");
  return question;
}

export function parsePromotionIdentity(keyIdValue: unknown, keyValue: unknown): PromotionIdentity {
  if (typeof keyIdValue !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(keyIdValue)) {
    throw new Error("Knowledge promotion key ID is invalid.");
  }
  if (typeof keyValue !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/u.test(keyValue) || keyValue.length % 4 !== 0) {
    throw new Error("Knowledge promotion key must be canonical base64.");
  }
  const key = Buffer.from(keyValue, "base64");
  if (key.length !== 32 || key.toString("base64") !== keyValue) {
    throw new Error("Knowledge promotion key must decode to 32 bytes.");
  }
  return Object.freeze({ keyId: keyIdValue, key });
}
```

Implement `signPromotionQuestion` and `authenticatePromotionRequest` using this exact canonical string and decoded 32-byte signature comparison:

```ts
function canonicalSignature(input: {
  keyId: string; requestId: string; timestamp: string; nonce: string; body: Buffer;
}): string {
  const bodyHash = createHash("sha256").update(input.body).digest("base64url");
  return [
    "VENNEK-PROMOTION-V1", "POST", KNOWLEDGE_PROMOTION_PATH,
    input.keyId, input.requestId, input.timestamp, input.nonce, bodyHash,
  ].join("\n");
}
```

Require UUID syntax, exactly 16 decoded nonce bytes, integer Unix seconds, exact key ID, exact method/path, exact five required `X-Vennek-*` headers, `Content-Type: application/json`, and a signature decoding to 32 bytes. Base64url nonce/signature values must round-trip canonically. Copy key bytes before retaining them. Compute nonce digest with SHA-256. Do not parse the JSON body inside authentication.

Add `validatePromotionBody(body: Buffer): { question: string }` after authentication; it parses UTF-8 JSON, requires a plain object with exactly `question`, and calls `validatePromotionQuestion`.

- [ ] **Step 4: Implement the client with the existing fetch platform**

Create a client with no redirect, a 50-second default timeout, and a fixed origin:

```ts
export class KnowledgePromotionClient {
  constructor(private readonly config: {
    origin: URL;
    identity: PromotionIdentity;
    fetch?: typeof globalThis.fetch;
    timeoutMs?: number;
  }) {
    if (!isHttpOrigin(config.origin)) throw new Error("Knowledge promotion origin is invalid.");
  }

  async promote(input: QuestionRetrievalInput): Promise<void> {
    const signed = signPromotionQuestion(input.question, this.config.identity);
    const response = await (this.config.fetch ?? fetch)(
      new URL(KNOWLEDGE_PROMOTION_PATH, this.config.origin),
      {
        method: "POST",
        headers: signed.headers,
        body: signed.body,
        redirect: "error",
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 50_000),
      },
    ).catch(() => { throw new Error("Knowledge promotion request failed."); });
    if (response.status !== 204) throw new Error("Knowledge promotion request failed.");
  }
}
```

Export `parsePromotionOrigin(value: unknown): URL`; it must reject credentials, path other than `/`, search, hash, and protocols other than HTTP(S). The client validates its constructor origin through this function. Export the client and public types from `apps/telegram-bot/src/index.ts`; never expose key bytes in logs or string formatting.

- [ ] **Step 5: Run protocol and package tests**

```bash
npm test -- tests/knowledgePromotionProtocol.test.ts tests/cardanoAgentPackage.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/telegram-bot/src/knowledgePromotionProtocol.ts apps/telegram-bot/src/knowledgePromotionClient.ts apps/telegram-bot/src/index.ts tests/knowledgePromotionProtocol.test.ts
git commit -m "feat: sign private knowledge promotion requests"
```

---

### Task 3: Add durable replay claims and content-free audit

**Files:**

- Create: `packages/cardano-agent/migrations/006_knowledge_promotion_requests.sql`
- Create: `packages/cardano-agent/src/knowledge/promotionAudit.ts`
- Create: `tests/promotionAudit.integration.test.ts`
- Modify: `packages/cardano-agent/src/index.ts`

- [ ] **Step 1: Write the migration with database-enforced invariants**

Create the table without a sequence:

```sql
CREATE TABLE knowledge_promotion_requests (
  request_id uuid PRIMARY KEY,
  caller_id text NOT NULL CHECK (caller_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  nonce_digest bytea NOT NULL UNIQUE CHECK (octet_length(nonce_digest) = 32),
  state text NOT NULL CHECK (state IN ('started', 'succeeded', 'failed')),
  outcome text CHECK (outcome IN (
    'promoted', 'no_match', 'busy', 'timeout',
    'upstream_failed', 'invalid_authenticated_request'
  )),
  promoted_count smallint NOT NULL DEFAULT 0 CHECK (promoted_count BETWEEN 0 AND 3),
  latency_ms integer CHECK (latency_ms BETWEEN 0 AND 3600000),
  received_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK (
    (state = 'started' AND outcome IS NULL AND completed_at IS NULL AND latency_ms IS NULL)
    OR
    (state = 'succeeded' AND outcome IN ('promoted', 'no_match') AND completed_at IS NOT NULL AND latency_ms IS NOT NULL)
    OR
    (state = 'failed' AND outcome IN ('busy', 'timeout', 'upstream_failed', 'invalid_authenticated_request') AND completed_at IS NOT NULL AND latency_ms IS NOT NULL)
  )
);

CREATE INDEX knowledge_promotion_requests_received_at_idx
  ON knowledge_promotion_requests (received_at);
```

- [ ] **Step 2: Write failing real-PostgreSQL tests**

Guard with `TEST_DATABASE_URL`, following existing integration tests. Prove one concurrent winner, exact replay classification, no question/body columns, terminal constraints, and bounded pruning:

```ts
describe.skipIf(!databaseUrl)("promotion audit", () => {
  it("claims one request globally and classifies exact and partial replays", async () => {
    const db = createDatabase(databaseUrl!);
    const audit = new PromotionAuditRepository(db);
    const requestId = randomUUID();
    const nonceDigest = randomBytes(32);

    const claims = await Promise.all(Array.from({ length: 8 }, () => audit.claim({
      requestId,
      callerId: "agent-worker-v1",
      nonceDigest,
    })));

    expect(claims.filter((claim) => claim.kind === "claimed")).toHaveLength(1);
    expect(claims.filter((claim) => claim.kind === "running")).toHaveLength(7);
    await audit.complete(requestId, { outcome: "no_match", promotedCount: 0, latencyMs: 5 });
    await expect(audit.claim({ requestId, callerId: "agent-worker-v1", nonceDigest }))
      .resolves.toEqual({ kind: "completed", outcome: "no_match" });
    await expect(audit.claim({ requestId: randomUUID(), callerId: "agent-worker-v1", nonceDigest }))
      .resolves.toEqual({ kind: "conflict" });
    await db.end();
  });
});
```

- [ ] **Step 3: Run the integration test and confirm missing-module or relation failure**

```bash
TEST_DATABASE_URL="$TEST_DATABASE_URL" npm test -- tests/promotionAudit.integration.test.ts
```

Expected: FAIL because the repository/table is absent. If `TEST_DATABASE_URL` is not set, start the plan's fresh PostgreSQL test container first; do not accept a skipped result for this task.

- [ ] **Step 4: Implement the audit repository**

Expose these stable types:

```ts
export type PromotionOutcome =
  | "promoted" | "no_match" | "busy" | "timeout"
  | "upstream_failed" | "invalid_authenticated_request";

export type PromotionClaim =
  | { kind: "claimed" }
  | { kind: "running" }
  | { kind: "conflict" }
  | { kind: "completed"; outcome: PromotionOutcome };
```

`claim` must use `BEGIN`, `INSERT ... ON CONFLICT DO NOTHING RETURNING request_id`, and on conflict select by `request_id = $1 OR nonce_digest = $2`. Return `running` only when both identifiers match a `started` row, `completed` only when both match a terminal row, and `conflict` for every partial match. Roll back and release safely on errors.

`complete` must derive `state` from outcome, update only `WHERE request_id = $1 AND state = 'started'`, and require exactly one updated row. `prune(now)` must execute one statement capped at 1,000 rows:

```sql
DELETE FROM knowledge_promotion_requests
WHERE request_id IN (
  SELECT request_id FROM knowledge_promotion_requests
  WHERE received_at < $1::timestamptz - interval '30 days'
  ORDER BY received_at
  LIMIT 1000
)
```

Validate UUID, 32-byte digest, promoted count, latency, and outcomes before touching the pool. Export the repository and types from `packages/cardano-agent/src/index.ts`.

- [ ] **Step 5: Apply migrations and run integration tests**

```bash
DATABASE_URL="$TEST_DATABASE_URL" npm run migrate:agent
TEST_DATABASE_URL="$TEST_DATABASE_URL" npm test -- tests/promotionAudit.integration.test.ts
```

Expected: migration `006_knowledge_promotion_requests.sql` applies once and tests PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cardano-agent/migrations/006_knowledge_promotion_requests.sql packages/cardano-agent/src/knowledge/promotionAudit.ts packages/cardano-agent/src/index.ts tests/promotionAudit.integration.test.ts
git commit -m "feat: prevent knowledge promotion replays durably"
```

---

### Task 4: Orchestrate official-first bounded promotion

**Files:**

- Modify: `packages/cardano-agent/src/knowledge/liveDiscovery.ts`
- Modify: `packages/cardano-agent/src/index.ts`
- Modify: `tests/liveDiscovery.test.ts`

- [ ] **Step 1: Write failing tier and cap tests**

Add tests that an official hit suppresses community fallback, community runs only when official has no exact registry match, duplicate source IDs collapse, and promotion stops at three:

```ts
it("promotes official matches first and never exceeds three unique sources", async () => {
  const fourDistinctOfficialEntries = Array.from({ length: 4 }, (_, index) => ({
    ...entry,
    id: `official-${index}`,
    url: `https://docs${index}.cardano.org/`,
    allowedDomains: [`docs${index}.cardano.org`],
  }));
  const search = vi.fn()
    .mockResolvedValueOnce([
      result("https://docs0.cardano.org/a"),
      result("https://docs1.cardano.org/b"),
      result("https://docs2.cardano.org/c"),
      result("https://docs3.cardano.org/d"),
    ]);
  const promote = vi.fn(async (link: DiscoveredLink) => ({ ...link, sourceId: link.matchedSourceId! }));

  const output = await promoteQuestionSources({
    question: "latest Cardano node",
    registry: fourDistinctOfficialEntries,
    search: { search },
    promote,
    signal: new AbortController().signal,
  });

  expect(output).toEqual({ outcome: "promoted", promotedCount: 3 });
  expect(promote).toHaveBeenCalledTimes(3);
  expect(search).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: Run the test and confirm missing export failure**

```bash
npm test -- tests/liveDiscovery.test.ts
```

Expected: FAIL because tier selection and `promoteQuestionSources` do not exist.

- [ ] **Step 3: Add explicit tier selection without duplicating discovery**

Extend `DiscoverLiveSourcesInput` with `trustTier?: "official" | "community"`, defaulting to `official`. Build the `site:` restriction only from entries in that tier. Keep URL normalization and exact registry matching unchanged.

Add a small orchestrator with injected promotion for direct testing:

```ts
export type PromoteQuestionSourcesInput = {
  question: string;
  registry: unknown;
  search: LiveDiscoverySearch;
  promote: (link: DiscoveredLink, signal: AbortSignal, deadlineAt: number) => Promise<unknown>;
  signal?: AbortSignal;
  now?: () => number;
};

export async function promoteQuestionSources(input: PromoteQuestionSourcesInput): Promise<{
  outcome: "promoted" | "no_match";
  promotedCount: number;
}> {
  const startedAt = (input.now ?? Date.now)();
  const deadlineAt = startedAt + 45_000;
  const deadline = AbortSignal.timeout(45_000);
  const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
  let links = await discoverLiveSources({
    query: input.question, registry: input.registry, search: input.search,
    trustTier: "official", signal,
  });
  if (!links.some((link) => link.matchedSourceId)) {
    links = await discoverLiveSources({
      query: input.question, registry: input.registry, search: input.search,
      trustTier: "community", signal,
    });
  }
  const selected = uniqueMatchedSources(links).slice(0, 3);
  let promotedCount = 0;
  for (const link of selected) {
    signal.throwIfAborted();
    await input.promote(link, signal, deadlineAt);
    promotedCount += 1;
  }
  return { outcome: promotedCount > 0 ? "promoted" : "no_match", promotedCount };
}
```

Implement `uniqueMatchedSources` locally with a `Set<string>` and exclude links without `matchedSourceId`. Do not add a generic pipeline abstraction. Export the new contract from the package index.

- [ ] **Step 4: Run discovery tests**

```bash
npm test -- tests/liveDiscovery.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cardano-agent/src/knowledge/liveDiscovery.ts packages/cardano-agent/src/index.ts tests/liveDiscovery.test.ts
git commit -m "feat: promote bounded live Cardano sources"
```

---

### Task 5: Build the private promotion HTTP server

**Files:**

- Create: `apps/telegram-bot/src/knowledgePromotionServer.ts`
- Create: `tests/knowledgePromotionServer.test.ts`

- [ ] **Step 1: Write failing server state-machine tests**

Use an ephemeral loopback port and injected audit/operation fakes. Cover 401 before parse/audit, duplicate security headers, 413 before allocation beyond the cap, authenticated invalid body -> audited 400, exact completed replay -> stored status, partial replay/running -> 409, second live request -> audited 503 busy, timeout/upstream -> sanitized 503, and no response body:

```ts
const identity = { keyId: "agent-worker-v1", key: Buffer.alloc(32, 7) };
const fixed = {
  now: new Date("2026-08-25T00:00:00.000Z"),
  requestId: "11111111-1111-4111-8111-111111111111",
  nonce: Buffer.alloc(16, 9),
};

async function listenForTest(server: Server): Promise<URL> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind TCP.");
  return new URL(`http://127.0.0.1:${address.port}/`);
}

async function closeForTest(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

it("authenticates, claims, promotes once, and returns no content", async () => {
  const audit = fakeAudit({ claim: { kind: "claimed" } });
  const promote = vi.fn().mockResolvedValue({ outcome: "promoted", promotedCount: 2 });
  const server = createKnowledgePromotionServer({ identity, audit, promote });
  const origin = await listenForTest(server);
  const signed = signPromotionQuestion("latest Cardano node", identity, fixed);

  const response = await fetch(new URL(KNOWLEDGE_PROMOTION_PATH, origin), {
    method: "POST", headers: signed.headers, body: signed.body,
  });

  expect(response.status).toBe(204);
  expect(await response.text()).toBe("");
  expect(promote).toHaveBeenCalledWith("latest Cardano node", expect.any(AbortSignal));
  expect(audit.complete).toHaveBeenCalledWith(fixed.requestId, expect.objectContaining({
    outcome: "promoted", promotedCount: 2,
  }));
  await closeForTest(server);
});
```

- [ ] **Step 2: Run the test and confirm missing-module failure**

```bash
npm test -- tests/knowledgePromotionServer.test.ts
```

Expected: FAIL because the server module does not exist.

- [ ] **Step 3: Implement the bounded Node adapter**

Create `createKnowledgePromotionServer` using `createServer({ maxHeaderSize: 8 * 1024 })`. Accept only exact `POST` and exact path. Inspect `request.rawHeaders` and reject duplicate `X-Vennek-*` or `Content-Type` headers before building normalized headers. Read the stream into chunks only while total bytes are at most 64 KiB; reject an oversized `Content-Length` immediately and destroy/stop reading after overflow. Return 404 for other paths and 405 for other methods.

Use this dependency shape so production and tests share the state machine:

```ts
export type KnowledgePromotionServerDependencies = {
  identity: PromotionIdentity;
  audit: Pick<PromotionAuditRepository, "claim" | "complete" | "prune">;
  promote: (question: string, signal: AbortSignal) => Promise<{
    outcome: "promoted" | "no_match";
    promotedCount: number;
  }>;
  now?: () => Date;
};
```

The request sequence is exact:

```ts
const authenticated = authenticatePromotionRequest(authInput);
const claim = await dependencies.audit.claim({
  requestId: authenticated.requestId,
  callerId: dependencies.identity.keyId,
  nonceDigest: authenticated.nonceDigest,
});
if (claim.kind === "completed") return statusForOutcome(claim.outcome);
if (claim.kind === "running" || claim.kind === "conflict") return 409;

let body: { question: string };
try { body = validatePromotionBody(rawBody); }
catch {
  await finish("invalid_authenticated_request", 0);
  return 400;
}
if (active) {
  await finish("busy", 0);
  return 503;
}
active = true;
try {
  const result = await dependencies.promote(body.question, requestSignal);
  await finish(result.outcome, result.promotedCount);
  return 204;
} catch (error) {
  const outcome = requestSignal.aborted ? "timeout" : "upstream_failed";
  await finish(outcome, 0);
  return 503;
} finally {
  active = false;
}
```

`requestSignal` is `AbortSignal.any([clientDisconnectSignal, AbortSignal.timeout(45_000)])`. `finish` clamps latency to the migration bound. Never serialize errors. After accepted requests, run `audit.prune(now)` only when an in-memory `nextPruneAt` is reached; advance it one hour even if pruning fails so a database incident does not create a tight retry loop. Task 7 performs the required startup prune before listening.

- [ ] **Step 4: Run server tests**

```bash
npm test -- tests/knowledgePromotionServer.test.ts tests/knowledgePromotionProtocol.test.ts
npm run typecheck
```

Expected: PASS with no leaked question, URL, or injected provider error in responses.

- [ ] **Step 5: Commit**

```bash
git add apps/telegram-bot/src/knowledgePromotionServer.ts tests/knowledgePromotionServer.test.ts
git commit -m "feat: serve replay-safe knowledge promotion privately"
```

---

### Task 6: Connect the existing Agent Core discovery seam

**Files:**

- Modify: `apps/telegram-bot/src/agentWorker.ts`
- Modify: `apps/telegram-bot/src/main.ts`
- Modify: `tests/agentWorker.test.ts`
- Modify: `tests/runtimeComposition.test.ts`
- Modify: `tests/agentConfig.test.ts`

- [ ] **Step 1: Write failing composition tests**

Prove empty/stale evidence invokes discovery once, sends only question to the injected client, retrieves exactly twice, and leaves greetings/secrets untouched:

```ts
it("injects question-only discovery between the two retrieval attempts", async () => {
  const freshEvidence = {
    id: "chunk-1", sourceId: "cardano-docs", owner: "Cardano Foundation",
    trustTier: "official", title: "Cardano docs", url: "https://docs.cardano.org/",
    excerpt: "Fresh Cardano evidence", retrievedAt: "2026-08-25T00:00:00.000Z",
    versionHash: "a".repeat(64), stale: false,
  };
  const retrieve = vi.fn()
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([freshEvidence]);
  const discover = vi.fn().mockResolvedValue(undefined);
  const dependencies = createRuntimeAgentDependencies(db as never, config(), {
    embedder, retrieve, complete, discover,
  });

  await dependencies.discover?.({ question: "Latest node?", language: "vi" });

  expect(discover).toHaveBeenCalledWith({ question: "Latest node?", language: "vi" });
});
```

Extend the existing `createAgentAnswer` test to assert the `discover` function is passed through to `answerQuestion` and invoked by empty/stale retrieval.

- [ ] **Step 2: Run focused tests and confirm discovery is absent**

```bash
npm test -- tests/agentWorker.test.ts tests/runtimeComposition.test.ts tests/agentConfig.test.ts
```

Expected: FAIL because `AgentAnswerDependencies` and runtime clients do not expose `discover`.

- [ ] **Step 3: Pass the optional dependency through without changing Agent Core flow**

Add one optional field:

```ts
export type AgentAnswerDependencies = {
  retrieve: (input: QuestionRetrievalInput) => Promise<unknown>;
  discover?: (input: QuestionRetrievalInput) => Promise<void>;
  complete: (input: AnswerCompletionInput) => Promise<CompletionOutput>;
  models: Readonly<Record<ModelProfile, string>>;
  recordUsage: (telegramUserId: string, usage: AnswerUsage) => Promise<void> | void;
};
```

Pass `discover: dependencies.discover` only when defined in `createAgentAnswer`. Add the same optional field to `RuntimeAgentClients` and the returned runtime dependency object. Do not alter the already-tested discovery/retrieval ordering inside `answerQuestion`.

- [ ] **Step 4: Parse promotion client configuration only in worker mode**

Add an exported parser in `main.ts`:

```ts
export function parseKnowledgePromotionClientConfig(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): { origin: URL; identity: PromotionIdentity } {
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  const origin = parsePromotionOrigin(required("KNOWLEDGE_PROMOTION_URL"));
  const identity = parsePromotionIdentity(
    required("KNOWLEDGE_PROMOTION_KEY_ID"),
    required("KNOWLEDGE_PROMOTION_KEY"),
  );
  return { origin, identity };
}
```

`runWorker` constructs `KnowledgePromotionClient` and injects `client.promote.bind(client)`. Polling and one-shot CLI modes do not require promotion credentials and keep discovery disabled.

- [ ] **Step 5: Run agent/runtime tests**

```bash
npm test -- tests/answerQuestion.test.ts tests/agentWorker.test.ts tests/runtimeComposition.test.ts tests/agentConfig.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/telegram-bot/src/agentWorker.ts apps/telegram-bot/src/main.ts tests/agentWorker.test.ts tests/runtimeComposition.test.ts tests/agentConfig.test.ts
git commit -m "feat: retry Cardano retrieval after private discovery"
```

---

### Task 7: Run promotion inside the restricted knowledge worker

**Files:**

- Modify: `apps/telegram-bot/src/main.ts`
- Modify: `tests/knowledgeRuntime.test.ts`
- Modify: `tests/knowledgeWorker.test.ts`

- [ ] **Step 1: Write failing knowledge configuration tests**

Require server-only port/key/SearX values and reject unsafe origins, out-of-range ports, noncanonical keys, or client-only URL variables:

```ts
it("requires the private promotion server and SearXNG only for knowledge worker mode", () => {
  const config = parseKnowledgeRuntimeConfig({
    DATABASE_KNOWLEDGE_URL: "postgresql://knowledge@postgres/vennek",
    LITELLM_BASE_URL: "http://litellm:4000",
    LITELLM_API_KEY: "key",
    VENNEK_EMBEDDING_MODEL: "cardano-embedding",
    SEARXNG_BASE_URL: "http://searxng.internal:8080/",
    KNOWLEDGE_PROMOTION_PORT: "8082",
    KNOWLEDGE_PROMOTION_KEY_ID: "agent-worker-v1",
    KNOWLEDGE_PROMOTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  });

  expect(config.promotionPort).toBe(8082);
  expect(config.searxngBaseUrl.href).toBe("http://searxng.internal:8080/");
  expect(config.promotionIdentity.key).toHaveLength(32);
});
```

- [ ] **Step 2: Run tests and confirm required fields are absent**

```bash
npm test -- tests/knowledgeRuntime.test.ts tests/knowledgeWorker.test.ts
```

Expected: FAIL because `KnowledgeRuntimeConfig` does not contain promotion configuration.

- [ ] **Step 3: Compose the existing knowledge components**

Extend `KnowledgeRuntimeConfig` with:

```ts
searxngBaseUrl: URL;
promotionPort: number;
promotionIdentity: PromotionIdentity;
```

In `runKnowledgeWorker`, reuse the already-created `db`, `repository`, `embedder`, registry loader, and optional `pdfExtractor`. Construct one `SearxngClient`, one `PromotionAuditRepository`, and one promotion server. Load the registry once per request and pass that same snapshot through both discovery and promotion revalidation:

```ts
const registry = loadKnowledgeSourceRegistry();
promoteQuestionSources({
  question,
  registry,
  search: searxng,
  signal,
  promote: async (link, promotionSignal, deadlineAt) => {
    const promoted = await promoteDiscoveredLink({
      link,
      registry,
      repository,
      embedder,
      embeddingModel: config.embeddingModel,
      signal: promotionSignal,
      deadlineAt,
      ...(pdfExtractor ? { pdfExtractor } : {}),
    });
    if (!("sourceId" in promoted)) throw new Error("Live source was not registry-approved.");
  },
});
```

After database/pg-boss startup, call `await audit.prune(new Date()).catch(() => undefined)`, then start the private server on the configured port. Close it before stopping pg-boss/database. Use the existing signal/drain helpers. Do not give the knowledge worker Telegram, conversation-encryption, or owner credentials.

- [ ] **Step 4: Run knowledge runtime tests**

```bash
npm test -- tests/knowledgeRuntime.test.ts tests/knowledgeWorker.test.ts tests/liveDiscovery.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/telegram-bot/src/main.ts tests/knowledgeRuntime.test.ts tests/knowledgeWorker.test.ts
git commit -m "feat: host live discovery in the knowledge worker"
```

---

### Task 8: Enforce least privilege for both database roles

**Files:**

- Modify: `scripts/provision-knowledge-role.ts`
- Modify: `tests/provisionKnowledgeRole.integration.test.ts`
- Modify: `tests/provisionAppRole.integration.test.ts`

- [ ] **Step 1: Write failing role assertions**

Extend the real knowledge-role test:

```ts
await expect(app.query(`INSERT INTO knowledge_promotion_requests
  (request_id, caller_id, nonce_digest, state)
  VALUES ($1, 'agent-worker-v1', decode($2, 'hex'), 'started')`, [randomUUID(), randomBytes(32).toString("hex")]))
  .resolves.toMatchObject({ rowCount: 1 });
await expect(app.query("SELECT * FROM conversation_messages LIMIT 1"))
  .rejects.toThrow(/permission denied/i);
```

Extend the real application-role test to prove it cannot read or write the new table:

```ts
await expect(app.query("SELECT * FROM knowledge_promotion_requests LIMIT 1"))
  .rejects.toThrow(/permission denied/i);
await expect(app.query(`INSERT INTO knowledge_promotion_requests
  (request_id, caller_id, nonce_digest, state)
  VALUES ($1, 'agent-worker-v1', decode($2, 'hex'), 'started')`, [randomUUID(), randomBytes(32).toString("hex")]))
  .rejects.toThrow(/permission denied/i);
```

- [ ] **Step 2: Run both real role tests and confirm the knowledge grant is missing**

```bash
TEST_DATABASE_OWNER_URL="$TEST_DATABASE_OWNER_URL" npm test -- \
  tests/provisionKnowledgeRole.integration.test.ts \
  tests/provisionAppRole.integration.test.ts
```

Expected: knowledge-role test FAILS for the missing audit grant; app-role denial already holds or is fixed at the root provisioner if it does not. Do not accept skipped tests; use the fresh PostgreSQL owner URL.

- [ ] **Step 3: Grant only exact audit operations**

After the existing public-table revocation in `provision-knowledge-role.ts`, add:

```ts
await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.knowledge_promotion_requests TO ${roleIdentifier}`);
```

No sequence grant is needed. Keep `conversation_messages`, `usage_ledger`, default `pgboss`, database `CREATE`, and schema `CREATE` denied. Inspect `information_schema.role_table_grants` for the exact table/verbs. Do not grant any promotion-audit privilege from `provision-app-role.ts`; its existing revoke-then-explicit-grant pattern remains the root policy.

- [ ] **Step 4: Run both role tests**

```bash
TEST_DATABASE_OWNER_URL="$TEST_DATABASE_OWNER_URL" npm test -- \
  tests/provisionKnowledgeRole.integration.test.ts \
  tests/provisionAppRole.integration.test.ts
```

Expected: PASS with zero skips.

- [ ] **Step 5: Commit**

```bash
git add scripts/provision-knowledge-role.ts tests/provisionKnowledgeRole.integration.test.ts tests/provisionAppRole.integration.test.ts
git commit -m "feat: restrict knowledge promotion audit access"
```

---

### Task 9: Wire the private endpoint without publishing it

**Files:**

- Modify: `docker-compose.yml`
- Modify: `.env.example`
- Modify: `deploy/vennek.env.example`
- Modify: `tests/compose.test.ts`

- [ ] **Step 1: Write failing Compose assertions**

Extend the rendered-service type in `tests/compose.test.ts` with `expose?: string[]`, then assert:

```ts
expect(config.services["agent-worker"]?.environment?.KNOWLEDGE_PROMOTION_URL)
  .toBe("http://knowledge-worker:8082");
expect(config.services["knowledge-worker"]?.environment?.KNOWLEDGE_PROMOTION_PORT)
  .toBe("8082");
expect(config.services["knowledge-worker"]?.environment?.SEARXNG_BASE_URL)
  .toBe("https://search.example.test/");
expect(config.services["knowledge-worker"]?.ports).toBeUndefined();
expect(config.services["knowledge-worker"]?.expose).toContain("8082");
expect(config.services["telegram-webhook"]?.environment?.KNOWLEDGE_PROMOTION_KEY)
  .toBeUndefined();
```

- [ ] **Step 2: Run the Compose test and confirm missing endpoint wiring**

```bash
npm test -- tests/compose.test.ts
```

Expected: FAIL for missing promotion environment and private exposed port.

- [ ] **Step 3: Wire secrets to only the two participants**

Add these example variables using a canonical 32-byte base64 value:

```dotenv
KNOWLEDGE_PROMOTION_KEY_ID=agent-worker-v1
KNOWLEDGE_PROMOTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
KNOWLEDGE_PROMOTION_PORT=8082
KNOWLEDGE_PROMOTION_URL=http://knowledge-worker:8082
SEARXNG_BASE_URL=https://search.example.test/
```

In Compose:

- agent worker receives URL, key ID, and key;
- knowledge worker receives port, key ID, key, and SearXNG origin;
- knowledge worker uses `expose: ["8082"]`, never `ports`;
- webhook receives none of these values;
- knowledge worker still receives no Telegram token, webhook secret, encryption key, owner URL, or generation-model aliases.

Do not claim that a second Docker network isolates the endpoint while both services share `default`; HMAC remains the primary boundary.

- [ ] **Step 4: Run deployment tests**

```bash
npm test -- tests/compose.test.ts tests/knowledgeRuntime.test.ts tests/agentConfig.test.ts
docker compose --env-file .env.example config --quiet
```

Expected: PASS; rendered knowledge-worker has no host port.

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yml .env.example deploy/vennek.env.example tests/compose.test.ts
git commit -m "feat: isolate live discovery deployment credentials"
```

---

### Task 10: Prove the complete promotion-and-retrieval path

**Files:**

- Create: `tests/knowledgePromotion.integration.test.ts`
- Modify: `tests/runtimeComposition.test.ts`

- [ ] **Step 1: Write the failing integration smoke test**

Use a fresh migrated PostgreSQL/pgvector database, the real `PromotionAuditRepository`, a real loopback promotion server, deterministic SearXNG/fetch/embedder boundaries, and real `KnowledgeRepository`. The test must prove the second retrieval sees the immutable promoted chunk and the audit row contains no content:

```ts
describe.skipIf(!databaseUrl)("knowledge promotion integration", () => {
  it("promotes through the private endpoint and becomes retrievable", async () => {
    const db = createDatabase(databaseUrl!);
    const audit = new PromotionAuditRepository(db);
    const server = createKnowledgePromotionServer({
      identity,
      audit,
      promote: async (question, signal) => {
        const repository = new KnowledgeRepository(db);
        return promoteQuestionSources({
          question,
          registry: [fixtureEntry],
          search: { search: async () => [{
            url: "https://docs.example.test/new-cardano-detail",
            title: "New Cardano detail",
            content: "New Cardano protocol detail",
          }] },
          signal,
          promote: async (link, promotionSignal, deadlineAt) => {
            const promoted = await promoteDiscoveredLink({
              link,
              registry: [fixtureEntry],
              repository,
              embedder,
              embeddingModel,
              signal: promotionSignal,
              deadlineAt,
              lookup: async () => [{ address: "93.184.216.34", family: 4 }],
              request: fixtureHttpsRequest("<html><body><h1>New Cardano detail</h1><p>New Cardano protocol detail.</p></body></html>"),
            });
            if (!("sourceId" in promoted)) throw new Error("Fixture source was not promoted.");
          },
        });
      },
    });
    const origin = await listenForTest(server);
    const client = new KnowledgePromotionClient({ origin, identity });

    await client.promote({ question: "new Cardano protocol detail", language: "en" });
    const evidence = await retrieveEvidence(
      { query: "new Cardano protocol detail", language: "en", embeddingModel, cachePolicy: "none" },
      { db, embedder },
    );

    expect(evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: fixtureEntry.id, versionHash: expect.stringMatching(/^[0-9a-f]{64}$/) }),
    ]));
    const columns = await db.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns
      WHERE table_name = 'knowledge_promotion_requests'`);
    expect(columns.rows.map((row) => row.column_name)).not.toEqual(expect.arrayContaining([
      "question", "body", "url", "content", "error",
    ]));
    await closeForTest(server);
    await db.end();
  });
});
```

Define `fixtureEntry` as an official `SourceRegistryEntry` for `https://docs.example.test/`. Define `fixtureHttpsRequest` with the same `Readable.from` fixed-response shape already used in `tests/liveDiscovery.test.ts`; include status 200, `content-type: text/html`, and exact `content-length`. Define local `listenForTest` and `closeForTest` helpers with the complete `Server.listen(0, "127.0.0.1")` and `Server.close` implementations shown in Task 5. These deterministic boundaries must not use the public internet.

- [ ] **Step 2: Run the test and confirm the end-to-end seam is incomplete**

```bash
TEST_DATABASE_URL="$TEST_DATABASE_URL" npm test -- tests/knowledgePromotion.integration.test.ts
```

Expected: FAIL until the runtime operation fixture uses all completed R8b components.

- [ ] **Step 3: Complete only missing composition seams**

If the failure is an integration mismatch, fix it in the shared production seam (`createRuntimeAgentDependencies`, `promoteQuestionSources`, server dependency composition, or exported type), not in a test-only alternate implementation. Keep the test fixture limited to deterministic network/provider responses.

Every code edit in this step must be followed immediately by:

```bash
TEST_DATABASE_URL="$TEST_DATABASE_URL" npm test -- tests/knowledgePromotion.integration.test.ts
```

Expected: PASS and one terminal audit row.

- [ ] **Step 4: Run the focused R8b suite**

```bash
TEST_DATABASE_URL="$TEST_DATABASE_URL" TEST_DATABASE_OWNER_URL="$TEST_DATABASE_OWNER_URL" npm test -- \
  tests/knowledgePromotionProtocol.test.ts \
  tests/promotionAudit.integration.test.ts \
  tests/knowledgePromotionServer.test.ts \
  tests/knowledgePromotion.integration.test.ts \
  tests/liveDiscovery.test.ts \
  tests/answerQuestion.test.ts \
  tests/agentWorker.test.ts \
  tests/runtimeComposition.test.ts \
  tests/knowledgeRuntime.test.ts \
  tests/provisionKnowledgeRole.integration.test.ts \
  tests/compose.test.ts
```

Expected: all selected tests PASS with zero skips for PostgreSQL/role tests.

- [ ] **Step 5: Commit**

```bash
git add tests/knowledgePromotion.integration.test.ts tests/runtimeComposition.test.ts
git commit -m "test: prove live Cardano promotion end to end"
```

Before committing, inspect `git diff --cached --name-only`. If Step 3 required a shared production fix, commit that exact source file and its focused failing test separately before this integration-test commit; never stage whole directories.

---

### Task 11: Full verification, independent reviews, and R8b closeout

**Files:**

- Modify after all gates pass: `docs/superpowers/plans/2026-08-24-cardano-knowledge-rag.md`

- [ ] **Step 1: Inspect the complete branch diff**

```bash
git status --short
git diff 8850fc8..HEAD --stat
git diff 8850fc8..HEAD --check
git diff 8850fc8..HEAD -- apps packages scripts docker-compose.yml .env.example deploy tests docs/superpowers/specs/2026-08-25-cardano-live-discovery-design.md
```

Expected: only R8b/spec/plan changes; no secrets, file-upload implementation, unrelated refactor, or host-published knowledge port.

- [ ] **Step 2: Run all static and package checks**

```bash
npm run typecheck
npm run build
npm run verify:imports
npm run validate:registry
npm audit --omit=dev
docker compose --env-file .env.example config --quiet
```

Expected: every command exits 0; audit reports zero production vulnerabilities.

- [ ] **Step 3: Run the full suite against fresh PostgreSQL/pgvector**

Create a fresh disposable database/container, run owner migrations and both role provisioners, then run:

```bash
DATABASE_OWNER_URL="$TEST_DATABASE_OWNER_URL" npm run migrate:agent
TEST_DATABASE_URL="$TEST_DATABASE_URL" TEST_DATABASE_OWNER_URL="$TEST_DATABASE_OWNER_URL" npm test
```

Expected: all tests PASS; only tests explicitly unrelated to available external infrastructure may skip. Promotion audit, role, endpoint, concurrency, and end-to-end tests must not skip.

- [ ] **Step 4: Run a real-process smoke check**

Start the compiled knowledge worker with test credentials and deterministic local SearXNG/provider fixtures. Send one correctly signed request twice and one tampered request:

```text
first signed request     -> 204, one promotion execution
exact completed replay  -> 204, zero additional executions
tampered body/signature -> 401, zero audit insert and zero execution
```

Query only safe audit columns and confirm one terminal row, `promoted_count <= 3`, and no sensitive columns.

- [ ] **Step 5: Run mandatory independent reviews**

After implementation and all verification are finished:

1. Spawn one read-only `reviewer` with the fixed base `8850fc8`, the design spec, this plan, the complete R8b diff, and verification results.
2. Spawn one separate read-only `security_reviewer` with the HMAC/replay/HTTP/SSRF/database-role/Compose trust boundaries and the same fixed base.
3. Resolve every substantiated finding in Main using a new failing test first where behavior changes.
4. Re-run targeted and full verification.
5. Send fixes back to the same reviewer(s) for re-review until both return PASS.

Expected: correctness reviewer PASS and security reviewer PASS with no unresolved substantiated finding.

- [ ] **Step 6: Mark R8b complete only now**

Change the R8b checkbox in `docs/superpowers/plans/2026-08-24-cardano-knowledge-rag.md` from `[ ]` to `[x]` and append the final commit IDs plus verified commands. Do not mark R9, R10, or R8c complete.

- [ ] **Step 7: Commit closeout documentation**

```bash
git add docs/superpowers/plans/2026-08-24-cardano-knowledge-rag.md
git commit -m "docs: close authenticated live discovery milestone"
```

- [ ] **Step 8: Remove disposable verification resources**

Stop and delete only the explicitly named temporary test containers/volumes created in Step 3. Resolve their exact names first with read-only Docker inspection. Report that disposable test data is not recoverable; never remove operator or development databases.

---

## Plan Acceptance Checklist

- [ ] R8b uses the existing discovery, fetch, extractor, repository, embedding, and retrieval seams.
- [ ] No runtime dependency, general RPC framework, cache service, or second queue is added.
- [ ] HMAC authentication precedes JSON parsing/database access.
- [ ] PostgreSQL provides global replay protection across processes and restart.
- [ ] Audit stores only caller/request metadata, safe outcome, count, and timing.
- [ ] Agent worker sends only `question` and retains read-only knowledge access.
- [ ] Knowledge worker promotes only exact registry matches, official first, at most three.
- [ ] Server operation is 45 seconds; client wait is 50 seconds; process admission is one active request.
- [ ] Internal port is not published; secrets cross only the two participating services.
- [ ] Empty/stale retrieval retries exactly once and fails safely.
- [ ] Real PostgreSQL concurrency, role, HTTP, promotion, and retrieval paths are verified.
- [ ] Independent correctness and security reviews pass after fixes.
- [ ] R8c file comparison remains a separate follow-on plan.
