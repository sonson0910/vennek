ALTER TABLE conversation_message_idempotency
  ADD COLUMN IF NOT EXISTS message_id bigint;
