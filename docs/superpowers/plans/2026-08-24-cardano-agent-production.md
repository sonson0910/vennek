# Cardano Agent Memory, On-Chain, and Production Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete durable conversation memory, read-only Cardano tools, dynamic cost control, observability, security/load assurance, and gated rollout to 10,000 daily active users.

**Architecture:** Extend the grounded Agent Core with bounded recent context, encrypted summaries, semantic memory, and a maximum-two-step tool loop. Normalize Blockfrost and Koios reads behind one read-only contract, enforce database-backed admission limits before model work, and expose content-free metrics and health gates for horizontal deployment.

**Tech Stack:** TypeScript, PostgreSQL + pgvector, LiteLLM, Blockfrost REST, Koios REST, `@scure/base`, `prom-client`, `autocannon`, Vitest, Docker Compose

---

## Prerequisites

Complete both `2026-08-24-public-cardano-agent-foundation.md` and `2026-08-24-cardano-knowledge-rag.md`. Do not start a public canary until the assurance review at the end of this plan is approved.

### Task 1: Add Bounded Long-Term Conversation Memory

**Files:**
- Create: `packages/cardano-agent/migrations/004_memory.sql`
- Create: `packages/cardano-agent/src/memory/conversationMemory.ts`
- Create: `packages/cardano-agent/src/memory/summarizeConversation.ts`
- Modify: `packages/cardano-agent/src/conversations.ts`
- Modify: `packages/cardano-agent/src/agent/answerQuestion.ts`
- Modify: `packages/cardano-agent/src/index.ts`
- Create: `scripts/delete-user-history.ts`
- Test: `tests/conversationMemory.integration.test.ts`

- [ ] **Step 1: Write a credential-gated memory test**

```ts
it("builds context from recent turns, encrypted summary, and relevant older messages", async () => {
  const memory = new ConversationMemory(db, Buffer.alloc(32, 5), fakeEmbeddings);
  const context = await memory.contextFor({ telegramUserId: "42", question: "Nhắc lại câu hỏi staking trước đây", recentLimit: 8, semanticLimit: 4 });
  expect(context.recent).toHaveLength(8);
  expect(context.semantic.length).toBeLessThanOrEqual(4);
  expect(context.allRawMessagesLoaded).toBe(false);
});
```

- [ ] **Step 2: Add searchable memory metadata**

Add `embedding vector(1536)` and `embedding_model` to accepted non-secret conversation messages, plus encrypted columns on `conversation_summaries`. Create an HNSW partial index for rows with non-null embeddings. Raw encrypted text remains the durable source of truth; embeddings are used only to find candidate message IDs.

- [ ] **Step 3: Implement context assembly**

`contextFor` loads at most eight recent turns, one current summary, and four older semantic matches. It decrypts only the selected rows and caps the assembled text at 16,000 characters. It never loads every historical message into application memory.

- [ ] **Step 4: Implement periodic summaries**

Enqueue `summarize-conversation` after every 20 accepted new messages since the last summary. The summary prompt receives the previous summary plus only those new messages, removes wallet-secret-like text again before provider access, and caps plaintext summary at 4,000 characters. Encrypt the saved summary with AES-256-GCM.

- [ ] **Step 5: Wire memory into grounded answering**

Pass the bounded context to generation after retrieval. Source evidence remains authoritative; conversation memory cannot act as a citation and cannot override safety or source content.

- [ ] **Step 6: Add administrator-only history deletion**

`scripts/delete-user-history.ts` requires `--telegram-user-id <integer>` and `--confirm-delete <same integer>`. In one transaction it deletes the `telegram_users` row and cascades messages, summaries, embeddings, and user-scoped usage data. It writes a sanitized audit event containing a SHA-256 user hash, deletion timestamp, and deleted row counts, never the Telegram ID or message content. Add an integration test proving a mismatched confirmation changes nothing and a confirmed deletion removes all user-scoped rows.

- [ ] **Step 7: Verify and commit**

Run:

```bash
DATABASE_URL=postgres://vennek:vennek@localhost:5432/vennek npm run migrate:agent
TEST_DATABASE_URL=postgres://vennek:vennek@localhost:5432/vennek npm test -- --run tests/conversationMemory.integration.test.ts tests/answerQuestion.test.ts
```

