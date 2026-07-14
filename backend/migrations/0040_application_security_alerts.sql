CREATE TABLE IF NOT EXISTS application_security_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'medium',
  message TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}',
  acknowledged_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_application_security_alerts_app_created
  ON application_security_alerts(application_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_application_security_alerts_user_created
  ON application_security_alerts(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_application_security_alerts_open
  ON application_security_alerts(user_id, created_at DESC)
  WHERE acknowledged_at IS NULL;
