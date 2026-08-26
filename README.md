# Vennek

Vennek is the release candidate for a public, multilingual Cardano AI agent.
Telegram users can ask natural-language questions and receive same-language,
citation-grounded responses through a queued webhook/worker runtime, encrypted
PostgreSQL conversation history, a LiteLLM gateway, and the registry-backed
knowledge pipeline described in [Data Sources](docs/architecture/data-sources.md).

The factual path remains release-gated until every live check in the release
checklist passes. It answers only from approved evidence; when evidence is
missing, stale, or conflicting, it says so instead of guessing. It does not accept
wallet secrets, retain them, call a provider with them, sign transactions,
submit transactions, or give personalized buy/sell advice.

## Local verification

```bash
npm ci
npm test -- --run
npm run typecheck
npm run build
npm run verify:imports
npm run validate:registry
npm run eval:cardano-rag
npm audit --audit-level=moderate
```

## Docker staging

Copy `.env.example` to a mode-0600 deployment environment file, replace every placeholder, and follow [the Telegram runtime runbook](docs/deployment/telegram-runtime.md). Compose starts PostgreSQL, runs owner-only migrations and pg-boss queue provisioning, creates a restricted application role, then starts the LiteLLM gateway, webhook, and worker:

```bash
docker compose --env-file /secure/vennek.env up -d --build
docker compose --env-file /secure/vennek.env ps
```

The migration owner URL is used only by the one-shot migration/provisioning services. Webhook and worker receive only the application DML URL. Their pg-boss clients use `migrate: false` and `createSchema: false`; queues are created by the migration owner before runtime startup.

## Runtime modes

- `--webhook` acknowledges authenticated `POST /telegram/webhook` updates quickly and queues them.
- `--worker` consumes `telegram-answer` jobs and schedules daily partition maintenance.
- `--knowledge-worker` owns source synchronization and the authenticated,
  question-only live-discovery boundary.
- `--sync-source <source-id>` queues one exact registry source for an
  administrator-triggered refresh.
- `--poll` remains a local-development transport using the same public question boundary.
- `--health` performs the lightweight process health check without external credentials.

The knowledge worker refreshes sources hourly (`0 * * * *`) or daily at
`15 2 * * *` UTC according to the registry. Live discovery searches official
domains first and registered community domains only as a fallback; it accepts
only the authenticated question, promotes at most three registry-approved
sources, and never accepts an arbitrary URL from Telegram.

Register the webhook only after staging health checks and the knowledge release
gates pass. Use the [release checklist](docs/deployment/release-checklist.md)
for internal staging, canary, 1,000-DAU, and 10,000-DAU gates,
citation/retrieval thresholds, rollback, and incident handling.

## Safety contract

Responses must be grounded in approved source evidence once the knowledge plan is enabled, identify uncertainty, and keep citations. Address inspection is read-only on mainnet, preprod, and preview. Vennek never asks for seed phrases or private/signing keys and never builds, signs, or submits a Cardano transaction.
