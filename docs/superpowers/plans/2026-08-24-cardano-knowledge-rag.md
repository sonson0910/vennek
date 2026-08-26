# Cardano Knowledge and Grounded RAG Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the versioned Cardano source registry, ingestion pipeline, hybrid retrieval, live discovery, grounded generation, and claim/citation verification required before the public agent can answer factual questions.

**Architecture:** Store source metadata, immutable versions, chunks, and 1,536-dimension embeddings in PostgreSQL/pgvector. Use Crawlee for scheduling and URL queues while retaining the hardened repository fetch boundary; combine PostgreSQL full-text and vector ranks, then pass only cited evidence into the existing fail-closed question service.

**Tech Stack:** TypeScript, Crawlee, native fetch, `pdfjs-dist`, PostgreSQL full-text search, pgvector HNSW, LiteLLM embeddings/chat endpoints, SearXNG, Vitest

---

## Prerequisite

Complete `2026-08-24-public-cardano-agent-foundation.md`. Keep the agent credential-gated until every release gate in this plan passes.

### Task 1: Define and Validate the Cardano Source Registry

**Files:**
- Create: `packages/cardano-agent/src/knowledge/sourceRegistry.ts`
- Create: `config/cardano-sources.json`
- Create: `scripts/validate-source-registry.ts`
- Modify: `packages/cardano-agent/src/index.ts`
- Modify: `package.json`
- Test: `tests/sourceRegistry.test.ts`

- [x] **Step 1: Write failing registry validation tests**

```ts
import { describe, expect, it } from "vitest";
import { validateSourceRegistry } from "@vennek/cardano-agent";

const official = {
  id: "cardano-docs",
  owner: "Cardano",
  trustTier: "official",
  kind: "sitemap",
  url: "https://docs.cardano.org/sitemap.xml",
  allowedDomains: ["docs.cardano.org"],
  topics: ["fundamentals", "developer", "staking"],
  networks: ["mainnet", "preprod", "preview"],
  refresh: "daily"
};

describe("Cardano source registry", () => {
  it("accepts a bounded official source", () => {
    expect(validateSourceRegistry([official])).toEqual([official]);
  });

  it("rejects duplicate ids and non-HTTPS sources", () => {
    expect(() => validateSourceRegistry([official, official])).toThrow(/duplicate/i);
    expect(() => validateSourceRegistry([{ ...official, url: "http://docs.cardano.org" }])).toThrow(/https/i);
  });

  it("requires every URL host to be in allowedDomains", () => {
    expect(() => validateSourceRegistry([{ ...official, allowedDomains: ["example.com"] }])).toThrow(/allowed domain/i);
  });
});
```

- [x] **Step 2: Confirm the tests fail**

Run: `npm test -- --run tests/sourceRegistry.test.ts`

Expected: FAIL because registry validation is absent.

- [x] **Step 3: Implement the registry contract**

```ts
export type TrustTier = "official" | "community" | "unverified";
export type SourceKind = "sitemap" | "github" | "feed" | "page";
export type RefreshRate = "hourly" | "daily";

export type SourceRegistryEntry = {
  id: string;
  owner: string;
  trustTier: TrustTier;
  kind: SourceKind;
  url: string;
  allowedDomains: string[];
  topics: string[];
  networks: Array<"mainnet" | "preprod" | "preview">;
  refresh: RefreshRate;
};
```

`validateSourceRegistry` must reject unknown fields, duplicate IDs, empty arrays, invalid enum values, non-HTTPS URLs, URL credentials, IP-literal hosts, and hosts outside `allowedDomains`. Reuse `hostMatches` from the existing safe remote adapter.

- [x] **Step 4: Seed the required source families**

`config/cardano-sources.json` must contain at least one validated official entry for each of these IDs: `cardano-docs`, `cardano-developer-portal`, `iog-research`, `iog-github`, `cardano-foundation`, `cardano-foundation-github`, `emurgo`, `intersect`, `intersect-github`, `cardano-cips`, `project-catalyst`, `govtool`, `cardano-node-releases`, `cardano-ledger`, `ouroboros-consensus`, `plutus`, and `aiken`.

Use `hourly` for GitHub releases, governance, CIPs, Catalyst, and GovTool. Use `daily` for stable documentation and research. Keep community sources in a separate second section of the JSON file and mark every one `community`.

- [x] **Step 5: Add offline and live validation commands**

Add scripts:

```json
"validate:registry": "tsx scripts/validate-source-registry.ts",
"validate:registry:live": "tsx scripts/validate-source-registry.ts --live"
```

