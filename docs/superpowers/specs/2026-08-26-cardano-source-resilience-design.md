# Cardano Source Resilience and Managed Live-Gate Design

**Date:** 2026-08-26
**Status:** Implemented; credential-backed live RAG staging remains open
**Scope:** Resolve machine-access failures for registered Cardano sources and
make the live RAG credential gate reflect the dependencies it actually uses.

## Problem

The canonical Cardano Foundation website is reachable in an interactive
browser but returns a Vercel challenge with HTTP 429 to the hardened server-side
fetcher. Cardano Stack Exchange similarly returns a Cloudflare challenge with
HTTP 403. Retrying, changing the path, or changing the user agent does not make
either origin a dependable ingestion endpoint.

The live RAG evaluator also requires `GITHUB_TOKEN` even though evaluation reads
already-indexed evidence and does not call GitHub. The remaining database and
LiteLLM settings are real runtime dependencies and cannot be fabricated by the
repository.

## Goals

- Keep canonical publisher sites visible and continuously monitored.
- Ingest through explicitly approved machine-readable endpoints when a
  canonical site is intentionally hostile to automated fetches.
- Preserve the exact provenance of every indexed document and citation.
- Never let a community source silently replace an official publisher.
- Stop known monitor-only sites from creating scheduled dead letters.
- Make live validation report healthy, degraded-with-fallback, and failed
  states without hiding upstream failures.
- Use a managed provider behind the existing LiteLLM boundary for staging and
  production live evaluation.

## Non-Goals

- Bypassing CAPTCHA, Vercel, Cloudflare, robots controls, or upstream terms.
- Adding Playwright, a browser crawler, or a third-party scraping service.
- Treating search-result snippets as grounded evidence.
- Citing the Cardano Foundation homepage for content fetched from GitHub.
- Making database, LiteLLM, or model credentials optional for a real live RAG
  evaluation.
- Replacing the existing official-first retrieval and answer-verification
  policies.

## Selected Architecture

Use publisher-aware failover. A canonical source may be monitored without being
scheduled for ingestion, and it may name one or more already-registered
official fallback sources from the same publisher. Fallbacks remain independent
sources: they are indexed and cited under their own source IDs and URLs.

The Cardano Foundation homepage remains registered as the canonical monitored
source. The existing Cardano Foundation GitHub source becomes its explicit
machine-readable fallback. The official GitHub organization identifies itself
as Cardano Foundation and links back to the canonical website:
<https://github.com/cardano-foundation>.

Cardano Stack Exchange moves from its challenge-protected HTML homepage to the
official Stack Exchange API. The API documents `/questions` as the endpoint for
querying the site's question corpus:
<https://api.stackexchange.com/docs/questions>.

## Registry Contract

Extend `SourceRegistryEntry` with two optional fields:

```ts
type SourceRegistryEntry = {
  // existing fields
  ingestionMode?: "scheduled" | "monitor-only";
  liveFallbackIds?: string[];
};
```

Omission means `scheduled`, preserving the behavior of every existing entry.
The validator continues rejecting unknown fields and additionally enforces:

- fallback IDs are non-empty, unique, registered, and not self-references;
- only a `monitor-only` source may declare fallbacks, and every fallback is a
  directly registered `scheduled` source, so fallback chains and cycles are
  rejected by construction;
- a fallback and its primary are both `official` and have the same normalized
  owner;
- `monitor-only` entries may be probed but are never scheduled or manually
  enqueued for ingestion;
- no fallback changes another source's ID, trust tier, canonical URL, or
  citation provenance.

Configuration changes:

- `cardano-foundation` keeps `https://cardanofoundation.org/`, uses
  `monitor-only`, and declares `cardano-foundation-github` as its fallback;
- `cardano-foundation-github` remains a scheduled official GitHub source;
- `cardano-stack-exchange` becomes a bounded Stack Exchange API source.

## Live Registry Gate

Every source probe produces one of these states:

- `healthy`: the source's own machine endpoint passed;
- `degraded-with-fallback`: the primary failed explicitly, but at least one
  declared official fallback passed;
- `failed`: the source and every declared fallback failed or the fallback
  relationship was invalid.

The command prints the primary failure even when the family is degraded, plus
the exact fallback source ID that passed. It exits non-zero when any required
official family is `failed`. A community-source failure remains visible but
does not invalidate official coverage or promote another community source.

This gate verifies reachability and fallback health; it does not claim that a
monitor-only page was ingested. The separate live RAG gate must still verify
retrieval, citations, freshness, answer properties, and official/community
resolution before public canary.

## Scheduling and Manual Refresh

`scheduleKnowledgeSources` filters out `monitor-only` entries. Manual
`--sync-source` rejects a monitor-only ID with a stable operator-facing error
and names no URL. The worker continues reloading and validating the registry for
every job, so a stale queued job becomes a safe failure if its source was
changed to monitor-only.

The fallback source follows its own existing refresh schedule. The scheduler
does not copy the primary's job or silently enqueue a fallback after a failure;
this prevents duplicate indexing and keeps retries attributable to the source
that actually failed.

## Stack Exchange Adapter

Add a specialized source kind and metadata rather than teaching the generic
crawler to trust arbitrary JSON links:

```ts
type StackExchangeSource = SourceRegistryEntry & {
  kind: "stackexchange";
  stackExchange: { site: "cardano" };
};
```

The adapter constructs requests internally against the fixed origin
`https://api.stackexchange.com` and API version `2.3`. Registry or Telegram
input cannot select another host, API path, or site. It fetches recent questions
ordered by activity with bounded pages and a filter that includes bodies, then
fetches bounded answer batches when present. Limits remain within the existing
500-document, 8-MiB response, 128-MiB aggregate, and 120-second operation caps.

