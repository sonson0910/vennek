# Telegram transport architecture

The production Telegram path is an authenticated webhook that performs bounded admission and queues a `telegram-answer` pg-boss job. A separate worker reads the job, applies the natural-language safety boundary, retrieves approved Cardano evidence when available, writes encrypted conversation history, and delivers the response.

The webhook and worker require `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, the restricted `DATABASE_URL`, encryption key, LiteLLM settings, and model aliases. They do not use a chat allowlist. Local `--poll` remains available for development and routes through the same public boundary; it is not the production scaling path.

See [the runtime runbook](../deployment/telegram-runtime.md) for HTTPS registration, health checks, secret handling, staged rollout, and rollback.