Offline mode parses and reports coverage by required family. Live mode issues bounded HEAD/GET requests through the hardened fetch boundary, reports retrieval failures with reasons, and never mutates the registry.

- [x] **Step 6: Verify and commit**

Run: `npm test -- --run tests/sourceRegistry.test.ts && npm run validate:registry && npm run typecheck`

Expected: registry tests pass and all 17 official families report covered.

```bash
git add config/cardano-sources.json package.json packages/cardano-agent/src scripts/validate-source-registry.ts tests/sourceRegistry.test.ts
git commit -m "feat: register trusted Cardano sources"
```

### Task 2: Add Versioned Knowledge and Vector Schema

**Files:**
- Create: `packages/cardano-agent/migrations/002_knowledge.sql`
- Create: `packages/cardano-agent/src/knowledge/knowledgeRepository.ts`
- Modify: `packages/cardano-agent/src/index.ts`
- Test: `tests/knowledgeRepository.integration.test.ts`

- [x] **Step 1: Write a credential-gated versioning test**

```ts
it("deduplicates unchanged source versions and replaces chunks atomically", async () => {
  const repository = new KnowledgeRepository(db);
  const first = await repository.storeVersion({ sourceId: "cardano-docs", canonicalUrl: "https://docs.cardano.org/about-cardano", title: "About Cardano", content: "Cardano source body", contentHash: "a".repeat(64), retrievedAt: new Date("2026-08-24T00:00:00Z") });
  const second = await repository.storeVersion({ sourceId: "cardano-docs", canonicalUrl: "https://docs.cardano.org/about-cardano", title: "About Cardano", content: "Cardano source body", contentHash: "a".repeat(64), retrievedAt: new Date("2026-08-24T01:00:00Z") });
  expect(second.id).toBe(first.id);
});
```

- [x] **Step 2: Create the knowledge schema**

Use this table structure and indexes:

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE knowledge_sources (
  id text PRIMARY KEY,
  owner text NOT NULL,
  trust_tier text NOT NULL CHECK (trust_tier IN ('official', 'community', 'unverified')),
  registry jsonb NOT NULL,
  fetch_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_success_at timestamptz,
  last_error_code text
);

CREATE TABLE source_versions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id text NOT NULL REFERENCES knowledge_sources(id),
  canonical_url text NOT NULL,
  title text NOT NULL,
  content text NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  published_at timestamptz,
  retrieved_at timestamptz NOT NULL,
  UNIQUE (source_id, canonical_url, content_hash)
);

CREATE TABLE knowledge_chunks (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  version_id bigint NOT NULL REFERENCES source_versions(id) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  heading text NOT NULL,
  content text NOT NULL,
  content_hash text NOT NULL,
  embedding_model text NOT NULL,
  embedding vector(1536) NOT NULL,
  textsearch tsvector GENERATED ALWAYS AS (to_tsvector('simple', heading || ' ' || content)) STORED,
  UNIQUE (version_id, ordinal)
);

CREATE INDEX knowledge_chunks_textsearch_idx ON knowledge_chunks USING gin (textsearch);
CREATE INDEX knowledge_chunks_embedding_idx ON knowledge_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX source_versions_url_retrieved_idx ON source_versions (canonical_url, retrieved_at DESC);
```

- [x] **Step 3: Implement atomic version storage**

Use parameterized queries only. `storeVersion` inserts the source version with `ON CONFLICT` and returns the existing ID when the content hash is unchanged. `replaceChunks(versionId, chunks)` opens a transaction, deletes chunks for that version, inserts the complete validated set, and commits. Reject empty content, non-HTTPS canonical URLs, non-finite embedding values, embeddings not exactly 1,536 elements, and duplicate ordinals before starting the transaction.

- [x] **Step 4: Verify against PostgreSQL**

Run:

```bash
DATABASE_URL=postgres://vennek:vennek@localhost:5432/vennek npm run migrate:agent
TEST_DATABASE_URL=postgres://vennek:vennek@localhost:5432/vennek npm test -- --run tests/knowledgeRepository.integration.test.ts
```

Expected: version deduplication and atomic chunk replacement pass.

- [x] **Step 5: Commit**

```bash
git add packages/cardano-agent/migrations packages/cardano-agent/src tests/knowledgeRepository.integration.test.ts
git commit -m "feat: store versioned Cardano knowledge"
```

### Task 3: Add Bounded HTML, Markdown, JSON, and PDF Extraction

**Files:**
- Create: `packages/cardano-agent/src/knowledge/extractContent.ts`
- Create: `packages/cardano-agent/src/knowledge/crawlSource.ts`
- Create: `packages/cardano-agent/src/knowledge/githubSource.ts`
- Modify: `packages/cardano-governance-skills/src/adapters/userProvided.ts`
- Modify: `packages/cardano-governance-skills/src/index.ts`
- Modify: `packages/cardano-agent/package.json`
- Test: `tests/contentExtraction.test.ts`
- Test: `tests/sourceCrawler.test.ts`
- Test: `tests/githubSource.test.ts`

- [x] **Step 1: Install maintained parsers and crawler**

Run: `npm install -w @vennek/cardano-agent crawlee@^3.15.0 pdfjs-dist@^5.4.0`

- [x] **Step 2: Write failing extraction tests**

```ts
it("removes scripts and navigation from HTML while preserving headings", async () => {
  const result = await extractContent({ mime: "text/html", bytes: new TextEncoder().encode("<nav>menu</nav><h1>Ouroboros</h1><p>Proof of stake.</p><script>ignore()</script>") });
  expect(result).toMatchObject({ title: "Ouroboros", text: "# Ouroboros\n\nProof of stake." });
});

