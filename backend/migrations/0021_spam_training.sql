-- Antispam training infrastructure (v0.1)
--
-- Adds per-message columns for spam analysis results (filled by future ML and
-- SpamAssassin passes; this migration only adds the columns and constraints)
-- plus a training_log table that records every user-initiated mark-spam /
-- mark-ham action so future releases can train per-user models on it.
--
-- All columns are nullable / have defaults so existing rows remain valid.

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS spam_score_sa      FLOAT,
  ADD COLUMN IF NOT EXISTS spam_score_ml      FLOAT,
  ADD COLUMN IF NOT EXISTS spam_verdict       VARCHAR(20),
  ADD COLUMN IF NOT EXISTS spam_analyzed_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS spam_details       JSONB,
  ADD COLUMN IF NOT EXISTS spam_user_override VARCHAR(20);

-- Constrain verdict values; nullable so existing rows (and freshly inserted
-- messages before analysis) remain valid.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'messages_spam_verdict_check'
  ) THEN
    ALTER TABLE messages
      ADD CONSTRAINT messages_spam_verdict_check
      CHECK (spam_verdict IS NULL OR spam_verdict IN ('spam', 'ham', 'unsure', 'pending'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'messages_spam_user_override_check'
  ) THEN
    ALTER TABLE messages
      ADD CONSTRAINT messages_spam_user_override_check
      CHECK (spam_user_override IS NULL OR spam_user_override IN ('spam', 'ham'));
  END IF;
END $$;

-- Partial index — most messages will never be analyzed, so don't bloat the index.
CREATE INDEX IF NOT EXISTS idx_messages_spam_verdict
  ON messages(spam_verdict) WHERE spam_verdict IS NOT NULL;

-- Training log: one row per user-initiated spam/ham decision.
-- source='manual' for the v0.1 manual flow; future releases may add 'auto'
-- when ML/SA confidence exceeds a threshold and the message is auto-moved.
CREATE TABLE IF NOT EXISTS spam_training_log (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id        UUID REFERENCES email_accounts(id) ON DELETE SET NULL,
  message_id_header VARCHAR(500),
  message_uid       BIGINT,
  folder            VARCHAR(500),
  label             VARCHAR(10) NOT NULL,
  source            VARCHAR(20) NOT NULL DEFAULT 'manual',
  sa_score          FLOAT,
  ml_score          FLOAT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT spam_training_log_label_check  CHECK (label IN ('spam', 'ham')),
  CONSTRAINT spam_training_log_source_check CHECK (source IN ('manual', 'auto_sa', 'auto_ml', 'auto_combined'))
);

CREATE INDEX IF NOT EXISTS idx_spam_training_user
  ON spam_training_log(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_spam_training_label
  ON spam_training_log(user_id, label);

CREATE INDEX IF NOT EXISTS idx_spam_training_message
  ON spam_training_log(user_id, message_id_header)
  WHERE message_id_header IS NOT NULL;