# Public Cardano AI Agent Design

**Date:** 2026-08-24
**Status:** Approved in conversation; awaiting review of this written spec

## 1. Objective

Transform Vennek from an allowlisted Cardano governance command bot into a
public, multilingual Telegram AI agent that answers natural-language questions
across the Cardano ecosystem. Answers must be grounded in attributable sources,
use current on-chain or web data when required, and state when evidence is
missing or conflicting.

The initial production target is 10,000 daily active users. Runtime limits are
dynamic and governed by load and a configurable daily/monthly cost ceiling.

## 2. Product Decisions

- Telegram is the only public channel in this phase.
- Users ask natural-language questions. Governance commands are not exposed as
  the primary interface; reusable governance logic may remain as internal tools.
- The agent detects the input language and responds in that language.
- OpenAI, Anthropic, and Gemini are supported through one provider gateway.
- The knowledge system covers official Cardano organizations first and selected
  community sources second. Community evidence is always labeled.
- Source synchronization is automatic and can also be triggered by an
  administrator.
- Governance and GitHub sources refresh hourly; stable documentation refreshes
  daily.
- Public access does not require registration or an invite. Usage is dynamically
  rate-limited by user, chat, system load, and configured budget.
- Full conversation history is retained indefinitely per Telegram user. The
  first interaction displays a short retention notice. Only administrators can
  delete stored history.
- Stored conversations are not used for model training without a separate,
  explicit consent mechanism.
- Public Cardano addresses can be inspected on mainnet, preprod, and preview.
- The agent never accepts wallet secrets, signs transactions, or submits
  transactions.
- Financial questions receive sourced data, alternatives, and risks, but no
  personalized buy, sell, or profit recommendation.
- No general agent harness is added initially. A dedicated evaluation harness is
  required.

## 3. Architecture

```text
Telegram webhook
  -> webhook authentication, deduplication, dynamic rate limit
  -> PostgreSQL-backed job queue
  -> Agent Core
       -> conversation memory
       -> Cardano hybrid RAG
       -> live web search when needed
       -> read-only on-chain tools
       -> LiteLLM provider routing
       -> claim/citation verification and safety policy
  -> Telegram response

Knowledge scheduler
  -> source registry
  -> Crawlee / GitHub adapters
  -> normalization and versioning
  -> chunking and embedding
  -> PostgreSQL + pgvector
```

### 3.1 Telegram Gateway

Production receives Telegram webhooks and validates Telegram's secret-token
header. It records update IDs idempotently, acknowledges accepted updates
quickly, and queues the expensive work. Existing polling remains a local
development fallback only.

The required chat allowlist is removed from the public path. An administrator
blocklist remains available for confirmed abuse. Existing bounded send retry,
poison-update handling, sanitized logs, and rate-limit safeguards are retained.

### 3.2 Agent Core

The Agent Core is a small explicit TypeScript orchestrator, not a general agent
framework. It:

1. identifies language, Cardano relevance, intent, and complexity;
2. loads recent messages, the durable conversation summary, and relevant older
   memories;
3. selects RAG, live search, governance analysis, or read-only on-chain tools;
4. requests a response through the provider gateway;
5. verifies factual claims against the retrieved evidence; and
6. formats a concise Telegram-safe answer in the user's language.

Tool calls use fixed schemas and an allowlist. Retrieved documents are
untrusted data and cannot grant tool authority or override system policy.

### 3.3 Provider Gateway

LiteLLM provides one OpenAI-compatible gateway for OpenAI, Anthropic, and
Gemini. Routing selects a model profile rather than hard-coding a provider:

- a fast, lower-cost profile for routine questions;
- a higher-quality profile for complex technical, governance, or conflicting
  evidence questions; and
- a verifier profile for claim/citation checks.

Routing considers task complexity, provider health, latency, current spend, and
the configured budget ceiling. A failed or unavailable provider falls back to a
different configured provider. If all providers fail, the bot returns a clear
temporary-failure message and does not fabricate an answer.

Generation providers are interchangeable. Embeddings are not mixed: each index
version uses exactly one multilingual embedding model and dimension. Changing
the embedding model builds a new index and switches only after validation.

### 3.4 Storage and Jobs

PostgreSQL is the system of record for users, conversations, summaries, source
metadata, immutable document versions, chunks, embeddings, citations, usage,
cost, job state, and sanitized audit events. pgvector supplies exact and HNSW
vector search alongside PostgreSQL full-text search.

pg-boss supplies scheduled and asynchronous work without adding Redis. Jobs
cover source refresh, parsing, embedding, summaries, evaluation, and retries.
Failed jobs use exponential backoff and then a dead-letter queue.

Conversation tables are time-partitioned so indefinite retention does not make
routine queries scan the entire history. Backup and restore preserve encrypted
conversation data and source-version provenance.

### 3.5 Deployment Portability

For a VPS, Docker Compose runs the Telegram service, worker, LiteLLM, and
PostgreSQL/pgvector. For cloud or serverless deployment, the same application
images run as a stateless webhook service and scalable workers backed by a
managed PostgreSQL-compatible database.

