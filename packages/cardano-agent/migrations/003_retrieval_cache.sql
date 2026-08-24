CREATE TABLE retrieval_cache (
  query_hash text NOT NULL CHECK (query_hash ~ '^[0-9a-f]{64}$'),
  language text NOT NULL,
  filter_hash text NOT NULL CHECK (filter_hash ~ '^[0-9a-f]{64}$'),
  embedding_model text NOT NULL,
  source_version_fingerprint text NOT NULL CHECK (source_version_fingerprint ~ '^[0-9a-f]{64}$'),
  chunk_ids jsonb NOT NULL CHECK (jsonb_typeof(chunk_ids) = 'array' AND jsonb_array_length(chunk_ids) BETWEEN 1 AND 10),
  scores jsonb NOT NULL CHECK (jsonb_typeof(scores) = 'array' AND jsonb_array_length(scores) = jsonb_array_length(chunk_ids)),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (query_hash, language, filter_hash, embedding_model)
);

CREATE INDEX retrieval_cache_expiry_idx ON retrieval_cache (expires_at);