```bash
git add packages/cardano-agent/migrations packages/cardano-agent/src tests/conversationMemory.integration.test.ts tests/answerQuestion.test.ts
git commit -m "feat: add bounded long-term conversation memory"
```

### Task 2: Validate Cardano Public Identifiers and Network Intent

**Files:**
- Create: `packages/cardano-governance-skills/src/onchain/identifiers.ts`
- Modify: `packages/cardano-governance-skills/src/index.ts`
- Modify: `packages/cardano-governance-skills/package.json`
- Create: `tests/fixtures/cardano.ts`
- Test: `tests/cardanoIdentifiers.test.ts`

- [ ] **Step 1: Install the smallest Bech32 primitive**

Run: `npm install -w @vennek/cardano-governance-skills @scure/base@^2.0.0`

- [ ] **Step 2: Write failing identifier tests**

```ts
import { classifyCardanoIdentifier } from "@vennek/cardano-governance-skills";
import { MAINNET_ADDRESS, TESTNET_ADDRESS } from "./fixtures/cardano.js";

it("distinguishes mainnet from ambiguous Cardano testnets", () => {
  expect(classifyCardanoIdentifier(MAINNET_ADDRESS).network).toBe("mainnet");
  expect(classifyCardanoIdentifier(TESTNET_ADDRESS).network).toBe("testnet-ambiguous");
});

it("rejects malformed addresses and transaction hashes", () => {
  expect(() => classifyCardanoIdentifier("addr1not-valid")).toThrow(/invalid/i);
  expect(() => classifyCardanoIdentifier("f".repeat(63))).toThrow(/invalid/i);
});
```

Create deterministic public fixtures without a wallet or signing material:

```ts
import { bech32 } from "@scure/base";

function enterpriseAddress(header: number, prefix: "addr" | "addr_test"): string {
  const bytes = new Uint8Array(29);
  bytes[0] = header;
  return bech32.encode(prefix, bech32.toWords(bytes), 200);
}

export const MAINNET_ADDRESS = enterpriseAddress(0x61, "addr");
export const TESTNET_ADDRESS = enterpriseAddress(0x60, "addr_test");
```

- [ ] **Step 3: Implement strict classification**

Decode Bech32 with a 200-character maximum. Accept prefixes `addr`, `addr_test`, `stake`, `stake_test`, `pool`, and `drep`. Accept transaction hashes only as exactly 64 lowercase or uppercase hex characters and normalize to lowercase.

Return:

```ts
type CardanoIdentifier = {
  kind: "address" | "stake-address" | "pool" | "drep" | "transaction";
  value: string;
  network: "mainnet" | "testnet-ambiguous" | "network-independent";
};
```

Cardano test addresses do not identify preprod versus preview by themselves. The agent must ask the user to choose preprod or preview unless the conversation already supplies an explicit network.

- [ ] **Step 4: Verify and commit**

Run: `npm test -- --run tests/cardanoIdentifiers.test.ts && npm run typecheck`

```bash
git add package.json package-lock.json packages/cardano-governance-skills tests/cardanoIdentifiers.test.ts
git commit -m "feat: validate public Cardano identifiers"
```

### Task 3: Add Normalized Read-Only Blockfrost and Koios Clients

**Files:**
- Create: `packages/cardano-governance-skills/src/onchain/types.ts`
- Create: `packages/cardano-governance-skills/src/onchain/blockfrostReader.ts`
- Create: `packages/cardano-governance-skills/src/onchain/koiosReader.ts`
- Create: `packages/cardano-governance-skills/src/onchain/readCardanoState.ts`
- Modify: `packages/cardano-governance-skills/src/adapters/blockfrost.ts`
- Modify: `packages/cardano-governance-skills/src/index.ts`
- Test: `tests/onchainReaders.test.ts`

- [ ] **Step 1: Write normalized contract tests with fake HTTP**