Gateway and worker instances scale horizontally. Database connection pooling is
required before increasing instance count. Runtime behavior is configured by
environment or secret-manager values, not deployment-specific code branches.

## 4. Cardano Knowledge System

### 4.1 Source Registry

Coverage is represented by a data-driven source registry. Adding a compatible
source changes registry data rather than Agent Core code. Each entry records:

- stable source ID and owner;
- canonical domains, repositories, feeds, or API endpoints;
- trust tier and content category;
- applicable Cardano networks;
- refresh schedule and parser type;
- allowed crawl scope, robots/license notes, and content limits;
- last successful retrieval and content hash.

Required official source families include:

- Cardano Docs, cardano.org, and the Cardano Developer Portal;
- IOG/IOHK engineering, research, papers, repositories, and release material;
- Cardano Foundation publications and repositories;
- EMURGO technical and educational material;
- Intersect, CIPs, governance specifications, and maintained core repositories;
- Project Catalyst documentation and public proposal material;
- GovTool and public governance-action material;
- official documentation and releases for core Cardano components, including
  node, ledger, consensus, Plutus/Plinth, Aiken, wallets, and supported developer
  tooling.

The registry is intentionally expandable. The product must report measured
coverage by source family and must not claim literal coverage of every Cardano
page on the internet.

### 4.2 Trust Tiers

1. **Official:** material published by the responsible Cardano organization or
   project maintainer. This is authoritative evidence.
2. **Selected ecosystem/community:** maintained projects, Cardano Forum,
   Cardano Stack Exchange, technical articles, and other approved sources. These
   are labeled and used as supplementary evidence.
3. **Unverified discovery:** live search results not yet approved in the source
   registry. These can identify candidate evidence but cannot be the only support
   for an important factual claim.

Official evidence outranks community evidence. When current official sources
conflict, the answer displays the conflicting positions, publishers, and dates
instead of choosing silently.

### 4.3 Ingestion and Versioning

Crawlee handles permitted sitemap, feed, HTML, and document crawling. Dedicated
adapters use GitHub APIs for repositories, documentation, tags, and releases.
Conditional and incremental retrieval avoids downloading unchanged content and
respects upstream rate limits.

Supported inputs include HTML, Markdown, plain text, JSON, and text-extractable
PDFs. Normalization removes navigation and boilerplate without changing quoted
source content. Chunking preserves headings, code blocks, document identity,
canonical URL, publication/retrieval dates, and the immutable source-version
hash.

The system respects robots rules, licenses, and access controls. Public answers
summarize content and link to the source; they do not reproduce long copyrighted
passages.

### 4.4 Retrieval

Retrieval combines:

- PostgreSQL full-text ranking;
- pgvector similarity;
- source tier, organization, topic, network, language, and date filters; and
- reranking of the candidate set before context construction.

Queries are normalized across languages while retaining the original wording.
Stable source IDs and version hashes bind citations to the exact retrieved
chunks. The system retrieves only the context needed for the question.

If indexed evidence is missing or stale, a self-hosted SearXNG adapter performs
live discovery. Official domains are searched first. Selected results are
fetched through the existing hardened remote-fetch boundary before they can be
used as evidence.

### 4.5 RAG, CAG, and Cache Invalidation

RAG is the authoritative context mechanism. CAG-style caching is limited to
stable canonical material and common retrieval results. Cache keys include
source-version hashes, language, retrieval configuration, and model profile.
Changing a source version invalidates dependent cache entries.

Personalized answers, wallet state, current governance, releases, and other
time-sensitive data are never served from a long-lived answer cache.

## 5. Conversation Memory and Data Handling

The complete Telegram conversation is retained per user, subject to the
security exception below. Model context uses only:

- a bounded number of recent turns;
- a maintained long-term summary; and
- semantically relevant older messages.

Raw history is not copied wholesale into each model request. This controls cost,
latency, and prompt size while preserving durable recall.

At first use, the bot states that conversations are retained indefinitely, are
not used for training without separate consent, and can be removed only through
an administrator process. Application and backup access is restricted and
audited. Conversation content is encrypted at rest using managed or
operator-controlled keys distinct from the database credentials.

Seed phrases, private keys, signing keys, and equivalent wallet secrets are a
mandatory exception to full-history retention. They are detected before normal
persistence or provider calls, discarded, and replaced with a security warning.
Operational logs never contain raw messages, retrieved private content, or
provider credentials.

## 6. Read-Only Cardano Tools

The agent can inspect user-supplied public addresses and identifiers across
mainnet, preprod, and preview. It can explain balances, assets, transactions,
delegation, stake pools, rewards, and public governance data when the configured
indexers expose them.

The existing Blockfrost adapter is reused and extended. A second read provider,
such as Koios where network and endpoint coverage permit, supplies resilience
and cross-checking. Network is derived from validated address or identifier
formats; ambiguous input requires clarification.

The application has no signing-key input, wallet connector, transaction builder,
signing operation, or submission endpoint. If on-chain providers disagree, the
agent reports the discrepancy and does not infer a definitive state.

## 7. Public Access, Cost, and Abuse Controls