it("rejects documents larger than 8 MiB before parsing", async () => {
  await expect(extractContent({ mime: "application/pdf", bytes: new Uint8Array(8 * 1024 * 1024 + 1) })).rejects.toThrow(/8 MiB/);
});
```

- [x] **Step 3: Generalize the existing bounded response reader**

Extract a `readResponseBytesLimited(response, maxBytes, allowedMimeTypes)` helper next to `readResponseTextLimited`. It must retain the current streaming byte cap, content-length early rejection, cancellation, redirect rejection, and error cleanup. Existing text fetch tests must remain unchanged and pass through the new primitive.

- [x] **Step 4: Implement extraction without browser execution**

Use Crawlee `BasicCrawler` for request scheduling only. Fetch each URL with the hardened helper and the registry entry's `allowedDomains`; do not use a headless browser or execute page JavaScript in this phase. Parse:

- `text/html`: Crawlee's Cheerio utilities, removing `script`, `style`, `nav`, `footer`, and hidden elements;
- `text/markdown` and `text/plain`: UTF-8 text;
- `application/json`: stable pretty text from bounded JSON;
- `application/pdf`: `pdfjs-dist` text content, maximum 300 pages and 8 MiB.

Return `{ title, text, publishedAt }`. Reject empty extracted text and more than 2 million normalized characters.

- [x] **Step 5: Implement GitHub-specific incremental retrieval**

For `kind: "github"`, map only registry-approved `owner/repository` pairs to fixed `api.github.com` endpoints for default-branch documentation, releases, tags, and repository metadata. Send the stored ETag as `If-None-Match`, treat 304 as unchanged, persist new ETag/rate-limit state in `knowledge_sources.fetch_state`, and honor `Retry-After` or `X-RateLimit-Reset`. Never accept a repository or API URL from a Telegram message.

- [x] **Step 6: Test crawl confinement**

Prove the crawler rejects cross-domain redirects, private DNS answers, URL credentials, unsupported MIME types, oversized streams, and links outside the registry allowlist. Prove a sitemap can enqueue only HTTPS URLs matching the same source entry.

- [x] **Step 7: Verify and commit**

Run: `npm test -- --run tests/adapters.test.ts tests/contentExtraction.test.ts tests/sourceCrawler.test.ts tests/githubSource.test.ts && npm run typecheck`

```bash
git add package.json package-lock.json packages/cardano-agent packages/cardano-governance-skills tests/contentExtraction.test.ts tests/sourceCrawler.test.ts tests/githubSource.test.ts
git commit -m "feat: ingest bounded Cardano source content"
```

### Task 4: Chunk and Embed Immutable Source Versions

**Files:**
- Create: `packages/cardano-agent/src/knowledge/chunkDocument.ts`
- Create: `packages/cardano-agent/src/llm/embeddingClient.ts`
- Create: `packages/cardano-agent/src/knowledge/indexDocument.ts`
- Modify: `packages/cardano-agent/src/index.ts`
- Test: `tests/chunkDocument.test.ts`
- Test: `tests/embeddingClient.test.ts`

- [x] **Step 1: Write failing deterministic chunk tests**

```ts
it("chunks on headings and bounds every chunk", () => {
  const chunks = chunkDocument("# Consensus\n" + "Ouroboros evidence. ".repeat(120) + "\n## Security\nFormal methods.");
  expect(chunks.every((chunk) => chunk.content.length <= 1_200)).toBe(true);
  expect(chunks.map((chunk) => chunk.ordinal)).toEqual(chunks.map((_, index) => index));
  expect(chunks.at(-1)?.heading).toBe("Security");
});
```

- [x] **Step 2: Implement deterministic chunking**

Split on Markdown headings, paragraphs, and code blocks. Target 1,000 characters, hard cap at 1,200, and carry at most the final 150 characters of the prior prose chunk. Never split inside a fenced code block shorter than 1,200 characters. Hash `heading + "\n" + content` with the existing SHA-256 helper.

- [x] **Step 3: Write and implement the embedding contract**

POST to `${LITELLM_BASE_URL}/v1/embeddings` with `{ model: VENNEK_EMBEDDING_MODEL, input: string[] }`. Batch at most 64 chunks and 100,000 total input characters. Validate the response has one 1,536-element finite numeric vector per input in the same index order.

The public method is:

```ts
embed(input: string[]): Promise<Array<{ index: number; embedding: number[] }>>
```

- [x] **Step 4: Implement idempotent indexing**

`indexDocument` computes the normalized content hash. If the exact source URL/hash version already has a complete chunk set for the configured embedding model, return without another embedding call. Otherwise chunk, embed, and atomically replace the version's chunks.

- [x] **Step 5: Verify and commit**

Run: `npm test -- --run tests/chunkDocument.test.ts tests/embeddingClient.test.ts && npm run typecheck`

```bash
git add packages/cardano-agent/src tests/chunkDocument.test.ts tests/embeddingClient.test.ts
git commit -m "feat: chunk and embed Cardano sources"
```

### Task 5: Implement Hybrid Retrieval with Trust and Freshness Filters

**Files:**
- Create: `packages/cardano-agent/migrations/003_retrieval_cache.sql`
- Create: `packages/cardano-agent/src/knowledge/retrieveEvidence.ts`
- Create: `packages/cardano-agent/src/knowledge/retrievalCache.ts`
- Modify: `packages/cardano-agent/src/index.ts`
- Test: `tests/retrieveEvidence.integration.test.ts`

- [x] **Step 1: Seed a failing retrieval test**

Insert one official and one community chunk with overlapping terms. Assert an official exact lexical match ranks before the community vector-only match and every returned item contains immutable source/version provenance.

Expected evidence shape:

```ts
type Evidence = {
  id: string;
  sourceId: string;
  trustTier: "official" | "community" | "unverified";
  title: string;
  url: string;
  excerpt: string;
  publishedAt?: string;
  retrievedAt: string;
  versionHash: string;
  score: number;
};
```

- [x] **Step 2: Implement reciprocal-rank fusion**

Use one parameterized SQL statement with separate top-40 lexical and vector CTEs. Combine ranks with `1.0 / (60 + rank)`, add `0.01` for official and `0.005` for community evidence, and return at most 10 chunks. Join only the newest successfully indexed version per canonical URL. Filter by requested networks/topics when supplied.

- [x] **Step 3: Enforce freshness in application code**

Mark governance, release, GitHub, and on-chain-related evidence stale after two hours; stable documentation stale after 48 hours. Stale evidence remains retrievable but carries `stale: true` and triggers live discovery rather than being presented as current without qualification.

- [x] **Step 4: Add source-version-bound retrieval caching**

Create `retrieval_cache` with `query_hash`, `language`, `filter_hash`, `source_version_fingerprint`, `chunk_ids jsonb`, `embedding_model`, `expires_at`, and a composite primary key. Cache only stable-document retrievals. Do not cache wallet, on-chain, governance, release, current/latest, or personalized queries. On read, recompute the fingerprint from the newest source versions; a mismatch is a miss and deletes the stale row.

Add tests proving unchanged stable retrieval is reused without another embedding call, a new source version invalidates it, and current/on-chain questions never create a row.

- [x] **Step 5: Verify against PostgreSQL and commit**

Run: `TEST_DATABASE_URL=postgres://vennek:vennek@localhost:5432/vennek npm test -- --run tests/retrieveEvidence.integration.test.ts`

