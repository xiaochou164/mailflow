-- Store List-Unsubscribe header values so the frontend can surface a one-click
-- unsubscribe action without an extra IMAP round-trip on every message view.
-- NULL on the vast majority of messages (non-newsletter); populated only during
-- new-message sync when the header is present.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS list_unsubscribe TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS list_unsubscribe_post TEXT;
