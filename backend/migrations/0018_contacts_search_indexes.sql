-- Trigram indexes for fast ILIKE contact search on primary text columns.
-- The existing B-tree indexes on display_name and primary_email only support
-- equality/prefix lookups; these GIN trigram indexes support arbitrary ILIKE patterns.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS contacts_display_name_trgm
  ON contacts USING GIN (display_name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS contacts_primary_email_trgm
  ON contacts USING GIN (primary_email gin_trgm_ops);

CREATE INDEX IF NOT EXISTS contacts_organization_trgm
  ON contacts USING GIN (organization gin_trgm_ops);
