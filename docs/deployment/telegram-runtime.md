# Public Telegram runtime

This runbook covers the foundation staging path. Keep the migration-owner credentials separate from the application role. The webhook and worker must never receive `DATABASE_OWNER_URL`.

## Secret setup

Create a mode-0600 environment file outside the repository. Generate the 32-byte encryption key without printing it:

```bash
umask 077
openssl rand -base64 32 > /secure/path/vennek-encryption-key
```

Load the key into `VENNEK_ENCRYPTION_KEY` through the deployment secret manager or a protected file loader. Never commit it, echo it, or put it in shell history. Set all values in `.env.example`; placeholders are not production credentials. Set `VENNEK_IMAGE` to the repository image and `VENNEK_IMAGE_TAG` to the immutable release tag. The migration service is the only Compose service that builds the repository image; provisioning, webhook, and worker all run that exact image reference.

## Compose staging

Verify the pinned LiteLLM image before deployment. The image package is listed at [GHCR](https://github.com/BerriAI/litellm/pkgs/container/litellm). With Sigstore Cosign installed, verify the pinned tag using the publishing workflow identity:

```bash
cosign verify \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp 'https://github.com/BerriAI/litellm/.github/workflows/.*' \
  ghcr.io/berriai/litellm:v1.98.0
```

Start the ordered stack with the protected environment file:

```bash
chmod 0600 /secure/path/vennek.env
docker compose --env-file /secure/path/vennek.env config --quiet
docker compose --env-file /secure/path/vennek.env up -d --build
docker compose --env-file /secure/path/vennek.env ps
```

The order is PostgreSQL health, owner migration plus pg-boss installation/queue creation, restricted application-role provisioning, then webhook/worker. The role-provisioning step grants application DML on the required public tables, pg-boss DML, and execution of the fixed partition-maintenance function; it grants no schema `CREATE` privilege.

## Migration and role rotation

Run these commands when operating outside Compose, using owner credentials only in the migration/provisioning process:

```bash
DATABASE_OWNER_URL='postgresql://…' npm run migrate:agent
DATABASE_OWNER_URL='postgresql://…' \
  VENNEK_APP_DB_USER=vennek_app \
  VENNEK_APP_DB_PASSWORD='…' \
  npm run provision:app-role
```

The migration owner installs/upgrades pg-boss and pre-creates `telegram-answer` and `conversation-partition-maintenance`. Runtime pg-boss constructors are deliberately `migrate: false, createSchema: false`.

To rotate the application password, provision the same validated role with a new password, update only the protected application URL, and restart webhook/worker. Do not print either URL or password. Rotate the owner credential separately through the PostgreSQL secret manager; do not give it to the app containers.

## Telegram webhook

Expose the webhook service behind an HTTPS reverse proxy at a stable URL. Set `TELEGRAM_WEBHOOK_SECRET` to at least 32 URL-safe characters. Register only the `message` update type after the service is healthy:

```bash
curl --fail-with-body --silent --show-error -X POST \
  -H 'content-type: application/json' \
  --data "{\"url\":\"${PUBLIC_WEBHOOK_URL}/telegram/webhook\",\"secret_token\":\"${TELEGRAM_WEBHOOK_SECRET}\",\"allowed_updates\":[\"message\"]}" \
  "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook"
```

Do not paste token assignments into a command or commit them. Check status without logging the token:

```bash
curl --fail-with-body --silent --show-error \
  "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo"
```

The webhook returns quickly after authentication, validates and bounds the update, and queues work. It does not answer synchronously. The worker owns provider calls, encrypted history writes, Telegram delivery, and daily partition maintenance.

## Health and monitoring

```bash
docker compose --env-file /secure/path/vennek.env ps
docker compose --env-file /secure/path/vennek.env logs --since=10m telegram-webhook agent-worker
```

Monitor webhook acknowledgement p95, queue depth/age, provider errors and latency, Telegram delivery failures, citation precision, retrieval recall@10, source freshness, and daily/monthly spend. Pause expansion if p95 acknowledgement exceeds 500 ms, errors exceed 1%, citation precision falls below 95%, retrieval recall@10 falls below 90%, a critical source is stale, or a budget ceiling is reached. Logs must not contain message text, wallet secrets, tokens, or database URLs.

## Rollback and staged rollout

Roll out internal staging first, then a small public canary, 1,000 DAU, and 10,000 DAU. Keep the last verified application image tag and Compose environment. To roll back application code, stop the current runtime and start the previous image tag; keep database migrations forward-compatible and do not run destructive down-migrations during an incident. Restore PostgreSQL only into an explicitly isolated database after verifying a backup.

Foundation staging intentionally refuses factual Cardano answers until the knowledge/RAG plan has ingested and evaluated the approved official sources. Do not open a public factual-answer canary before that gate and the independent security review pass.

To roll back to a previously verified immutable image, replace the example tag with the recorded release tag and recreate the four application services:

```bash
VENNEK_IMAGE_TAG=2026-08-24-abc1234 docker compose --env-file /secure/path/vennek.env up -d --no-build --force-recreate migrate provision-app-role telegram-webhook agent-worker
```