```bash
git add packages/cardano-agent/src tests/retrieveEvidence.integration.test.ts
git commit -m "feat: retrieve ranked Cardano evidence"
```

### Task 6: Add Safe SearXNG Live Discovery

**Files:**
- Create: `packages/cardano-agent/src/knowledge/searxng.ts`
- Create: `packages/cardano-agent/src/knowledge/liveDiscovery.ts`
- Modify: `packages/cardano-agent/src/config.ts`
- Modify: `packages/cardano-agent/src/index.ts`
- Test: `tests/liveDiscovery.test.ts`

- [x] **Step 1: Write failing discovery tests**

Prove queries are restricted to registry domains first, malformed JSON is rejected, result URLs with credentials/private IPs are discarded, and no unregistered domain becomes official evidence.

```ts
expect(buildOfficialSearchQuery("latest Cardano node", ["docs.cardano.org", "github.com"])).toBe("latest Cardano node (site:docs.cardano.org OR site:github.com)");
```

- [x] **Step 2: Implement a fixed-endpoint client**

Add required `SEARXNG_BASE_URL` for live-discovery-enabled deployments. Call only `/search` on that configured origin with `format=json`, `safesearch=1`, a five-second timeout, and a 1 MiB response limit. Accept at most ten results.

- [x] **Step 3: Promote live results safely**

