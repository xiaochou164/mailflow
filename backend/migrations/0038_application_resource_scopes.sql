ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS account_ids UUID[],
  ADD COLUMN IF NOT EXISTS folders TEXT[];

CREATE INDEX IF NOT EXISTS idx_applications_account_scope
  ON applications USING GIN(account_ids)
  WHERE revoked_at IS NULL AND account_ids IS NOT NULL;
