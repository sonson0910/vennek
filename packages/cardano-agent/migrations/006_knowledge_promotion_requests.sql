CREATE TABLE knowledge_promotion_requests (
  request_id uuid PRIMARY KEY,
  caller_id text NOT NULL CHECK (caller_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  nonce_digest bytea NOT NULL UNIQUE CHECK (octet_length(nonce_digest) = 32),
  state text NOT NULL CHECK (state IN ('started', 'succeeded', 'failed')),
  outcome text CHECK (
    outcome IS NULL OR outcome IN (
      'promoted', 'no_match', 'busy', 'timeout', 'upstream_failed', 'invalid_authenticated_request'
    )
  ),
  promoted_count smallint NOT NULL DEFAULT 0 CHECK (promoted_count BETWEEN 0 AND 3),
  latency_ms integer CHECK (latency_ms BETWEEN 0 AND 3600000),
  received_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT knowledge_promotion_requests_state_fields_check CHECK (
    (state = 'started'
      AND outcome IS NULL
      AND promoted_count = 0
      AND latency_ms IS NULL
      AND completed_at IS NULL)
    OR
    (state = 'succeeded'
      AND outcome IS NOT NULL
      AND outcome IN ('promoted', 'no_match')
      AND latency_ms IS NOT NULL
      AND completed_at IS NOT NULL)
    OR
    (state = 'failed'
      AND outcome IS NOT NULL
      AND outcome IN ('busy', 'timeout', 'upstream_failed', 'invalid_authenticated_request')
      AND latency_ms IS NOT NULL
      AND completed_at IS NOT NULL)
  )
);

CREATE INDEX knowledge_promotion_requests_received_at_idx
  ON knowledge_promotion_requests (received_at);