```ts
import { MAINNET_ADDRESS } from "./fixtures/cardano.js";

it("normalizes an address balance without floating-point ADA", async () => {
  const result = await blockfrost.address(MAINNET_ADDRESS, "mainnet");
  expect(result).toMatchObject({ kind: "address", lovelace: "1234567", provider: "blockfrost", network: "mainnet" });
});

it("reports disagreement instead of choosing one provider", async () => {
  const result = await readCardanoState(identifier, "mainnet", { blockfrost: fake("10"), koios: fake("11") });
  expect(result.status).toBe("conflict");
  expect(result.observations).toHaveLength(2);
});
```

- [ ] **Step 2: Define a read-only result contract**

```ts
type OnChainObservation = {
  provider: "blockfrost" | "koios";
  network: "mainnet" | "preprod" | "preview";
  observedAt: string;
  kind: "address" | "stake" | "transaction" | "pool" | "drep" | "governance";
  data: Record<string, string | number | boolean | null>;
};

type OnChainReadResult = {
  status: "confirmed" | "single-provider" | "conflict" | "unavailable";
  observations: OnChainObservation[];
};
```

Represent lovelace and token quantities as decimal strings, never JavaScript floating-point numbers.

- [ ] **Step 3: Reuse the existing Blockfrost retry transport**

Extract the private Blockfrost GET/retry logic so proof verification and public reads share one authenticated, bounded JSON client. Implement only GET endpoints for address/account/transaction/pool/DRep/governance reads. Do not expose `/tx/submit`, transaction evaluation, IPFS upload, or any POST endpoint.

- [ ] **Step 4: Implement Koios fallback**

Use fixed network bases:

```ts
const KOIOS_BASE = {
  mainnet: "https://api.koios.rest/api/v1",
  preprod: "https://preprod.koios.rest/api/v1",
  preview: "https://preview.koios.rest/api/v1"
} as const;
```

Implement bounded calls for `address_info`, `account_info`, `tx_info`, `pool_info`, `drep_info`, and governance proposal reads from the current Koios OpenAPI contract. Validate response arrays and required fields before normalization. Apply the same timeout, maximum-body, retryable-status, and sanitized-error policy as Blockfrost.

- [ ] **Step 5: Cross-check without multiplying calls unnecessarily**

Use Blockfrost first. Call Koios when the question is high-impact, Blockfrost fails, or the user asks for verification. When both succeed, compare normalized identity, network, quantities, and current delegation/state fields. Return `conflict` for material differences.

- [ ] **Step 6: Verify and commit**

Run: `npm test -- --run tests/blockfrost.test.ts tests/onchainReaders.test.ts && npm run typecheck`

```bash
git add packages/cardano-governance-skills/src tests/onchainReaders.test.ts
git commit -m "feat: read Cardano state without custody"
```

### Task 4: Add a Bounded Tool Planner

**Files:**
- Create: `packages/cardano-agent/src/agent/toolPlanner.ts`
- Create: `packages/cardano-agent/src/agent/tools.ts`
- Modify: `packages/cardano-agent/src/agent/answerQuestion.ts`
- Test: `tests/toolPlanner.test.ts`

- [ ] **Step 1: Write failing routing tests**

```ts
import { MAINNET_ADDRESS } from "./fixtures/cardano.js";

it("routes a valid address question to on-chain read", () => {
  expect(planTools(`Số dư của ${MAINNET_ADDRESS} là bao nhiêu?`, [])).toMatchObject({ tools: ["read_onchain"] });
});

it("never exposes signing or transaction submission tools", () => {
  expect(AVAILABLE_TOOLS.map((tool) => tool.name)).toEqual(["retrieve_cardano", "search_cardano_web", "read_onchain", "analyze_governance"]);
});
```

- [ ] **Step 2: Implement deterministic pre-routing**

Detect validated public identifiers before model planning. Route ordinary factual questions to retrieval. Trigger live search only when retrieval is stale or empty. Route recognized governance proposals to the existing governance analysis functions as internal tools.

- [ ] **Step 3: Limit model-directed tools**

If model planning is needed, send only tool names, descriptions, and JSON schemas. Permit at most two tool rounds per user request and at most one call per tool. Reject unknown tool names, extra arguments, arbitrary URLs, and network values outside `mainnet|preprod|preview`.

