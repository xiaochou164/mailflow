ALTER TABLE application_credentials
  DROP CONSTRAINT IF EXISTS application_credentials_application_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_application_credentials_one_active
  ON application_credentials(application_id)
  WHERE revoked_at IS NULL;
