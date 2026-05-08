-- Add normalized_subject as a generated column for subject-based thread fallback.
-- Strips up to 3 levels of common reply/forward prefixes (Re:, FW:, AW:, etc.)
-- and lowercases the result. Used by computeThreadId when RFC 5322 In-Reply-To /
-- References headers are absent (e.g. Outlook RE:, webmail without threading headers).

ALTER TABLE messages ADD COLUMN IF NOT EXISTS normalized_subject TEXT GENERATED ALWAYS AS (
  lower(trim(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          coalesce(subject, ''),
          '^(re|fw|fwd|aw|sv|vs|tr|wg|ant|antw|ref|rif|ynt|odp|vb|atb)[[:space:]]*:[[:space:]]*',
          '', 'i'
        ),
        '^(re|fw|fwd|aw|sv|vs|tr|wg|ant|antw|ref|rif|ynt|odp|vb|atb)[[:space:]]*:[[:space:]]*',
        '', 'i'
      ),
      '^(re|fw|fwd|aw|sv|vs|tr|wg|ant|antw|ref|rif|ynt|odp|vb|atb)[[:space:]]*:[[:space:]]*',
      '', 'i'
    )
  ))
) STORED;

CREATE INDEX IF NOT EXISTS idx_messages_norm_subject
  ON messages(account_id, normalized_subject)
  WHERE is_deleted = false AND normalized_subject IS NOT NULL;