- [ ] **Step 4: Enforce non-custodial and financial output rules**

Add conversational safety checks that reject instructions to submit/sign transactions, requests for seed/private keys, personalized buy/sell commands, and guaranteed-return claims. Permit sourced explanations of staking choices, market risks, and protocol mechanics.

- [ ] **Step 5: Verify and commit**

Run: `npm test -- --run tests/toolPlanner.test.ts tests/safety.test.ts tests/answerQuestion.test.ts && npm run typecheck`

```bash
git add packages/cardano-agent/src tests/toolPlanner.test.ts tests/safety.test.ts tests/answerQuestion.test.ts
git commit -m "feat: route bounded Cardano agent tools"
```

### Task 5: Enforce Dynamic Budget and Abuse Admission

**Files:**
- Create: `packages/cardano-agent/migrations/005_admission.sql`
- Create: `packages/cardano-agent/src/admission/admissionController.ts`
- Modify: `packages/cardano-agent/src/config.ts`
- Modify: `apps/telegram-bot/src/webhookRuntime.ts`
- Modify: `apps/telegram-bot/src/pollingRuntime.ts`
- Test: `tests/admissionController.integration.test.ts`
- Modify: `tests/webhookRuntime.test.ts`

- [ ] **Step 1: Write concurrency-sensitive admission tests**

Prove two simultaneous requests cannot both consume the final daily budget reservation, each Telegram user/chat has an independent burst bucket, a clock rollback does not reopen an old bucket, and rejected requests are not queued.

- [ ] **Step 2: Add exact configuration limits**

Parse positive safe integers for:

```text
VENNEK_BURST_REQUESTS=10
VENNEK_BURST_WINDOW_SECONDS=60
VENNEK_DAILY_BUDGET_USD_MICROS
VENNEK_MONTHLY_BUDGET_USD_MICROS
VENNEK_MAX_QUEUE_AGE_SECONDS=120
```

Costs are integer micro-dollars, never floating point.

- [ ] **Step 3: Implement transactional reservation**

Use a PostgreSQL transaction and row lock on the current daily/monthly budget rows. Reserve the configured worst-case cost for the selected model profile before enqueueing. After LiteLLM reports actual usage, settle the reservation and return unused capacity. Expire abandoned reservations after five minutes in a pg-boss maintenance job.

- [ ] **Step 4: Apply load shedding in this order**

1. reuse valid retrieval/CAG cache;
2. choose the configured lower-cost model profile;
3. reject new requests when the queue is too old or the budget cannot reserve;
4. never disable citation verification or wallet-secret detection.

- [ ] **Step 5: Verify and commit**

Run: `TEST_DATABASE_URL=postgres://vennek:vennek@localhost:5432/vennek npm test -- --run tests/admissionController.integration.test.ts tests/webhookRuntime.test.ts tests/pollingRuntime.test.ts`

```bash
git add packages/cardano-agent/migrations packages/cardano-agent/src apps/telegram-bot/src tests/admissionController.integration.test.ts tests/webhookRuntime.test.ts tests/pollingRuntime.test.ts
git commit -m "feat: enforce dynamic agent cost limits"
```

### Task 6: Add Content-Free Metrics and Readiness

**Files:**
- Create: `packages/cardano-agent/src/observability/metrics.ts`
- Create: `apps/telegram-bot/src/health.ts`
- Modify: `packages/cardano-agent/package.json`
- Modify: `apps/telegram-bot/src/main.ts`
- Test: `tests/metrics.test.ts`
- Test: `tests/health.test.ts`

- [ ] **Step 1: Install the metrics primitive**

Run: `npm install -w @vennek/cardano-agent prom-client@^15.1.0`

- [ ] **Step 2: Write failing label-safety tests**

Assert metric names cover webhook latency, answer latency, queue age, provider outcome, source freshness, retrieval outcome, citation verification, on-chain conflict, and cost. Assert no metric accepts message, prompt, answer, URL, Telegram user ID, Telegram chat ID, or source excerpt as a label.

