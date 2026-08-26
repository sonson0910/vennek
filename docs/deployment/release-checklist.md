# Public Cardano agent release checklist

## Safety and product scope

- [ ] Public Telegram natural-language path is enabled only behind authenticated webhooks and the worker.
- [ ] Foundation returns the explicit insufficient-evidence response for factual Cardano questions until the knowledge/RAG plan is complete.
- [ ] Approved official Cardano sources are ingested and evaluated before factual-answer canary.
- [ ] Wallet secrets are rejected before persistence/provider calls; no keys, signing, or transaction submission path exists.
- [ ] Financial information remains general and cited; no personalized buy/sell advice is enabled.
- [ ] Conversation history remains encrypted at rest, with the first-use retention notice and administrator-only deletion policy.

## Offline verification

```bash
npm ci
npm test -- --run
npm run typecheck
npm run build
npm run verify:imports
npm run validate:registry
npm run eval:cardano-rag
npm audit --audit-level=moderate
git diff --check
```

- [ ] Docker Compose renders with a sanitized environment file:

  ```bash
  docker compose --env-file .env.example config --quiet
  ```

- [ ] Docker image builds with the pinned Node runtime.
- [ ] Migration owner installs pg-boss and creates both queues.
- [ ] Application role cannot `CREATE` in `public` or `pgboss`.
- [ ] Application role cannot `CREATE` in the database or any schema; reprovisioning clears prior direct grants.
- [ ] Application role can perform required conversation DML, pg-boss send/work/schedule, and partition maintenance execution.
- [ ] Existing owner-only integration tests pass; credential-gated role tests are recorded as skipped when credentials are absent.
- [ ] The offline knowledge gates pass: registry coverage, grounded RAG
  evaluation (recall@10 at least 90%, citation precision at least 95%, and no
  official-override violation), and the no-credential full suite record.

## Staging deployment

- [ ] Encryption key is generated with `umask 077` and `openssl rand -base64 32`, stored outside the repository, and loaded without echoing.
- [ ] Owner and application database credentials are distinct; only the migration/provisioning services receive owner access.
- [ ] LiteLLM `ghcr.io/berriai/litellm:v1.98.0@sha256:20b5044b619055374061a6d5b7b08754cad75aeabbf82ddf4f69cc0cf80ddaf4` is Cosign-verified and its read-only config contains only environment references.
- [ ] Provider keys, LiteLLM master key, Telegram token, webhook secret, and database URLs come from a secret manager or mode-0600 file.
- [ ] PostgreSQL health, migration completion, role provisioning, webhook health, worker startup, and LiteLLM readiness are recorded.
- [ ] Telegram webhook is registered with HTTPS and `allowed_updates=["message"]`.
- [ ] One authorized staging message is queued, answered, persisted encrypted, and delivered.
- [ ] A wallet-secret message produces only the fixed safety warning and leaves no secret in PostgreSQL, pg-boss, logs, or provider payloads.
- [ ] A repeated Telegram `update_id` creates no duplicate job or answer.
- [ ] Partition maintenance succeeds as the app role while direct `CREATE TABLE` fails.
- [ ] `npm run validate:registry:live` passes for the staged official registry,
  with every source-specific failure recorded and investigated.
- [ ] `npm run eval:cardano-rag:live` passes the same retrieval, citation,
  freshness, and answer-property thresholds without replacing the approved
  offline baseline.
- [ ] At least one hourly (`0 * * * *`) and one daily (`15 2 * * *`) source
  synchronization cycle completes; unchanged content skips embedding and a
  failed refresh retains the previous valid indexed version.
- [ ] `sync-cardano-source-dead` is empty or has an owner, cause, remediation,
  and source-ID requeue record. Recovery uses `--sync-source <source-id>` and
  never replays an arbitrary dead-letter payload.
- [ ] An authenticated question that reaches empty/stale evidence exercises
  the internal question-only live-discovery path; no host port is exposed and
  unregistered results are not promoted.

## Rollout and monitoring

- [ ] Internal staging passes for at least one full source-sync/maintenance cycle.
- [ ] Canary expands only through internal operators, small public traffic,
  1,000 DAU, then 10,000 DAU; each stage has an owner, observation window, and
  recorded go/hold/rollback decision.
- [ ] Dashboards cover webhook p95, queue age/depth, provider errors/latency, Telegram failures, citation precision, retrieval recall@10, source freshness, and spend.
- [ ] Knowledge dashboards also cover source-sync success/failure and duration,
  `sync-cardano-source` age/depth/retries, dead-letter count, source-version
  freshness, retrieval-cache hit/miss, live-discovery outcome/latency, and
  embedding-index coverage by model.
- [ ] Expansion pauses automatically at p95 acknowledgement >500 ms, error rate >1%, citation precision <95%, recall@10 <90%, critical-source staleness, or budget ceiling.

## Rollback and key/role operations

- [ ] Previous verified application image and Compose environment are available.
- [ ] `VENNEK_IMAGE_TAG` points to one immutable release tag shared by migration,
  both role-provisioning jobs, webhook, both workers, and both extractor services.
- [ ] Application rollback is rehearsed without destructive database down-migrations.
- [ ] Embedding-model rollback is rehearsed from a verified database backup (or
  by rebuilding every source with the previous model) before factual answers
  reopen; the current schema does not retain parallel old-model chunks.
- [ ] Backup restore is rehearsed into an explicitly named isolated database.
- [ ] Application-role password rotation is rehearsed; owner credentials remain separate.
- [ ] Encryption-key loss consequence is documented: retained history cannot be decrypted.
- [ ] Incident response names the operator who can disable the webhook, stop workers, rotate secrets, and preserve sanitized logs.
- [ ] Kill switch is tested: `docker compose --env-file /secure/vennek.env
  stop knowledge-worker` disables scheduled sync and live discovery while the
  agent continues using already indexed evidence or returns insufficient
  evidence. Re-enable only after the incident is understood.

## Release record

- Version/tag:
- Commit SHA:
- Verification output:
- Credential-gated checks not run:
- Known limitations:
- Rollback owner and command:
  `VENNEK_IMAGE_TAG=2026-08-24-abc1234 docker compose --env-file /secure/path/vennek.env up -d --no-build --force-recreate migrate provision-app-role provision-knowledge-role telegram-webhook agent-worker knowledge-worker pdf-extractor private-document-extractor`
