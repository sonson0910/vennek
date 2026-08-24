CREATE TABLE IF NOT EXISTS telegram_admission_windows (
  subject_type text NOT NULL CHECK (subject_type IN ('user', 'chat')),
  subject_id text NOT NULL,
  window_started_at timestamptz NOT NULL,
  accepted_count integer NOT NULL CHECK (accepted_count >= 0 AND accepted_count <= 10),
  PRIMARY KEY (subject_type, subject_id)
);
