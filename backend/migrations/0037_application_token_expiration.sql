ALTER TABLE application_credentials
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_application_credentials_expires_at
  ON application_credentials(expires_at)
  WHERE revoked_at IS NULL AND expires_at IS NOT NULL;
