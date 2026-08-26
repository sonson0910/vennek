# Cardano Source Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep challenge-protected Cardano sources visible without blocking safe ingestion, ingest Cardano Stack Exchange through its official API, and make live release gates depend only on real runtime requirements.

**Architecture:** Extend the existing strict source registry with monitor-only and explicit same-publisher fallback metadata. Reuse the hardened HTTPS reader, immutable indexing pipeline, and `knowledge_sources.fetch_state`; add one bounded Stack Exchange adapter and resolve source-family health only inside the live validator. Keep LiteLLM managed-provider credentials outside the repository and remove only the unused GitHub credential from live evaluation.

**Tech Stack:** TypeScript, Vitest, native HTTPS, Cheerio, PostgreSQL JSONB fetch state, pg-boss, LiteLLM, Stack Exchange API v2.3

**Design:** `docs/superpowers/specs/2026-08-26-cardano-source-resilience-design.md`

**Authoritative references:** Stack Exchange API
[`/questions`](https://api.stackexchange.com/docs/questions),
[`question` fields](https://api.stackexchange.com/docs/types/question),
[`backoff` and quota rules](https://api.stackexchange.com/docs/throttle), and
[CC BY-SA attribution](https://stackoverflow.com/help/licensing); Cardano
Foundation's official publisher organization at
<https://github.com/cardano-foundation>.

---

## File Map

- `packages/cardano-agent/src/knowledge/sourceRegistry.ts` — strict discriminated registry contract and cross-entry fallback validation.
- `config/cardano-sources.json` — canonical Cardano Foundation monitor plus official fallback and Stack Exchange API entry.
- `apps/telegram-bot/src/knowledgeWorker.ts` — scheduled/manual admission for ingestible entries only.
- `packages/cardano-agent/src/knowledge/stackExchangeSource.ts` — fixed-origin Stack Exchange API retrieval, parsing, attribution, limits, and deferral.
- `packages/cardano-agent/src/knowledge/knowledgeRepository.ts` — bounded Stack Exchange fetch-state compare-and-set operations.
- `packages/cardano-agent/src/knowledge/crawlSource.ts` — dispatch the new source kind into the existing crawl/index result contract.
- `packages/cardano-agent/src/knowledge/indexDocument.ts` — keep state-commit failures source-neutral.
- `scripts/validate-source-registry.ts` — raw probes plus family-level healthy/degraded/failed resolution.
- `scripts/evaluate-cardano-rag.ts` — accurate live credential list.
- `docs/architecture/data-sources.md`, `docs/deployment/release-checklist.md`, `.env.example`, and `deploy/vennek.env.example` — operating and secret requirements.

### Task 1: Extend the Strict Registry Contract

**Files:**
- Modify: `packages/cardano-agent/src/knowledge/sourceRegistry.ts`
- Modify: `packages/cardano-agent/src/index.ts`
- Modify: `config/cardano-sources.json`
- Test: `tests/sourceRegistry.test.ts`

- [ ] **Step 1: Write failing registry and configuration tests**

Add focused cases to `tests/sourceRegistry.test.ts`:

```ts
it("accepts only a direct same-owner scheduled official fallback", () => {
  const primary = {
    ...official,
    id: "foundation-web",
    owner: "Cardano Foundation",
    ingestionMode: "monitor-only" as const,
    liveFallbackIds: ["foundation-github"],
  };
  const fallback = {
    ...official,
    id: "foundation-github",
    owner: "Cardano Foundation",
    kind: "github" as const,
    url: "https://github.com/cardano-foundation",
    allowedDomains: ["github.com", "raw.githubusercontent.com", "api.github.com"],
    github: { owner: "cardano-foundation" },
  };
  expect(validateSourceRegistry([primary, fallback])).toHaveLength(2);
  expect(() => validateSourceRegistry([primary, { ...fallback, owner: "Other" }])).toThrow(/same owner/i);
  expect(() => validateSourceRegistry([
    { ...primary, liveFallbackIds: ["foundation-github"] },
    { ...fallback, ingestionMode: "monitor-only", liveFallbackIds: ["foundation-web"] },
  ])).toThrow(/scheduled fallback/i);
});

it("validates fixed Stack Exchange metadata", () => {
  const entry = {
    ...official,
    id: "cardano-stack-exchange",
    owner: "Cardano Stack Exchange",
    trustTier: "community" as const,
    kind: "stackexchange" as const,
    url: "https://api.stackexchange.com/2.3/questions",
    allowedDomains: ["api.stackexchange.com", "cardano.stackexchange.com"],
    stackExchange: { site: "cardano" as const },
  };
  expect(validateSourceRegistry([entry])).toEqual([entry]);
  expect(() => validateSourceRegistry([{ ...entry, stackExchange: { site: "stackoverflow" } }])).toThrow(/site/i);
  expect(() => validateSourceRegistry([{ ...entry, url: "https://example.com/questions" }])).toThrow(/Stack Exchange endpoint/i);
});
```

Extend the checked-in configuration assertion:

```ts
expect(config.official.find((entry) => entry.id === "cardano-foundation")).toMatchObject({
  ingestionMode: "monitor-only",
  liveFallbackIds: ["cardano-foundation-github"],
});
expect(config.community.find((entry) => entry.id === "cardano-stack-exchange")).toMatchObject({
  kind: "stackexchange",
  url: "https://api.stackexchange.com/2.3/questions",
  stackExchange: { site: "cardano" },
});
```

Add separate rejection cases for a missing fallback, duplicate fallback IDs,
self-reference, a community fallback, a monitor-only fallback, more than 16
fallback IDs, invalid `ingestionMode`, and any fallback chain.
For Stack Exchange, reject any `allowedDomains` set other than exactly
`api.stackexchange.com` plus `cardano.stackexchange.com`.

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
npm test -- --run tests/sourceRegistry.test.ts
```

Expected: FAIL because `ingestionMode`, `liveFallbackIds`, `stackexchange`, and `stackExchange` are rejected as unknown.

- [ ] **Step 3: Implement the minimal discriminated contract**

In `sourceRegistry.ts`, add and export:

```ts
export type IngestionMode = "scheduled" | "monitor-only";
export type StackExchangeScope = { site: "cardano" };
export type SourceKind = "sitemap" | "github" | "page" | "stackexchange";

type SourceRegistryEntryBase = {
  id: string;
  owner: string;
  trustTier: TrustTier;
  url: string;
  allowedDomains: string[];
  topics: string[];
  networks: CardanoNetwork[];
  refresh: RefreshRate;
  ingestionMode?: IngestionMode;
  liveFallbackIds?: string[];
};

export type SourceRegistryEntry = SourceRegistryEntryBase & (
  | { kind: "github"; github: GithubScope; stackExchange?: never }
  | { kind: "stackexchange"; stackExchange: StackExchangeScope; github?: never }
  | { kind: "sitemap" | "page"; github?: never; stackExchange?: never }
);

export function sourceIsScheduled(entry: SourceRegistryEntry): boolean {
  return entry.ingestionMode !== "monitor-only";
}
```

Add the three new field names to `ENTRY_FIELDS`, add `stackexchange` to
`SOURCE_KINDS`, validate `ingestionMode` when present, validate at most 16
unique fallback IDs with the existing lowercase ID syntax, and accept only the exact
Stack Exchange tuple:

```ts
if (kind === "stackexchange") {
  if (!isRecord(candidate.stackExchange) ||
      Object.keys(candidate.stackExchange).some((key) => key !== "site") ||
      candidate.stackExchange.site !== "cardano") {
    throw new Error(`Source entry ${index} Stack Exchange site is invalid.`);
  }
  if (url !== "https://api.stackexchange.com/2.3/questions") {
    throw new Error(`Source entry ${index} Stack Exchange endpoint is invalid.`);
  }
  if (allowedDomains.length !== 2 ||
      !allowedDomains.includes("api.stackexchange.com") ||
      !allowedDomains.includes("cardano.stackexchange.com")) {
    throw new Error(`Source entry ${index} Stack Exchange domains are invalid.`);
  }
}
```

Parse every entry first, reject duplicate IDs, then perform one cross-entry pass.
Allow `liveFallbackIds` only on a `monitor-only` official primary. For each
fallback ID, require an existing non-self, scheduled, official entry with the
exact same validated `owner` and no `liveFallbackIds`. This one-hop contract
rejects chains and cycles without graph traversal. Do not normalize or
synthesize fallback entries.

- [ ] **Step 4: Update the registry and package exports**

Set the Cardano Foundation entry to:

```json
"ingestionMode": "monitor-only",
"liveFallbackIds": ["cardano-foundation-github"]
```

Replace the Stack Exchange entry's kind, URL, domains, and metadata with:

```json
"kind": "stackexchange",
"url": "https://api.stackexchange.com/2.3/questions",
"allowedDomains": ["api.stackexchange.com", "cardano.stackexchange.com"],
"stackExchange": {"site": "cardano"}
```

Export `IngestionMode`, `StackExchangeScope`, and `sourceIsScheduled` from
`packages/cardano-agent/src/index.ts`.

- [ ] **Step 5: Verify GREEN and commit**

Run:

```bash
npm test -- --run tests/sourceRegistry.test.ts tests/liveDiscovery.test.ts
npm run validate:registry
npm run typecheck
git diff --check
```

Expected: PASS; coverage remains 18 official and 2 community sources.

```bash
git add config/cardano-sources.json packages/cardano-agent/src/knowledge/sourceRegistry.ts packages/cardano-agent/src/index.ts tests/sourceRegistry.test.ts
git commit -m "feat: model resilient Cardano source families"
```

### Task 2: Keep Monitor-Only Sources Out of Ingestion Queues

**Files:**
- Modify: `apps/telegram-bot/src/knowledgeWorker.ts`
- Test: `tests/knowledgeWorker.test.ts`

- [ ] **Step 1: Write failing scheduler, manual, and stale-job tests**

Add these behaviors to `tests/knowledgeWorker.test.ts`:

```ts
it("does not schedule or manually enqueue monitor-only sources", async () => {
  const boss = fakeBoss();
  const entries = loadKnowledgeSourceMap();
  await scheduleKnowledgeSources(boss, entries);
  expect(boss.schedule).not.toHaveBeenCalledWith(
    KNOWLEDGE_QUEUE,
    expect.any(String),
    { sourceId: "cardano-foundation" },
    expect.any(Object),
  );
  await expect(enqueueKnowledgeSource(
    boss as unknown as Pick<KnowledgeBoss, "send" | "findJobs">,
    "cardano-foundation",
  )).rejects.toThrow(/monitor-only/i);
});

it("rejects a queued source that became monitor-only before execution", async () => {
  const boss = fakeBoss();
  const sync = vi.fn();
  await registerKnowledgeWorker({ boss: boss as unknown as KnowledgeBoss, sync });
  await expect(boss.invoke({ sourceId: "cardano-foundation" })).rejects.toThrow(/monitor-only/i);
  expect(sync).not.toHaveBeenCalled();
});
```

Extend reconciliation coverage so an existing `source/cardano-foundation`
schedule is unscheduled while unrelated keys are untouched.

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
npm test -- --run tests/knowledgeWorker.test.ts
```

Expected: FAIL because the current worker schedules and admits every registry entry.

- [ ] **Step 3: Apply one shared admission policy**

Import `sourceIsScheduled` from `@vennek/cardano-agent` and apply it at all three
admission points:

```ts
export async function scheduleKnowledgeSources(
  boss: Pick<KnowledgeBoss, "schedule">,
  entries: KnowledgeSourceMap,
): Promise<void> {
  for (const entry of entries.values()) {
    if (!sourceIsScheduled(entry)) continue;
    await boss.schedule(/* existing exact arguments */);
  }
}
```

In `reconcileKnowledgeSchedules`, unschedule when the entry is missing or
`!sourceIsScheduled(entry)`. In `enqueueKnowledgeSource` and the worker callback,
throw `Source is monitor-only and cannot be synchronized.` before `send` or
`sync`. Keep job payloads as exactly `{ sourceId }`.

- [ ] **Step 4: Verify GREEN and commit**

Run:

```bash
npm test -- --run tests/knowledgeWorker.test.ts tests/knowledgeRuntime.test.ts tests/syncSource.test.ts
npm run typecheck
git diff --check
```

Expected: PASS; the fallback GitHub source retains its existing daily singleton schedule.

```bash
git add apps/telegram-bot/src/knowledgeWorker.ts tests/knowledgeWorker.test.ts
git commit -m "feat: isolate monitor-only Cardano sources"
```

### Task 3: Add Bounded Stack Exchange API Ingestion

**Files:**
- Create: `packages/cardano-agent/src/knowledge/stackExchangeSource.ts`
- Modify: `packages/cardano-agent/src/knowledge/knowledgeRepository.ts`
- Modify: `packages/cardano-agent/src/knowledge/crawlSource.ts`
- Modify: `packages/cardano-agent/src/knowledge/indexDocument.ts`
- Modify: `packages/cardano-agent/src/index.ts`
- Create: `tests/stackExchangeSource.test.ts`
- Modify: `tests/sourceCrawler.test.ts`
- Modify: `tests/knowledgeRepository.integration.test.ts`

- [ ] **Step 1: Write failing adapter contract and confinement tests**

Create `tests/stackExchangeSource.test.ts` with a fake hardened request and a
repository fake exposing `ensureSource`, `getStackExchangeFetchState`, and
`compareAndSetStackExchangeFetchState`. Cover one question and one answer:

```ts
it("maps Cardano questions and answers with author and license attribution", async () => {
  const result = await fetchStackExchangeSource({
    entry,
    repository,
    signal: new AbortController().signal,
    now: new Date("2026-08-26T00:00:00.000Z"),
    request,
  });
  expect(result.documents).toEqual(expect.arrayContaining([
    expect.objectContaining({
      canonicalUrl: "https://cardano.stackexchange.com/questions/123",
      title: expect.stringMatching(/Alice.*CC BY-SA 4\.0/),
      text: expect.stringMatching(/Alice[\s\S]*CC BY-SA 4\.0[\s\S]*question body/),
    }),
    expect.objectContaining({
      canonicalUrl: "https://cardano.stackexchange.com/a/456",
      text: expect.stringMatching(/Bob[\s\S]*answer body/),
    }),
  ]));
});
```

Add separate tests for: fixed API origin/path/site, maximum five question pages,
100 items per page, 500 documents total, 8-MiB response and 128-MiB cumulative
limits, malformed JSON/wrapper/items, attacker-controlled post links being
ignored, invalid profile links becoming `unavailable`, deleted owners,
HTML/script sanitization, duplicate IDs, cancellation, HTTP
errors, `has_more`, `quota_remaining`, bounded `backoff`, and no fetch of any
returned human link.

Add a `tests/sourceCrawler.test.ts` dispatch assertion proving the generic
BasicCrawler is not invoked for `kind: "stackexchange"`.

- [ ] **Step 2: Run the new tests and verify RED**

Run:

```bash
npm test -- --run tests/stackExchangeSource.test.ts tests/sourceCrawler.test.ts
```

Expected: FAIL because the adapter and source-kind dispatch do not exist.

- [ ] **Step 3: Add bounded Stack Exchange fetch state without a migration**

In `knowledgeRepository.ts`, add:

```ts
export type StackExchangeFetchState = {
  checkedAt?: string;
  retryAt?: string;
  quotaRemaining?: number;
};

async getStackExchangeFetchState(
  sourceId: string,
  options?: RepositoryOperationOptions,
): Promise<StackExchangeFetchState | null>;

async compareAndSetStackExchangeFetchState(
  sourceId: string,
  expectedState: StackExchangeFetchState | null,
  nextState: StackExchangeFetchState | null,
  options?: RepositoryOperationOptions,
): Promise<boolean>;
```

Use the existing `knowledge_sources.fetch_state` JSONB object at the fixed key
`stackexchange`. Reuse the current bounded compare-and-set SQL shape. Validate a
plain object with only the three fields above, canonical ISO dates, nonnegative
safe quota, and the existing 4-KiB state cap. Do not add a migration or generic
caller-chosen state key.

Add a credential-gated integration test that creates a source, persists state,
rejects an oversized/unknown-field state before SQL, and proves stale expected
state returns `false` without overwriting the current value.

- [ ] **Step 4: Implement the fixed-origin adapter**

Create `stackExchangeSource.ts` with these public contracts:

```ts
export type StackExchangeSourceInput = {
  entry: Extract<SourceRegistryEntry, { kind: "stackexchange" }>;
  repository: Pick<KnowledgeRepository,
    "ensureSource" | "getStackExchangeFetchState" | "compareAndSetStackExchangeFetchState">;
  signal: AbortSignal;
  now?: Date;
  lookup?: PublicHttpsLookup;
  request?: PublicHttpsRequest;
};

export type StackExchangeSourceResult = {
  documents: Array<{
    canonicalUrl: string;
    title: string;
    text: string;
    publishedAt: Date;
  }>;
  unchanged: number;
  deferredUntil?: Date;
  commitState?: (options?: RepositoryOperationOptions) => Promise<boolean>;
};
```

Build URLs only with `new URL("/2.3/questions", "https://api.stackexchange.com")`
and `URLSearchParams`. Set `site=cardano`, `sort=activity`, `order=desc`,
`pagesize=100`, bounded `page`, and the official `filter=withbody`, which the
live API check confirms contains body, owner, `content_license`, timestamps,
IDs, and wrapper quota/backoff fields. Process one question page and its answer
request before moving to the next page. Fetch answers only through
`/2.3/questions/{validated semicolon IDs}/answers`; never request a returned URL.
Construct citation URLs only from validated safe integers as
`https://cardano.stackexchange.com/questions/{questionId}` and
`https://cardano.stackexchange.com/a/{answerId}`; ignore post `link` fields.

Use `requestPublicHttps` and `readResponseBytesLimited`, sequential requests,
`Accept-Encoding: identity`, the registry allowlist, an 8-second per-request
signal, and a 120-second total signal. Track bytes returned by each sequential
`readResponseBytesLimited` call in one local counter and reject before the
cumulative total exceeds 128 MiB. Parse with fatal UTF-8; require plain records
and validate every consumed field's type/bounds while ignoring unconsumed API
fields for forward compatibility.

Sanitize post bodies with the existing Cheerio dependency by removing
`script`, `style`, navigation, hidden content, and all markup. Construct bounded
content as:

```text
Author: <display name or "deleted user">
Author URL: <validated profile URL or "unavailable">
License: <exact bounded content_license>
Source: <validated post URL>

<sanitized body>
```

Include bounded author and license in the title so the existing citation
renderer preserves attribution without a schema migration. Reject an unknown or
missing license rather than guessing one.

Bound author display names to 120 characters, licenses to 64 characters,
titles to the repository's 300-character limit, canonical URLs to 2,048
characters, and final document text to the indexer's 2,000,000-character cap.
Reject control characters in attribution fields. Accept and preserve a license
only when it matches `^CC BY-SA [1-4]\.[0-9]$`; a future license family requires
an explicit reviewed change. Accept an optional author URL only on
`cardano.stackexchange.com/users/{validatedUserId}/...`.

If stored `retryAt` is future, return immediately. If any wrapper contains
`backoff` or quota reaches zero, compare-and-set `{ checkedAt, retryAt,
quotaRemaining }`, return no documents, and expose `deferredUntil`. Clamp
deferral to at least 60 seconds and at most 24 hours. Use a five-second bounded
repository operation for the immediate deferral write. On success, expose a
`commitState` that persists `checkedAt` and `quotaRemaining` while clearing
`retryAt` only after indexing succeeds, matching the GitHub adapter's
state-commit pattern.

- [ ] **Step 5: Dispatch into the existing crawl/index contract**

In `crawlSource.ts`, branch after GitHub and before BasicCrawler:

```ts
if (entry.kind === "stackexchange") {
  const result = await fetchStackExchangeSource({
    entry,
    repository: input.repository,
    signal: crawlSignal,
    now: retrievedAt,
    lookup: input.lookup,
    request: input.request,
  });
  return {
    documents: result.documents.map((document) => ({
      ...document,
      sourceId: entry.id,
      trustTier: entry.trustTier,
      retrievedAt,
    })),
    unchanged: result.unchanged,
    ...(result.deferredUntil ? { deferredUntil: result.deferredUntil } : {}),
    ...(result.commitState ? { commitState: result.commitState } : {}),
  };
}
```

Export the adapter and state types from `packages/cardano-agent/src/index.ts`.
Change the existing `GitHub fetch state commit failed.` message in
`indexDocument.ts` to the source-neutral `Source fetch state commit failed.`,
and update its focused assertion; both adapters share that callback contract.

- [ ] **Step 6: Verify GREEN and commit**

Run:

```bash
npm test -- --run tests/stackExchangeSource.test.ts tests/sourceCrawler.test.ts tests/indexDocument.test.ts tests/knowledgeRepository.integration.test.ts
npm run typecheck
npm run build
git diff --check
```

Expected: unit tests pass; the repository integration suite passes when
`TEST_DATABASE_URL` is present and otherwise records its existing credential skip.

```bash
git add packages/cardano-agent/src/knowledge/stackExchangeSource.ts packages/cardano-agent/src/knowledge/knowledgeRepository.ts packages/cardano-agent/src/knowledge/crawlSource.ts packages/cardano-agent/src/knowledge/indexDocument.ts packages/cardano-agent/src/index.ts tests/stackExchangeSource.test.ts tests/sourceCrawler.test.ts tests/indexDocument.test.ts tests/knowledgeRepository.integration.test.ts
git commit -m "feat: ingest Cardano Stack Exchange through its API"
```

### Task 4: Resolve Live Source-Family Health Explicitly

**Files:**
- Modify: `scripts/validate-source-registry.ts`
- Test: `tests/sourceRegistry.test.ts`

- [ ] **Step 1: Write failing family-health tests**

Load `cardano-foundation`, `cardano-foundation-github`, and
`cardano-stack-exchange` from the checked-in config so the blocking IDs and
fallback metadata in the test are real. Add one response helper:

```ts
const liveResponse = (url: string, statusCode: number) => ({
  url,
  statusCode,
  headers: { "content-type": "application/json" },
  body: {} as never,
  cancel: () => undefined,
});
```

Replace the boolean-only assertions with explicit states:

```ts
it("reports a challenged official primary as degraded when its fallback passes", async () => {
  const results = await runLiveValidation([primary, fallback], {
    request: async ({ url }) => liveResponse(url, url.includes("cardanofoundation.org") ? 429 : 200),
    sourceTimeoutMs: 100,
    overallTimeoutMs: 1_000,
  });
  expect(results).toContainEqual(expect.objectContaining({
    id: primary.id,
    status: "degraded-with-fallback",
    fallbackId: fallback.id,
    reason: expect.stringMatching(/429/),
  }));
  expect(liveValidationSucceeded(results)).toBe(true);
});

it("fails a required official family without a healthy fallback", async () => {
  const results = await runLiveValidation([primary, fallback], {
    request: async ({ url }) => liveResponse(url, 503),
  });
  expect(results.find((result) => result.id === primary.id)?.status).toBe("failed");
  expect(liveValidationSucceeded(results)).toBe(false);
});

it("reports a community failure without erasing official coverage", async () => {
  const results = await runLiveValidation([official, community], {
    request: async ({ url }) => liveResponse(url, url.includes("api.stackexchange.com") ? 403 : 200),
  });
  expect(results.find((result) => result.id === community.id)?.status).toBe("failed");
  expect(liveValidationSucceeded(results)).toBe(true);
});

it("probes Stack Exchange with one fixed API GET", async () => {
  const calls: Array<{ url: string; method?: string }> = [];
  await expect(checkLive(community, new AbortController().signal, async (input) => {
    calls.push({ url: input.url, method: input.method });
    return liveResponse(input.url, 200);
  })).resolves.toBeUndefined();
  const probe = new URL(calls[0]!.url);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.method).toBe("GET");
  expect(probe.origin + probe.pathname).toBe("https://api.stackexchange.com/2.3/questions");
  expect(Object.fromEntries(probe.searchParams)).toEqual({
    filter: "default",
    pagesize: "1",
    site: "cardano",
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
npm test -- --run tests/sourceRegistry.test.ts
```

Expected: FAIL because results currently contain only `ok` and `reason` and all
source failures block the command.

- [ ] **Step 3: Separate raw probes from family resolution**

Keep `checkLive` as the single hardened probe. For ordinary entries preserve
the current HEAD/range-GET behavior. For `stackexchange`, build exactly
`https://api.stackexchange.com/2.3/questions?filter=default&pagesize=1&site=cardano`
with `URL`/`URLSearchParams` and issue one hardened GET because the registry's
canonical endpoint without `site` returns HTTP 400. Never accept registry data
for this query; still pass the constructed URL through `urlMatchesSourceScope`
before requesting it. Change the result to:

```ts
export type LiveSourceStatus = "healthy" | "degraded-with-fallback" | "failed";
export type LiveCheckResult = {
  id: string;
  status: LiveSourceStatus;
  blocking: boolean;
  reason?: string;
  fallbackId?: string;
};
```

Probe every entry once with the existing four-worker and overall timeout caps.
Then resolve each entry from the immutable probe map. A failed primary is
`degraded-with-fallback` only when a declared fallback probe is healthy; choose
the first healthy ID in declared order for deterministic reporting. Set
`blocking` only for IDs in `REQUIRED_OFFICIAL_SOURCE_IDS`; community failures
remain `failed` and visible but nonblocking. Implement:

```ts
export function liveValidationSucceeded(results: LiveCheckResult[]): boolean {
  return results.length > 0 && results.every(
    (result) => !result.blocking || result.status !== "failed",
  );
}
```

Print `healthy`, `degraded-with-fallback (<fallbackId>): <reason>`, or
`failed: <reason>` without response bodies or URLs.

- [ ] **Step 4: Verify GREEN and commit**

Run:

```bash
npm test -- --run tests/sourceRegistry.test.ts
npm run validate:registry
npm run validate:registry:live
npm run typecheck
git diff --check
```

Expected: offline validation passes. Live validation exits zero when Cardano
Foundation is challenged but `cardano-foundation-github` is healthy; the report
must still show the primary as degraded. If another required official source is
actually unavailable, preserve the non-zero result and record that source.

```bash
git add scripts/validate-source-registry.ts tests/sourceRegistry.test.ts
git commit -m "feat: gate Cardano source families with explicit fallback"
```

### Task 5: Correct Managed-Provider Credentials and Operations

**Files:**
- Modify: `scripts/evaluate-cardano-rag.ts`
- Modify: `tests/cardanoRagEval.test.ts`
- Modify: `.env.example`
- Modify: `deploy/vennek.env.example`
- Modify: `docs/architecture/data-sources.md`
- Modify: `docs/deployment/release-checklist.md`

- [ ] **Step 1: Write the failing credential test**

Change the expected direct dependencies in `tests/cardanoRagEval.test.ts`:

```ts
it("requires only credentials used by live evaluation", () => {
  expect(missingLiveCredentials({})).toEqual([
    "DATABASE_URL",
    "LITELLM_BASE_URL",
    "LITELLM_API_KEY",
    "VENNEK_MODEL_FAST",
    "VENNEK_MODEL_QUALITY",
    "VENNEK_MODEL_VERIFIER",
    "VENNEK_EMBEDDING_MODEL",
  ]);
  expect(missingLiveCredentials(completeLiveEnvWithoutGithubToken)).toEqual([]);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
npm test -- --run tests/cardanoRagEval.test.ts
```

Expected: FAIL because `GITHUB_TOKEN` is still in `LIVE_CREDENTIALS`.

- [ ] **Step 3: Remove only the unused credential requirement**

Delete `"GITHUB_TOKEN"` from `LIVE_CREDENTIALS`. Do not add provider secrets to
the evaluator: `OPENAI_API_KEY` stays inside LiteLLM. Preserve report
sanitization by deriving its allowlist from the corrected direct-credential
constant.

- [ ] **Step 4: Update operating documentation and examples**

Document these exact boundaries:

- `GITHUB_TOKEN` is optional and affects GitHub rate capacity only;
- staging LiteLLM must receive a real `OPENAI_API_KEY` through its secret file or
  manager because the current embedding alias requires it;
- Vennek receives only `LITELLM_BASE_URL`, `LITELLM_API_KEY`, and model aliases;
- Cardano Foundation may be degraded-with-fallback without being called healthy;
- monitor-only sources are not scheduled or manually syncable;
- Stack Exchange citations retain author, post URL, and `content_license`;
- public factual canary remains closed until live registry and live RAG both
  exit zero.

Keep example values as placeholders and never generate or commit an OpenAI key.

- [ ] **Step 5: Verify GREEN and commit**

Run:

```bash
npm test -- --run tests/cardanoRagEval.test.ts tests/sourceRegistry.test.ts tests/knowledgeWorker.test.ts tests/stackExchangeSource.test.ts
npm run typecheck
git diff --check
```

Expected: PASS; missing-credential output no longer names `GITHUB_TOKEN`.

```bash
git add scripts/evaluate-cardano-rag.ts tests/cardanoRagEval.test.ts .env.example deploy/vennek.env.example docs/architecture/data-sources.md docs/deployment/release-checklist.md
git commit -m "fix: require only live RAG runtime credentials"
```

### Task 6: Run Assurance Release Gates and Reviews

**Files:**
- Modify: `docs/superpowers/plans/2026-08-26-cardano-source-resilience.md`
- Modify only if evidence changes: `docs/superpowers/plans/2026-08-24-cardano-knowledge-rag.md`

- [ ] **Step 1: Run focused and offline gates**

Run:

```bash
npm test -- --run tests/sourceRegistry.test.ts tests/knowledgeWorker.test.ts tests/stackExchangeSource.test.ts tests/sourceCrawler.test.ts tests/knowledgeRepository.integration.test.ts tests/cardanoRagEval.test.ts
npm test -- --run
npm run typecheck
npm run build
npm run verify:imports
npm run validate:registry
npm run eval:cardano-rag
npm audit --audit-level=moderate
git diff --check
```

Expected: all non-credential gates pass, audit reports zero moderate-or-higher
vulnerabilities, and credential-gated integration tests either pass with a real
test database or report their explicit existing skips.

- [ ] **Step 2: Run live source validation**

Run:

```bash
npm run validate:registry:live
```

Expected: Cardano Foundation is reported `degraded-with-fallback` if its
canonical site still returns 429, its GitHub fallback is healthy, Stack Exchange
API is healthy, and no required official family is failed.

- [ ] **Step 3: Run managed-provider live RAG staging**

From a mode-0600 staging environment containing the real database, LiteLLM
master key, provider key, and model aliases, run:

```bash
npm run eval:cardano-rag:live
```

Expected: exit zero with a timestamped sanitized report meeting recall@10,
citation precision, freshness, answer-property, unsupported-claim, and
official-override thresholds. If operator credentials are unavailable, leave
this checkbox open and keep the public canary disabled; a fixture or mock does
not satisfy this gate.

- [ ] **Step 4: Request independent correctness and security reviews**

After implementation and verification, dispatch one read-only `reviewer` and
one separate read-only `security_reviewer` over the finished commit range.
Correctness review must check spec coverage, provenance, queue behavior,
backoff, attribution, and release-state semantics. Security review must check
SSRF/redirect confinement, untrusted API JSON/HTML, URL construction,
fallback-tier integrity, secret/report handling, resource bounds, and fail-closed
behavior.

Resolve every substantiated finding, rerun its focused regression check, and
send the fix to the same reviewer for re-review. The task is incomplete until
both return PASS.

- [ ] **Step 5: Record evidence and commit plan closeout**

Check completed steps in this plan and record exact test counts, live source
states, audit result, reviewer verdicts, and any still-open credential gate. In
the parent knowledge plan, check R10 staging only when both live commands have
actually exited zero.

```bash
git add docs/superpowers/plans/2026-08-26-cardano-source-resilience.md docs/superpowers/plans/2026-08-24-cardano-knowledge-rag.md
git commit -m "docs: close Cardano source resilience milestone"
```