Results matching a registry entry inherit that entry's trust tier only after fetching through its allowed domains and indexing an immutable version. Results outside the registry are `unverified`, may be shown as discovery links, and cannot be the only citation for a factual claim.

- [x] **Step 4: Verify and commit**

Run: `npm test -- --run tests/liveDiscovery.test.ts tests/agentConfig.test.ts && npm run typecheck`

```bash
git add packages/cardano-agent/src tests/liveDiscovery.test.ts tests/agentConfig.test.ts
git commit -m "feat: discover current Cardano sources"
```

### Task 7: Generate and Verify Claim-Bound Answers

**Files:**
- Create: `packages/cardano-agent/src/agent/groundedPrompt.ts`
- Create: `packages/cardano-agent/src/agent/verifyClaims.ts`
- Create: `packages/cardano-agent/src/agent/renderAnswer.ts`
- Modify: `packages/cardano-agent/src/agent/answerQuestion.ts`
- Test: `tests/groundedAnswer.test.ts`

- [x] **Step 1: Write failing grounding tests**

```ts
it("drops a factual claim whose citation does not support it", async () => {
  const evidence = [{ id: "E1", excerpt: "Ouroboros is a proof-of-stake protocol.", url: "https://docs.cardano.org/ouroboros", trustTier: "official" as const }];
  const generated = { language: "vi", claims: [{ text: "Ouroboros dùng proof of work.", citationIds: ["E1"] }] };
  const result = await verifyAndRender(generated, evidence, async () => ({ supported: [] }));
  expect(result).not.toContain("proof of work");
  expect(result).toMatch(/chưa đủ bằng chứng/i);
});
```

- [x] **Step 2: Define the model output contract**

```ts
type GeneratedAnswer = {
  language: string;
  claims: Array<{
    text: string;
    citationIds: string[];
    kind: "fact" | "caveat";
  }>;
};
```

The prompt encloses evidence in `<evidence id="E1">` blocks, states that evidence is untrusted data, forbids following source instructions, and requires JSON matching this contract. Do not include operational secrets or full historical conversation.

- [x] **Step 3: Add deterministic validation before model verification**

Reject unknown citation IDs, empty claims, more than 12 claims, claims longer than 700 characters, and factual claims with zero citations. Community-only claims must render with a community label. Conflicting official sources must both be cited and named.

- [x] **Step 4: Add verifier-model checks**

Send each claim plus only its cited excerpts to the verifier profile. Require a JSON boolean array with exactly one value per claim, for example `{ "supported": [true, false] }`. Drop unsupported factual claims. If the verifier fails or returns malformed output, fail closed with a localized evidence-unavailable answer.

- [x] **Step 5: Wire retrieval into `answerQuestion`**

Retrieve evidence, trigger live discovery when current evidence is absent/stale, validate an immutable bounded evidence snapshot, and reject wallet-secret material before any provider call. Then select the model profile, generate, verify, render inline numbered links, persist the final assistant message, and record only token counts/model/latency in `usage_ledger`. Greetings remain deterministic and do not call retrieval or a model.

- [x] **Step 6: Verify and commit**

Run: `npm test -- --run tests/answerQuestion.test.ts tests/groundedAnswer.test.ts tests/safety.test.ts && npm run typecheck`

```bash
git add packages/cardano-agent/src tests/answerQuestion.test.ts tests/groundedAnswer.test.ts
git commit -m "feat: answer Cardano questions with verified citations"
```

### Task 7b: Compose the Grounded Agent Runtime