- [ ] **Step 3: Implement a fixed metrics registry**

Allowed low-cardinality labels are `provider_profile`, `outcome`, `trust_tier`, `network`, and `job_name`. Hashes and IDs are not metric labels. Export Prometheus text at `GET /metrics` only when protected by `VENNEK_METRICS_TOKEN` or a private network binding.

- [ ] **Step 4: Split health from readiness**

- `GET /health/live`: process event loop responds; no external dependency.
- `GET /health/ready`: database query, pg-boss state, required migrations, encryption-key configuration, and Telegram/LiteLLM configuration are valid.
- `GET /health/dependencies`: administrator-protected details for provider health, critical source freshness, SearXNG, Blockfrost, and Koios.

Never print secrets or raw upstream error bodies.

- [ ] **Step 5: Verify and commit**

Run: `npm test -- --run tests/metrics.test.ts tests/health.test.ts && npm run typecheck`

```bash
git add package.json package-lock.json packages/cardano-agent apps/telegram-bot/src tests/metrics.test.ts tests/health.test.ts
git commit -m "feat: observe public agent health safely"
```

### Task 7: Complete Security and Provider Contract Assurance

**Files:**
- Create: `tests/security/publicAgentSecurity.test.ts`
- Create: `tests/contracts/litellm.contract.test.ts`
- Create: `tests/contracts/blockfrost.contract.test.ts`
- Create: `tests/contracts/koios.contract.test.ts`
- Create: `tests/contracts/searxng.contract.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Add deterministic adversarial security cases**

Cover webhook secret bypass, duplicate update replay, rate-limit concurrency, SSRF/DNS rebinding, redirects, oversized bodies, prompt injection in official/community documents, tool-name injection, arbitrary on-chain URLs, recovery phrases, signing-key JSON, log redaction, ciphertext tampering, and unsupported factual claims.

Every secret fixture is synthetic. The test must assert it is absent from database rows, fetch bodies, logs, model requests, traces, and returned errors.

- [ ] **Step 2: Add credential-gated live contracts**

Each provider contract test skips unless its explicit test credential exists. It performs one bounded read request, validates the current response schema, records no response body in logs, and never mutates remote state. Blockfrost contract coverage excludes every POST endpoint; Koios uses only read queries.

Add scripts:

```json
"test:security": "vitest run tests/security",
"test:contracts": "vitest run tests/contracts"
```

- [ ] **Step 3: Run offline assurance**

Run: `npm run test:security && npm test -- --run && npm run typecheck && npm audit --audit-level=moderate`

Expected: all offline tests pass and audit reports zero moderate-or-higher vulnerabilities.

- [ ] **Step 4: Run live contracts in staging**

Run: `npm run test:contracts`

Expected: configured contracts pass; unconfigured providers report skipped rather than passed.

- [ ] **Step 5: Commit**

```bash
git add package.json tests/security tests/contracts
git commit -m "test: assure public agent trust boundaries"
```

### Task 8: Add Load and Failure Testing

**Files:**
- Create: `scripts/load-test-webhook.ts`
- Create: `scripts/fault-test-agent.ts`
- Modify: `package.json`
- Modify: `docs/deployment/release-checklist.md`

- [ ] **Step 1: Install the load-test client**

Run: `npm install -D autocannon@^8.0.0 @types/autocannon@^7.12.0`

- [ ] **Step 2: Implement the webhook load scenario**

Generate unique synthetic Telegram update/user/chat IDs and a fixed greeting that does not invoke a model. Run 25 requests/second for 15 minutes against staging, require zero unauthorized accepts, zero duplicate jobs, less than 1% non-2xx responses, and webhook acknowledgement p95 below 500 ms.

Add script:

```json
"load:webhook": "tsx scripts/load-test-webhook.ts"
```

- [ ] **Step 3: Implement bounded fault scenarios**

With fake dependencies, test one provider down, all providers down, stale source index, SearXNG down, Blockfrost/Koios disagreement, PostgreSQL restart, worker termination during a job, Telegram 429, exhausted daily budget, and dead-letter recovery. Assert no scenario fabricates an answer or processes an update more than once.

- [ ] **Step 4: Verify and commit**

Run: `npm run load:webhook` against isolated staging and `tsx scripts/fault-test-agent.ts` locally.

Expected: load thresholds pass and every fault scenario reports the expected bounded failure mode.

```bash
git add package.json package-lock.json scripts/load-test-webhook.ts scripts/fault-test-agent.ts docs/deployment/release-checklist.md
git commit -m "test: verify agent load and failure behavior"
```

### Task 9: Finalize Backup, Restore, Rollback, and Public Rollout

**Files:**
- Create: `scripts/verify-backup-restore.sh`
- Create: `scripts/rotate-conversation-key.ts`
- Create: `docs/deployment/public-agent-runbook.md`
- Modify: `docker-compose.yml`
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `docs/product/PRD.md`
- Modify: `docs/product/safety-policy.md`
- Modify: `docs/deployment/release-checklist.md`

- [ ] **Step 1: Add encrypted backup/restore verification**

The script creates a PostgreSQL custom-format backup, restores into a newly created isolated database name supplied as an explicit argument, runs migration/status checks, verifies message ciphertext decrypts with the staging encryption key, verifies source/chunk counts, and drops only that explicitly named verification database after success. It must reject empty names, `postgres`, `template0`, `template1`, and the configured production database name.

- [ ] **Step 2: Implement recoverable conversation-key rotation**

Add `key_version integer NOT NULL DEFAULT 1` to encrypted message and summary rows in migration `004_memory.sql`. `rotate-conversation-key.ts` requires old/new 32-byte keys from explicit mode-0600 file paths plus monotonically increasing old/new integer versions. It processes rows in bounded transactions of 500: decrypt with the old version, encrypt with the new key, update ciphertext/IV/tag/key version, and record only counts. A failed batch rolls back and can resume by selecting the old version. Add an integration test that rotates two messages and one summary, proves the new key decrypts them, and proves the old key no longer does.

- [ ] **Step 3: Document the production deployment**

Document secret creation/rotation, migrations, webhook registration, worker scaling, connection pooling, source sync, dead-letter replay, budget changes, blocklist operations, administrator-only history deletion, backup restore, image rollback, and incident response. State that encryption-key loss makes retained history unrecoverable.

- [ ] **Step 4: Replace governance-only positioning**

Update active product documents to describe the public multilingual Cardano agent. Preserve the explicit non-custodial, no-personalized-financial-advice, cited-or-unverified, and human-verification requirements. Mark old pilot/staging reports as historical instead of rewriting past evidence.

- [ ] **Step 5: Run the complete release gate**

```bash
npm ci --ignore-scripts
npm test -- --run
npm run test:security
npm run typecheck
npm run build
npm run verify:imports
npm run validate:registry
npm run eval:cardano-rag
npm audit --audit-level=moderate
npm audit --omit=dev --audit-level=moderate
git diff --check
```

Then run credential-gated staging:

```bash
npm run validate:registry:live
npm run eval:cardano-rag:live
npm run test:contracts
npm run load:webhook
```

Expected: every offline gate passes; every configured live integration passes; skipped credentials are listed explicitly and block public rollout for the affected capability.

- [ ] **Step 6: Perform mandatory independent assurance review**

After implementation and verification are finished, request one independent general reviewer and one independent security reviewer. Resolve every substantiated finding, rerun the affected gates, and send the fixes back to the same reviewers for re-review. Do not begin public canary until both approve.

- [ ] **Step 7: Roll out by measured gates**

Run internal staging, then a small public canary, then 1,000 DAU, then 10,000 DAU. Pause expansion automatically if citation precision falls below 95%, retrieval recall@10 below 90%, critical sources are stale, p95 webhook acknowledgement exceeds 500 ms, error rate exceeds 1%, or a daily/monthly budget ceiling is reached.

- [ ] **Step 8: Commit**

```bash
git add scripts/verify-backup-restore.sh scripts/rotate-conversation-key.ts docs/deployment/public-agent-runbook.md docker-compose.yml .env.example README.md docs/product docs/deployment/release-checklist.md
git commit -m "docs: prepare public Cardano agent launch"
```
