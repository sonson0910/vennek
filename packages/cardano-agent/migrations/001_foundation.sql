CREATE TABLE IF NOT EXISTS schema_migrations (
  filename text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS telegram_users (
  telegram_user_id text PRIMARY KEY,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conversation_messages (
  id bigint GENERATED ALWAYS AS IDENTITY,
  telegram_user_id text NOT NULL REFERENCES telegram_users(telegram_user_id) ON DELETE CASCADE,
  telegram_chat_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  ciphertext text NOT NULL,
  iv text NOT NULL,
  auth_tag text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE INDEX IF NOT EXISTS conversation_messages_user_created_idx
  ON conversation_messages (telegram_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS conversation_summaries (
  telegram_user_id text PRIMARY KEY REFERENCES telegram_users(telegram_user_id) ON DELETE CASCADE,
  ciphertext text NOT NULL,
  iv text NOT NULL,
  auth_tag text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS telegram_updates (
  update_id bigint PRIMARY KEY,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  status text NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'processed', 'failed'))
);

CREATE TABLE IF NOT EXISTS usage_ledger (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  telegram_user_id text REFERENCES telegram_users(telegram_user_id) ON DELETE SET NULL,
  model text NOT NULL,
  prompt_tokens integer NOT NULL CHECK (prompt_tokens >= 0),
  completion_tokens integer NOT NULL CHECK (completion_tokens >= 0),
  latency_ms integer NOT NULL CHECK (latency_ms >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE
  month_start date := date_trunc('month', current_date)::date;
  partition_start date;
  partition_name text;
  month_offset integer;
BEGIN
  FOR month_offset IN -1..1 LOOP
    partition_start := (month_start + make_interval(months => month_offset))::date;
    partition_name := format(
      'conversation_messages_%s',
      to_char(partition_start, 'YYYY_MM')
    );
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF conversation_messages FOR VALUES FROM (DATE %L) TO (DATE %L)',
      partition_name,
      partition_start,
      (partition_start + interval '1 month')::date
    );
  END LOOP;
END $$;
