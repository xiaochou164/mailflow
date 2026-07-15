ALTER TABLE mcp_oauth_authorization_codes
  ADD COLUMN IF NOT EXISTS resource TEXT;

ALTER TABLE mcp_oauth_tokens
  ADD COLUMN IF NOT EXISTS resource TEXT;
