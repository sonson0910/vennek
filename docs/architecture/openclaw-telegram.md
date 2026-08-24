# Telegram transport architecture

The production Telegram path is an authenticated webhook that performs bounded admission and queues a `telegram-answer` pg-boss job. A separate worker reads the job, applies the natural-language safety boundary, retrieves approved Cardano evidence when available, writes encrypted conversation history, and delivers the response.

The public webhook receives only the restricted `DATABASE_URL` and `TELEGRAM_WEBHOOK_SECRET`. The worker receives that database URL plus `TELEGRAM_BOT_TOKEN`, the encryption key, LiteLLM settings, and model aliases; it does not receive the webhook secret. Neither service uses a chat allowlist. Local `--poll` remains available for development and routes through the same public boundary; it is not the production scaling path.

See [the runtime runbook](../deployment/telegram-runtime.md) for HTTPS registration, health checks, secret handling, staged rollout, and rollback.
