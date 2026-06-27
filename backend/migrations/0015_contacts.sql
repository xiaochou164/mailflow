-- Auto-learned contacts: populated from sent recipients to rank autocomplete suggestions.
-- Addresses the user has explicitly sent to are surfaced above inbound-only senders.
CREATE TABLE IF NOT EXISTS contacts (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  name TEXT,
  send_count INT NOT NULL DEFAULT 0,
  last_sent TIMESTAMPTZ,
  UNIQUE(user_id, email)
);

CREATE INDEX IF NOT EXISTS idx_contacts_user_id ON contacts(user_id);
