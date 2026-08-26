# Data Sources

## Cardano Knowledge Registry

`config/cardano-sources.json` is the source of truth for the shared Cardano
knowledge index. The envelope has only `official` and `community` arrays; each
entry is validated before a worker schedules or runs it. The current registry
covers 18 official sources from Cardano, Cardano Docs, the Developer Portal,
IOG research and GitHub, Cardano Foundation and GitHub, EMURGO, Intersect and
GitHub, CIPs, Project Catalyst, GovTool, node releases, the ledger,
Ouroboros Consensus, Plutus, and Aiken. It also contains the registered
community sources Cardano Forum and Cardano Stack Exchange.

Trust tiers are deliberate:

- `official` is the preferred evidence tier and receives retrieval priority.
- `community` is supporting evidence and is labelled when it is the only
  support for a claim.
- `unverified` is a discovery result that is not in the registry. It may be
  returned internally as a candidate, but it is never promoted or used as the
  sole factual citation.

The exact conflict rule is non-negotiable: a community source never silently
overrides an official source. When official evidence conflicts, the answer
must identify the official publishers and present the conflict; a community
source can add context but cannot replace that official position. Retrieval
also gives official evidence a higher score, and the evaluation gate rejects
community-overrides-official cases.

### Registry change workflow

1. Add, remove, or edit only a validated entry in
   `config/cardano-sources.json`. Set the correct tier, owner, kind, HTTPS URL,
   `allowedDomains`, topics, networks, refresh rate, and (for GitHub) the
   approved owner/repository pair. Never add a URL received from a Telegram
   message.
2. Run the offline contract and coverage gate:

   ```bash
   npm run validate:registry
   npm test -- --run tests/sourceRegistry.test.ts tests/knowledgeWorker.test.ts
   npm run typecheck
   ```

3. Before staging, run `npm run validate:registry:live`. It performs bounded
   live requests through the hardened fetch boundary, reports source-specific
   failures, and never mutates the registry.
4. Deploy the registry with the application image. The knowledge worker
   reloads and validates it at startup, removes schedules for deleted IDs, and
   reloads it again for every queued job. Queue payloads contain only the exact
   `sourceId`, never a caller-supplied URL.

## Machine-Access Status and Provenance

The Cardano Foundation canonical monitor may be reported as
`degraded-with-fallback` when its own endpoint fails and its registered
official GitHub fallback passes. It must never be labelled healthy in that
state. A `monitor-only` source is probeable but is neither scheduled nor
manually syncable; the fallback remains its own registered source with its own
GitHub provenance and citation.

Cardano Stack Exchange ingestion uses the official Stack Exchange API rather
than its challenge-protected HTML homepage. The homepage challenge is an
availability signal, not evidence. Every citation retains the post author,
the constructed question/answer URL, and the exact `content_license` (CC
BY-SA); returned links are not treated as fetch instructions.

## Legacy Governance Proposal Sources

This section describes the older proposal pre-submit tooling, not the shared
Cardano RAG registry or knowledge index. Operator-provided text and URLs in this
flow cannot add or change registry entries and are never promoted into the
shared knowledge index.

### Source Classes

- Catalyst proposal pages or snapshots.
- GovTool/governance action pages or snapshots.
- User-provided text, markdown, or URL fallback.

### MVP Source Strategy

The MVP includes deterministic offline fixtures under `samples/proposals` and a sample-mode validation script:

```bash
npm run validate:sources
```

This validates the `ProposalDocument` contract and citation requirement without depending on live website shape. The npm script writes `samples/proposals/validation-results.json`; running the script directly without `--write-report` prints JSON to stdout and avoids mutating the working tree.

### Live Pre-Submit Validation

Production pre-submit validation uses real operator-provided sources and never fabricates entries:

```bash
npm run validate:sources:live
npm run validate:sources:live -- --file path/to/sources.txt
```

By default the script reads `samples/proposals/live-sources.txt`. Add one real URL or pasted source text entry per line; blank lines and `#` comments are ignored. The live run resolves each entry through the same source normalization path used by commands, records pass/fail reasons, and fails unless at least 20 real entries are provided and at least 15 normalize with usable citations.

Current repository validation includes mixed live coverage: Catalyst proposal pages, GovTool/governance documentation pages, user-provided fallback text samples, and one expected SSRF-block failure sample to prove failures are recorded with reasons.

