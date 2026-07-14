CREATE TABLE IF NOT EXISTS mcp_oauth_clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id TEXT NOT NULL UNIQUE,
  client_name TEXT NOT NULL DEFAULT 'ChatGPT',
  redirect_uris TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  grant_types TEXT[] NOT NULL DEFAULT ARRAY['authorization_code', 'refresh_token']::TEXT[],
  response_types TEXT[] NOT NULL DEFAULT ARRAY['code']::TEXT[],
  scope TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mcp_oauth_authorization_codes (
  code_hash CHAR(64) PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES mcp_oauth_clients(client_id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT '',
  code_challenge TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL DEFAULT 'S256',
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mcp_oauth_codes_client
  ON mcp_oauth_authorization_codes(client_id, expires_at);

CREATE TABLE IF NOT EXISTS mcp_oauth_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  access_token_hash CHAR(64) NOT NULL UNIQUE,
  refresh_token_hash CHAR(64) NOT NULL UNIQUE,
  client_id TEXT NOT NULL REFERENCES mcp_oauth_clients(client_id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  scope TEXT NOT NULL DEFAULT '',
  access_expires_at TIMESTAMPTZ NOT NULL,
  refresh_expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_mcp_oauth_tokens_access_expires
  ON mcp_oauth_tokens(access_expires_at)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_mcp_oauth_tokens_refresh_expires
  ON mcp_oauth_tokens(refresh_expires_at)
  WHERE revoked_at IS NULL;