Each accepted question or answer becomes an independent immutable document.
The adapter sanitizes returned HTML without executing it and validates IDs,
timestamps, titles, bodies, and optional profile links. It ignores returned post
links and constructs citation URLs from validated numeric IDs using the fixed
Cardano Stack Exchange question/answer URL shapes. API URLs are retrieval
provenance; constructed human URLs are document provenance. No returned URL is
recursively fetched.

Stack Exchange contributions require attribution under CC BY-SA. The API
question object exposes `owner`, `content_license`, and `link`; answer responses
do not consistently expose `link` under `filter=withbody`. The official
license page confirms that public contributions use versioned CC BY-SA terms:
<https://api.stackexchange.com/docs/types/question> and
<https://stackoverflow.com/help/licensing>. Each stored document therefore
retains the bounded author display name, validated author/profile link when
present, exact `content_license`, and post URL constructed from the validated
post ID. The rendered citation identifies
the post author and license; a deleted or absent owner is labelled explicitly
rather than invented. Attribution metadata is content provenance and must not
be sent to logs as an error payload.

The response wrapper's `backoff` value is mandatory. The official throttle
documentation requires clients to wait that many seconds before calling the
same method again and discourages identical calls more than once per minute:
<https://api.stackexchange.com/docs/throttle>. A backoff or exhausted quota
stores bounded fetch state, ends the current sync without replacing the last
valid version, and lets the next scheduled job resume later. The adapter does
not require a Stack Exchange access token for the bounded public read path.

## Managed LiteLLM Gate

Keep LiteLLM as the only model endpoint exposed to Vennek. OpenAI is the
required primary provider for the current 1,536-dimension embedding contract.
The checked-in static LiteLLM/Compose template declares all OpenAI, Anthropic,
and Gemini completion routes, so every provider key/model pair is a deployment
prerequisite for this template; partial pairs are invalid. These provider
credentials stay inside LiteLLM and are never passed to the evaluator or
persisted in reports. An OpenAI-only deployment requires a separate reviewed
removal of the unused static routes and Compose requirements; empty or
mismatched defaults are not safe. This corrects the earlier optional-fallback
assumption based on the rendered Compose evidence.

The live evaluator requires only what it directly consumes:

- `DATABASE_URL`;
- `LITELLM_BASE_URL`;
- `LITELLM_API_KEY`;
- `VENNEK_MODEL_FAST`;
- `VENNEK_MODEL_QUALITY`;
- `VENNEK_MODEL_VERIFIER`;
- `VENNEK_EMBEDDING_MODEL`.

`GITHUB_TOKEN` becomes optional. It remains available to the ingestion worker
for higher GitHub rate limits but cannot block evaluation of an already-built
index. The LiteLLM deployment still needs a real `OPENAI_API_KEY`; that secret
is an operator prerequisite, not a repository default. `.env.example` is a
shared Compose input and contains provider placeholders for LiteLLM;
`deploy/vennek.env.example` and Vennek service environments omit provider keys.

## Failure and Security Policy

- Challenges and rate limits are availability states, never evidence.
- A degraded family is reported on every live registry run; it is not rewritten
  as healthy.
- A fallback must pass the same HTTPS, DNS, redirect, MIME, size, timeout, and
  registry-scope controls as any primary source.
- Community failures cannot weaken required official coverage.
- Last valid immutable versions remain available after fetch, API, quota,
  extraction, embedding, or database failure.
- Logs and reports contain source IDs, status categories, and bounded timing,
  never response bodies, tokens, provider errors, questions, or credentials.
- The public factual-answer canary remains disabled until both live commands
  exit successfully in staging.

## Verification Strategy

Use red-green TDD for each behavioral change.

Registry tests cover optional-field validation, same-owner official fallbacks,
missing IDs, duplicates, self-reference, fallback-chain rejection, community
fallback rejection, and the Cardano Foundation configuration.

Worker tests prove monitor-only sources are neither scheduled nor manually
enqueued, stale queued monitor-only jobs fail before fetch, and scheduled
fallback sources retain their own singleton jobs.

Stack Exchange tests use bounded fake responses to cover question and answer
mapping, canonical citation links, HTML sanitization, pagination bounds,
oversized/malformed JSON, invalid IDs and profile links, ignored returned post
links, API error responses, quota,
`backoff`, cancellation, unchanged-version behavior, and retained author/license
attribution. SSRF tests prove no API response can redirect fetching to a
returned link or another site.

Evaluation tests prove `GITHUB_TOKEN` is optional, every real dependency remains
required, failure reports remain sanitized, and the live evaluator still fails
closed before retrieval when configuration is incomplete.

Release verification includes targeted suites, full tests, typecheck, build,
compiled imports, offline registry validation, offline RAG evaluation,
dependency audit, diff check, live registry validation, and credential-backed
live RAG evaluation. Correctness and security reviewers independently inspect
the finished implementation before the canary gate can be marked complete.

## Rollout and Rollback

Deploy the registry/adapter change with the public canary still disabled. Run a
full Cardano Foundation GitHub sync and a Stack Exchange API sync, then execute
both live gates. Record `degraded-with-fallback` for the homepage until the
publisher offers a stable machine endpoint or removes the challenge.

Rollback uses the previous immutable Vennek image and registry. Indexed source
versions are immutable; do not run destructive down-migrations. If the Stack
Exchange adapter fails, disable only that community entry and keep official
retrieval operational. If fallback validation fails, keep the public factual
path closed rather than weakening the registry.