## Remote Fetch Safety

Remote source fetching is HTTPS-only and rejects credentials,
private/loopback/link-local/multicast/reserved IPs after DNS resolution,
unsupported content types, redirects, and URLs outside the entry's
`allowedDomains`. Local file reads are disabled by default and require an
explicit trusted root.

The production crawler is bounded at every layer:

| Boundary | Limit |
| --- | --- |
| URLs per source crawl | 500 |
| Concurrent requests | 4 |
| One response | 8 MiB |
| Aggregate crawl responses | 128 MiB |
| One request deadline | 8 seconds |
| Crawl deadline | 120 seconds |
| Normalized extracted document | 2,000,000 characters |
| PDF pages | 300, only through the isolated PDF extractor |

HTML, Markdown, plain text, and JSON are extracted; XML is accepted for sitemap
discovery. PDF is accepted only when the extractor boundary is configured.
HTML links and sitemap `loc` values are rechecked against the same HTTPS and
registry scope. The crawler itself does not retry; the source queue owns retries. GitHub reads are limited
to approved API endpoints, use stored ETags, and defer on rate limits for at
most 24 hours. A GitHub README is additionally capped at 4 MiB.

## Synchronization Operations

The knowledge worker owns the `sync-cardano-source` queue in the
`knowledge_boss` schema. Sources use these UTC schedules:

- hourly: `0 * * * *`;
- daily: `15 2 * * *`.

Each scheduled or manual job is singleton-keyed by source ID. The queue allows
two retries with a 60-second starting delay, exponential backoff, and a
900-second maximum delay. Failed jobs go to `sync-cardano-source-dead`.
The indexer stores immutable source versions and replaces a version's chunks
atomically; a failed refresh therefore leaves the previous indexed version
available.

For a manual refresh, use the compiled command with an exact registry ID:

```bash
node apps/telegram-bot/dist/main.js --sync-source cardano-cips
```

Dead-letter recovery is an operator action, not a raw payload replay:

1. Inspect the dead queue and sanitized worker logs for the `sourceId` and
   failure class; do not copy a URL or document into a job.
2. Fix the registry, source availability, GitHub credential, or rate-limit
   condition, then validate the registry.
3. Requeue through the canonical source-ID command above (or wait for the
   next schedule). The worker reloads the registry and applies the same scope
   and size checks. Record the dead-letter cause and the resulting sync.

## Live Discovery

When retrieval is empty or stale, the agent worker may make one internal,
question-only request to the knowledge worker and then retry retrieval once.
The request is `POST /internal/knowledge/promote`, signed with the configured
HMAC-SHA256 service identity. The endpoint is exposed only on the Compose
network; it accepts an NFC-normalized question of at most 4,096 Unicode code
points and 16 KiB UTF-8, with a 64 KiB body cap. It receives no URL, source ID,
Telegram identity, conversation history, file, or provider credential.

The knowledge worker sends that question to the configured `SEARXNG_BASE_URL`.
Before canary, the operator must use a controlled SearXNG deployment or approve
the origin's privacy, query-logging, retention, and egress policy; the internal
promotion endpoint alone does not keep the search query inside Compose.

Discovery searches official registered domains first. Community domains are
searched only if the official pass yields no exact registry match. Results are
deduplicated and at most three unique registry sources are promoted. Every
link is fetched and scope-checked again before indexing; an unregistered link
stays unverified. The whole operation has a 45-second deadline, records only a
safe aggregate audit outcome, and returns no source content or provider error.
If discovery fails, the existing evidence is retained and the agent returns an
insufficient/stale-evidence response rather than fabricating an answer.

## Managed Provider and Live Gates

Vennek receives only `DATABASE_URL`, `LITELLM_BASE_URL`, `LITELLM_API_KEY`, and
the `VENNEK_MODEL_FAST`, `VENNEK_MODEL_QUALITY`, `VENNEK_MODEL_VERIFIER`, and
`VENNEK_EMBEDDING_MODEL` aliases in its service environment. `.env.example` is
a shared Compose input template and therefore contains provider placeholders
for LiteLLM. `deploy/vennek.env.example` and the Vennek service environment
blocks omit provider keys; Compose injects them only into `litellm`. Provider
keys never enter the Vennek service, evaluator process, or reports.
`GITHUB_TOKEN` is optional worker-only ingestion capacity for GitHub rate
limits; it is never a live RAG gate.

