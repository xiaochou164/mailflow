ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS allowed_ips TEXT[],
  ADD COLUMN IF NOT EXISTS audit_retention_days INTEGER NOT NULL DEFAULT 90;

CREATE INDEX IF NOT EXISTS idx_applications_allowed_ips
  ON applications USING GIN(allowed_ips)
  WHERE revoked_at IS NULL AND allowed_ips IS NOT NULL;
