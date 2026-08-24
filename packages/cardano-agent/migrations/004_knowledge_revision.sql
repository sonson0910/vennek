CREATE TABLE knowledge_revision (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  revision bigint NOT NULL CHECK (revision >= 0)
);

INSERT INTO knowledge_revision (id, revision)
VALUES (true, 0)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE source_versions
  ADD CONSTRAINT source_versions_title_length CHECK (char_length(title) <= 300) NOT VALID,
  ADD CONSTRAINT source_versions_canonical_url_length CHECK (char_length(canonical_url) <= 2048) NOT VALID;
