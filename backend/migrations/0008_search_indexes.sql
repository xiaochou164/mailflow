-- no-transaction
--
-- Add pg_trgm extension for ILIKE trigram indexes, and replace the expression-based
-- full-text search index with a stored generated column.
--
-- The existing idx_messages_search GIN index evaluates to_tsvector() at query time
-- for every scanned row. The stored search_vector column computes the same tsvector
-- at write time so reads can use a plain column index without re-evaluating the
-- expression. Trigram indexes on the ILIKE columns speed up operator searches.
--
-- Must be idempotent (IF NOT EXISTS / IF EXISTS) because a crash between the SQL
-- and the schema_migrations INSERT will cause this migration to be retried.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE messages ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english',
      coalesce(subject, '') || ' ' ||
      coalesce(from_name, '') || ' ' ||
      coalesce(from_email, '') || ' ' ||
      coalesce(snippet, '')
    )
  ) STORED;

DROP INDEX CONCURRENTLY IF EXISTS idx_messages_search;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_search_vector
  ON messages USING GIN (search_vector);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_from_email_trgm
  ON messages USING GIN (from_email gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_from_name_trgm
  ON messages USING GIN (from_name gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_subject_trgm
  ON messages USING GIN (subject gin_trgm_ops);