Public users do not register. Fixed product quotas are replaced by dynamic
limits based on:

- Telegram user and chat;
- short-window burst behavior;
- global queue and provider load;
- provider-specific capacity; and
- configured daily and monthly cost ceilings.

When spend approaches a ceiling, routing first uses an allowed lower-cost model
profile and retrieval/cache where valid, then reduces request admission. It
never silently removes citation verification to save money. Users receive an
explicit retry or limit message.

The current SSRF, DNS/IP, scheme, redirect, MIME, body-size, local-file,
persistence-path, retry, and sanitized-log protections remain in force. Public
access broadens authorization but does not weaken any input or data boundary.

## 8. Failure Behavior

- **No supporting evidence:** answer only what is supported and mark the rest as
  unverified or unavailable.
- **Conflicting evidence:** identify each source, date, and disagreement.
- **Search failure:** use the latest indexed evidence and disclose its freshness.
- **On-chain disagreement:** report inconsistent provider data without guessing.
- **One LLM provider fails:** apply the configured fallback policy.
- **All LLM providers fail:** return a temporary-failure response.
- **Telegram delivery fails:** use the existing send-only retry limit of three.
- **Ingestion fails:** retry with backoff, then dead-letter the job and retain the
  previous valid source version.
- **Budget exhausted:** reject or defer new work with a clear user-facing message.

No failure path fabricates a source, a citation, an on-chain state, or a Cardano
fact.

## 9. Observability and Operations

The service records content-free operational metrics for:

- webhook acknowledgement and end-to-end answer latency;
- accepted, limited, failed, and retried requests;
- queue depth, age, retries, and dead letters;
- provider latency, errors, fallbacks, token usage, and cost;
- retrieval hits, source tier distribution, and source freshness;
- claim/citation verification outcomes; and
- on-chain provider health and disagreements.

Health checks distinguish liveness, readiness, database access, queue health,
provider configuration, source freshness, and optional external integration
status. Alerts cover cost ceilings, stale critical sources, queue backlog,
provider failure, citation regressions, and backup failure.

Backups run automatically and restore is tested periodically. Releases use
versioned container images. Rollback restores the prior image; database changes
remain backward compatible for one release cycle.

## 10. Evaluation and Testing

### 10.1 Evaluation Harness

The repository includes a repeatable Cardano evaluation corpus spanning:

- fundamentals, consensus, staking, native assets, transactions, and wallets;
- Plutus/Plinth, Aiken, nodes, APIs, and developer tooling;
- governance, CIPs, GovTool, Catalyst, and treasury topics;
- ecosystem and selected community knowledge;
- live and historical on-chain questions;
- multilingual questions;
- stale, missing, and conflicting evidence; and
- adversarial source text and prompt injection.

Each case records the question, language, expected evidence, source version or
validity date, acceptable answer properties, and forbidden unsupported claims.
Evaluation results are versioned so retrieval, embedding, model, prompt, and
source changes can be compared.

### 10.2 Release Gates

- Every factual claim has a bound citation or an explicit unverified label.
- Citation precision is at least 95% on the approved evaluation corpus.
- Retrieval recall@10 is at least 90% on the approved retrieval corpus.
- Community evidence never silently overrides conflicting official evidence.
- Security tests prove detected wallet secrets are neither stored nor sent to an
  AI provider.
- The source registry reports coverage for every required official source
  family.
- Existing tests, type checking, build, import verification, source validation,
  and dependency audit remain green.

### 10.3 Integration, Security, and Load Tests

Contract tests cover Telegram, LiteLLM, all three generation providers,
embedding, SearXNG, Blockfrost, Koios, PostgreSQL, and job execution. Fault tests
cover provider fallback, cost caps, retries, dead letters, backup/restore, and
backward-compatible migrations.

Security tests cover webhook authentication, update replay, rate-limit bypass,
SSRF and DNS rebinding, prompt injection, unsafe tool calls, secret detection,
log redaction, and encrypted persistence.

Before the 10,000-DAU gate, the system sustains at least 25 accepted requests per
second for 15 minutes, with webhook acknowledgement p95 below 500 ms. Answer
latency is measured separately by provider/model profile and must stay within the
published operational target for that profile.

## 11. Rollout

1. Build and validate offline ingestion, retrieval, and evaluation.
2. Run credential-gated staging with real providers and current sources.
3. Open a small public canary and observe accuracy, abuse, cost, and latency.
4. Increase to 1,000 daily active users after gates remain healthy.
5. Increase toward 10,000 daily active users only while quality, freshness,
   security, cost, and latency gates remain satisfied.

Rollout automatically pauses when citation quality, error rate, latency, source
freshness, or cost crosses its configured threshold.

## 12. Explicit Non-Goals

- A website or additional messaging channel.
- A general-purpose assistant for topics unrelated to Cardano.
- A multi-agent or long-running autonomous workflow platform.
- A wallet connector, key custody, signing, transaction construction, or
  transaction submission.
- Personalized investment advice, buy/sell instructions, or profit guarantees.
- Training models on stored conversations.
- Claiming literal ingestion of every Cardano-related page on the internet.