**Files:**
- Modify: `apps/telegram-bot/src/agentWorker.ts`
- Modify: `apps/telegram-bot/src/main.ts`
- Modify: `packages/cardano-agent/src/agent/answerQuestion.ts`
- Modify: `packages/cardano-agent/src/conversations.ts`
- Modify: `packages/cardano-agent/src/llm/embeddingClient.ts`
- Modify: `scripts/provision-app-role.ts`
- Modify: `deploy/vennek.env.example`
- Add: `packages/cardano-agent/migrations/005_conversation_idempotency_message.sql`
- Test: `tests/answerQuestion.test.ts`
- Test: `tests/agentWorker.test.ts`
- Test: `tests/conversations.integration.test.ts`
- Test: `tests/embeddingClient.test.ts`
- Test: `tests/runtimeComposition.test.ts`
- Test: `tests/provisionAppRole.integration.test.ts`

- [x] **Step 1: Write failing runtime-composition tests**

Assert that the worker passes the canonical question and language to real retrieval, uses the configured embedding/generation/verifier model aliases, records only user ID/model/token counts/latency, and still appends the final assistant message exactly once with the Telegram update ID. Greetings and rejected wallet secrets must call neither retrieval, providers, nor usage recording.

The retry path must recover a linked assistant message without new model work, while a legacy null message link fails closed for operator repair/requeue.

- [x] **Step 2: Compose existing clients at the worker seam**

Construct one `EmbeddingClient` and one `LiteLlmClient` from the validated agent config. Inject `retrieveEvidence`, model aliases, completion, and a parameterized `usage_ledger` insert through `createAgentAnswer`; do not add another agent service layer or persist prompt, answer, evidence, URL, or provider errors.

- [x] **Step 3: Preserve the ingestion trust boundary**

The Telegram application role keeps read-only access to knowledge tables. Do not call `promoteDiscoveredLink` from the chat worker and do not grant knowledge DML. Task 8 owns a separate bounded ingestion worker/queue; live discovery promotion is wired there before release. Add an integration assertion that the app role can insert usage metadata while knowledge writes remain denied.

- [x] **Step 4: Verify and commit**

Run: `npm test -- --run tests/answerQuestion.test.ts tests/groundedAnswer.test.ts tests/agentWorker.test.ts tests/runtimeComposition.test.ts tests/conversations.integration.test.ts tests/embeddingClient.test.ts tests/provisionAppRole.integration.test.ts && npm test && npm run typecheck && npm run build && git diff --check`

```bash
git add apps/telegram-bot/src/agentWorker.ts apps/telegram-bot/src/main.ts deploy/vennek.env.example packages/cardano-agent/migrations/005_conversation_idempotency_message.sql packages/cardano-agent/src/agent/answerQuestion.ts packages/cardano-agent/src/conversations.ts packages/cardano-agent/src/llm/embeddingClient.ts scripts/provision-app-role.ts tests/agentWorker.test.ts tests/answerQuestion.test.ts tests/conversations.integration.test.ts tests/embeddingClient.test.ts tests/runtimeComposition.test.ts tests/provisionAppRole.integration.test.ts docs/superpowers/plans/2026-08-24-cardano-knowledge-rag.md
git commit -m "feat: compose the grounded Cardano agent runtime"
```

### Task 8: Schedule Incremental Source Synchronization

**Files:**
- Create: `packages/cardano-agent/src/knowledge/syncSource.ts`
- Create: `apps/telegram-bot/src/knowledgeWorker.ts`
- Modify: `apps/telegram-bot/src/main.ts`
- Create: `scripts/provision-knowledge-role.ts`
- Modify: `scripts/migrate-agent.ts`, `Dockerfile`, `docker-compose.yml`, `.env.example`, `deploy/vennek.env.example`
- Modify: `packages/cardano-agent/src/index.ts`, `packages/cardano-agent/src/knowledge/sourceRegistry.ts`, `scripts/validate-source-registry.ts`, `package.json`
- Test: `tests/syncSource.test.ts`, `tests/knowledgeWorker.test.ts`, `tests/knowledgeRuntime.test.ts`, `tests/sourceRegistry.test.ts`, `tests/compose.test.ts`, `tests/provisionKnowledgeRole.integration.test.ts`

- [x] **Step 1: Write failing scheduling tests**

Assert hourly sources use cron `0 * * * *`, daily sources use `15 2 * * *`, duplicate scheduled jobs collapse by source ID, unchanged content skips embedding, and failed refresh keeps the previous valid version.

- [x] **Step 2: Implement one job per registry source**

Use pg-boss queue `sync-cardano-source`. Job data contains only `{ sourceId }`; the worker reloads the validated registry entry rather than trusting job-supplied URLs. Configure two retries with exponential backoff and a dead-letter queue named `sync-cardano-source-dead`.

