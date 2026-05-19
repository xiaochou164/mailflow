-- no-transaction
--
-- Replace expression-based thread grouping with a stored generated column.
--
-- All three existing expression indexes use COALESCE(thread_id, id::text) and must
-- be rebuilt once mail.js references thread_key directly — expression indexes are
-- not used for simple column references, so keeping them after the column rename
-- would cause full scans on every threaded query.
--
-- A dedicated lookup index (account_id, thread_key) is also added to cover the
-- thread-expansion query (GET /thread/:threadId) which filters by a single key
-- without a folder constraint.
--
-- Must be idempotent (IF NOT EXISTS / IF EXISTS) because a crash between the SQL
-- and the schema_migrations INSERT will cause this migration to be retried.

ALTER TABLE messages ADD COLUMN IF NOT EXISTS thread_key TEXT
  GENERATED ALWAYS AS (COALESCE(thread_id, id::text)) STORED;

DROP INDEX CONCURRENTLY IF EXISTS idx_messages_thread_date;
DROP INDEX CONCURRENTLY IF EXISTS idx_messages_threaded_dedup;
DROP INDEX CONCURRENTLY IF EXISTS idx_messages_thread_count;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_thread_key
  ON messages(account_id, folder, thread_key, date DESC)
  WHERE is_deleted = false;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_threaded_dedup
  ON messages(account_id, folder, thread_key, message_id, date)
  WHERE is_deleted = false;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_thread_count
  ON messages(account_id, thread_key, message_id)
  WHERE is_deleted = false AND message_id IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_thread_key_lookup
  ON messages(account_id, thread_key)
  WHERE is_deleted = false;
