CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE knowledge_sources (
  id text PRIMARY KEY,
  owner text NOT NULL,
  trust_tier text NOT NULL CHECK (trust_tier IN ('official', 'community', 'unverified')),
  registry jsonb NOT NULL,
  fetch_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_success_at timestamptz,
  last_error_code text
);

CREATE TABLE source_versions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id text NOT NULL REFERENCES knowledge_sources(id),
  canonical_url text NOT NULL,
  title text NOT NULL,
  content text NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  published_at timestamptz,
  retrieved_at timestamptz NOT NULL,
  UNIQUE (source_id, canonical_url, content_hash)
);

CREATE TABLE knowledge_chunks (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  version_id bigint NOT NULL REFERENCES source_versions(id) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  heading text NOT NULL,
  content text NOT NULL,
  content_hash text NOT NULL,
  embedding_model text NOT NULL,
  embedding vector(1536) NOT NULL,
  textsearch tsvector GENERATED ALWAYS AS (to_tsvector('simple', heading || ' ' || content)) STORED,
  UNIQUE (version_id, ordinal)
);

CREATE INDEX knowledge_chunks_textsearch_idx
  ON knowledge_chunks USING gin (textsearch);

CREATE INDEX knowledge_chunks_embedding_idx
  ON knowledge_chunks USING hnsw (embedding vector_cosine_ops);

CREATE INDEX source_versions_url_retrieved_idx
  ON source_versions (canonical_url, retrieved_at DESC);