- [x] **Step 3: Add administrator-triggered refresh**

Add CLI mode:

```bash
node apps/telegram-bot/dist/main.js --sync-source cardano-cips
```

It accepts only an exact registry ID, enqueues a singleton job, prints the job ID, and never accepts an arbitrary URL.

- [x] **Step 4: Verify and commit**

Run: `npm test -- --run tests/syncSource.test.ts tests/knowledgeWorker.test.ts tests/knowledgeRuntime.test.ts tests/sourceRegistry.test.ts tests/compose.test.ts tests/provisionKnowledgeRole.integration.test.ts && npm test -- --run && npm run typecheck && npm run build && npm run verify:imports && npm run validate:registry && git diff --check`

```bash
git add .env.example Dockerfile docker-compose.yml deploy/vennek.env.example package.json \
  apps/telegram-bot/src/main.ts apps/telegram-bot/src/knowledgeWorker.ts \
  packages/cardano-agent/src/index.ts packages/cardano-agent/src/knowledge/sourceRegistry.ts \
  packages/cardano-agent/src/knowledge/syncSource.ts scripts/migrate-agent.ts \
  scripts/provision-knowledge-role.ts scripts/validate-source-registry.ts \
  tests/compose.test.ts tests/knowledgeRuntime.test.ts tests/knowledgeWorker.test.ts \
  tests/provisionKnowledgeRole.integration.test.ts tests/sourceRegistry.test.ts tests/syncSource.test.ts
git commit -m "feat: synchronize Cardano knowledge incrementally"
```

### Task 8b: Wire authenticated live-discovery promotion before release

Keep live discovery promotion out of the public Telegram path. Before release, add a separately authenticated, question-only internal endpoint owned by the ingestion boundary; it must validate the requesting service identity, bounded question, and source registry before calling `promoteDiscoveredLink`. Add authorization, audit, replay, and integration tests before enabling it in production.

- [x] **R8b complete (2026-08-25)**

Implementation commits: `0c86270`, `f15e4c6`, `3cab4aa`, `0b61a42`, `6193469`, `31a61a6`, `f8230c9`, `36c324c`, `760e5fe`, `e096951`, `f2b57f7`, `8625e19`, `9d72fc2`, `7793720`, `1420d28`, `67a48b4`, `1394f79`, `6ae5765`, `85b9ee0`, `d3eae53`, `5bd1687`, `571aad2`, `5c813b8`, `369453f`, and `81563a5`.

Verified with the full test suite (`606` passed, `1` credential-gated Blockfrost live test skipped), typecheck, build, import-boundary check, registry validation (`20/20`), production dependency audit (`0` vulnerabilities), Compose validation, fresh PostgreSQL migrations and role provisioning, and a compiled-process signed-request/replay/tamper smoke test. Independent correctness and security reviews passed.

### Task 8c: Compare one private user file with Cardano evidence

- [x] **R8c complete (2026-08-26)**

Approved design and execution plan: `docs/superpowers/specs/2026-08-26-cardano-private-file-comparison-design.md` and `docs/superpowers/plans/2026-08-26-cardano-private-file-comparison.md`. The implementation range is `8a056f3..985024d`; final review remediations are `fa3131b`, `4a7a485`, and `985024d`.

Verified with targeted private-path suites (`129` passed before final remediation; final focused remediation suite `125` passed), the full PostgreSQL suite (`762` passed, `1` credential-gated Blockfrost live test skipped), typecheck, build, compiled imports, registry validation (`20/20`), production dependency audit (`0` vulnerabilities), Compose validation, the isolated extractor Docker smoke, and a compiled `main.js --worker` smoke covering safe DOCX, exact `2,000,000`-code-point Unicode TXT, localized terminal rejection, retry without duplicate delivery, persisted-envelope tamper rejection, and zero retained private markers. Independent correctness and security reviews passed after all findings were resolved.

### Task 9: Add the Cardano RAG Evaluation Harness

**Files:**
- Create: `samples/evaluation/cardano-rag.jsonl`
- Create: `scripts/evaluate-cardano-rag.ts`
- Create: `packages/cardano-agent/src/evaluation/metrics.ts`
- Modify: `package.json`
- Test: `tests/cardanoRagEval.test.ts`

- [x] **Step 1: Create a versioned evaluation corpus**

Add at least 60 manually reviewable cases: at least five each for fundamentals, consensus, staking, assets, transactions, wallets, Plutus/Aiken, nodes/APIs, governance/CIPs, Catalyst, ecosystem, and failure/adversarial behavior. At least 15 questions are Vietnamese and at least five explicitly require current evidence.

