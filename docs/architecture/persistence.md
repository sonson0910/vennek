# Persistence architecture

Production conversation history lives in PostgreSQL and is encrypted with the 32-byte `VENNEK_ENCRYPTION_KEY`. The migration owner applies sorted SQL migrations and installs pg-boss; webhook and worker containers use only the restricted application database URL. Monthly conversation partitions are maintained through the no-argument `SECURITY DEFINER public.ensure_conversation_partitions()` entrypoint, while deterministic date injection uses the owner-only `public.ensure_conversation_partitions_at(timestamptz)` function. The timestamp overload is a one-release rollback adapter that validates but ignores its argument.

The first interaction shows the retention notice. History is retained indefinitely until an administrator deletes it. Wallet secrets are rejected before any database or provider call. No provider receives encrypted history or database credentials.

For local development, use the public polling mode only after the database and LiteLLM gateway are available. For production deployment, follow [the Telegram runtime runbook](../deployment/telegram-runtime.md) and use Compose webhook/worker services.