The current 1,536-dimensional embedding alias is OpenAI
`text-embedding-3-small`. Staging LiteLLM therefore needs a real
`OPENAI_API_KEY` through LiteLLM's own mode-0600 secret file or secret manager;
the real key is never committed; the shared example contains only a placeholder
and the Vennek deployment example omits it. The checked-in
static LiteLLM/Compose template declares all OpenAI, Anthropic, and Gemini
completion routes, so every provider key/model pair is a deployment prerequisite
and partial pairs are invalid. These provider routes remain LiteLLM-side only,
not evaluator credentials. An OpenAI-only deployment requires a separate,
reviewed removal of the unused static routes and their Compose requirements;
never use empty or mismatched defaults.

Run the evaluator with only its seven direct variables and a reachable existing
LiteLLM endpoint. The preferred isolated command is:

```bash
docker compose exec -T agent-worker npm run eval:cardano-rag:live
```

The current image does not copy `samples/evaluation/cardano-rag.jsonl`, so that
command is not compatible until the image is rebuilt with the evaluator corpus.
Until then, use a mode-0600 restricted environment containing exactly
`DATABASE_URL`, `LITELLM_BASE_URL`, `LITELLM_API_KEY`, the three
`VENNEK_MODEL_*` aliases, and `VENNEK_EMBEDDING_MODEL`, with an already
reachable LiteLLM endpoint; do not expose a LiteLLM host port solely for this
check. Retrieve only the sanitized report path/status/metrics from
`reports/evaluation` under its mode-0700 directory; never echo the environment
or report bodies/tokens/provider errors.

The public factual canary stays disabled until both
`validate:registry:live` and `eval:cardano-rag:live` exit zero with real
credentials. Fixture and offline runs do not satisfy this gate. Live reports
are sanitized and mode `0600`, containing no response bodies, tokens, provider
errors, or credentials.

## Cache Invalidation and Volatile Evidence

`retrieval_cache` is keyed by normalized query, language, filters, and
embedding model. Its `source_version_fingerprint` is the SHA-256 fingerprint
of the singleton `knowledge_revision` value. The revision increments when
registry metadata changes or indexed chunks are replaced, so a cache row is a
miss after either event. Stable cache entries expire after 15 minutes and are
written only when the retrieved set contains no volatile source.

Caching is disabled for personalized requests and volatile questions, including
current/latest/now, on-chain, wallet/balance/transaction, epoch, governance,
release, block-height, and equivalent localized terms. GitHub sources and
sources tagged for governance, releases, on-chain, node, ledger, staking,
delegation, or voting are volatile. Volatile evidence is fresh for two hours;
stable evidence is fresh for 48 hours. An indexed source-version or
trust/registry change therefore invalidates the revision fingerprint, while volatile material
cannot be hidden behind a stable cache.

## Embedding-Model Rebuild and Cutover

`knowledge_chunks.embedding_model` identifies the active index and every
retrieval query filters on the configured `VENNEK_EMBEDDING_MODEL`. The current
schema keeps one chunk set per source version: rebuilding with another model
atomically replaces that version's old chunks. A model change therefore needs
a coordinated maintenance window; it is not a zero-downtime dual-index
cutover.

1. Confirm the replacement model is approved and still produces the required
   1,536-dimensional vectors.
2. Take and verify a database backup, pause the agent and knowledge workers,
   and set the same new `VENNEK_EMBEDDING_MODEL` for both services.
3. Start only the knowledge worker, enqueue one exact `--sync-source` job for
   every registry ID, and wait for the queue to drain with no unresolved dead
   letters.
4. Verify that every source has complete chunks for the new model and run the
   offline and live RAG gates before restarting the agent worker.
5. If validation fails, restore the verified backup or restore the old model
   configuration and rebuild every source before reopening factual answers.

The indexer skips embedding only when the requested model already has the
complete expected chunk set, so a model change naturally rebuilds each source.

## Failure Policy

If a live source fails to fetch or normalize, Vennek must record the failure and produce explicit source-unavailable status. It must not fabricate proposal content or citations.