Each JSONL row uses this schema:

```json
{"id":"consensus-001","language":"vi","question":"Ouroboros là gì?","requiredSourceIds":["cardano-docs","ouroboros-consensus"],"requiredTerms":["proof-of-stake"],"forbiddenTerms":["proof-of-work"],"validAt":"2026-08-24"}
```

- [x] **Step 2: Implement deterministic metrics**

Calculate retrieval recall@10, citation precision from claim/citation labels, unsupported-claim count, community-overrides-official violations, and per-language pass rate. Exit non-zero below 90% recall@10, below 95% citation precision, or above zero official-override violations.

- [x] **Step 3: Add offline and live commands**

```json
"eval:cardano-rag": "tsx scripts/evaluate-cardano-rag.ts --offline",
"eval:cardano-rag:live": "tsx scripts/evaluate-cardano-rag.ts --live"
```

Offline mode uses checked-in retrieved fixtures and fake model outputs. Live mode requires explicit database, LiteLLM, and source credentials and writes a timestamped report without replacing the approved baseline.

- [x] **Step 4: Verify and commit**

Run: `npm test -- --run tests/cardanoRagEval.test.ts && npm run eval:cardano-rag`

Expected: all fixture tests pass and thresholds are satisfied.

```bash
git add package.json packages/cardano-agent/src/evaluation samples/evaluation scripts/evaluate-cardano-rag.ts tests/cardanoRagEval.test.ts
git commit -m "test: evaluate grounded Cardano answers"
```

- [x] **R9 complete (2026-08-26)**

Implementation commits: `48d5c74`, `a3db916`, `b55f06f`, `4235714`, and `bce88e0`. The checked-in corpus contains `60` manually reviewable cases across `12` categories (`5` each), including `24` Vietnamese and `7` current-evidence cases. Offline evaluation passes with recall@10 `100%`, citation precision `100%`, per-language pass rate `100%`, and zero unsupported claims, official-override violations, answer-property failures, or freshness violations. Targeted tests (`11/11`), the no-credential full suite (`708` passed, `66` credential-gated skipped), typecheck, build, compiled imports, registry validation, and diff check passed. Independent code and authoritative-corpus reviews passed. Live evaluation remains an explicit R10 credential-gated release check.

### Task 10: Run the Knowledge Release Gate

**Files:**
- Modify: `README.md`
- Modify: `docs/architecture/data-sources.md`
- Modify: `docs/deployment/release-checklist.md`

- [x] **Step 1: Update operating documentation**

Document source tiers, registry changes, crawl limits, hourly/daily schedules, live discovery, cache invalidation, embedding-index rebuilds, dead-letter recovery, and the exact rule that community sources never silently override official sources.

- [x] **Step 2: Run offline gates**

```bash
npm test -- --run
npm run typecheck
npm run build
npm run verify:imports
npm run validate:registry
npm run eval:cardano-rag
npm audit --audit-level=moderate
git diff --check
```

Expected: all gates pass and dependency audit reports zero moderate-or-higher vulnerabilities.

- [ ] **Step 3: Run credential-gated staging**

```bash
npm run validate:registry:live
npm run eval:cardano-rag:live
```

Expected: current official sources retrieve successfully or report explicit source-specific failures; live RAG meets the same recall/citation gates before public canary.

- [x] **Step 4: Commit**

```bash
git add README.md docs/architecture/data-sources.md docs/deployment/release-checklist.md
git commit -m "docs: operate the Cardano knowledge pipeline"
```

R10 documentation and offline gates completed on 2026-08-26 in `c8700c7`.
The full suite passed (`708` tests, `66` credential-gated skips), as did
typecheck, build, compiled imports, registry coverage (`18` official and `2`
community sources), the `60`-case offline RAG evaluation (recall@10 and citation
precision `100%`, zero policy violations), dependency audit (`0`
vulnerabilities), and diff check. Independent release-document review passed.

Credential-gated staging remains open. Live registry validation reported
19 healthy sources and one explicit `degraded-with-fallback` family: the
canonical Cardano Foundation site returned `429`, while its registered
same-owner GitHub fallback passed. The official Cardano Stack Exchange API was
healthy. Live RAG remains closed before retrieval because `DATABASE_URL`,
`LITELLM_BASE_URL`, `LITELLM_API_KEY`, and the four Vennek model aliases are not
available in this environment; `GITHUB_TOKEN` is no longer an evaluator gate.
Do not open the public factual-answer canary until both live commands exit
successfully.
