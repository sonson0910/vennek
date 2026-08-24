CREATE TABLE IF NOT EXISTS conversation_message_idempotency (
  telegram_update_id bigint NOT NULL,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  first_interaction boolean NOT NULL,
  PRIMARY KEY (telegram_update_id, role)
);
