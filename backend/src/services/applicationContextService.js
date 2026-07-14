import { query } from './db.js';
import { searchMessages } from './searchService.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function scopedArray(values) {
  return Array.isArray(values) && values.length ? values : null;
}

function clampLimit(value, fallback = 20, max = 100) {
  return Math.max(1, Math.min(parseInt(value) || fallback, max));
}

function normalizeEmail(email) {
  const clean = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(clean) || clean.length > 500) {
    throw Object.assign(new Error('Invalid contact email'), { status: 400 });
  }
  return clean;
}

function subjectTerms(subject) {
  const stop = new Set(['re', 'fw', 'fwd', 'the', 'and', 'for', 'with', 'from', 'this', 'that', 'your', 'you']);
  return [...new Set(String(subject || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .map(term => term.trim())
    .filter(term => term.length >= 3 && !stop.has(term)))]
    .slice(0, 8);
}

function serializeContextMessage(message) {
  return {
    id: message.id,
    threadId: message.thread_id || message.thread_key,
    accountId: message.account_id,
    accountName: message.account_name,
    folder: message.folder,
    subject: message.subject || '',
    from: {
      name: message.from_name || '',
      email: message.from_email || '',
    },
    date: message.date,
    snippet: message.snippet || '',
    isRead: !!message.is_read,
    isStarred: !!message.is_starred,
    hasAttachments: !!message.has_attachments,
  };
}

export async function searchKnowledgeForApplication({ userId, q, accountId, folder, limit, accountIds = [], folders = [] }) {
  const result = await searchMessages({
    userId,
    q,
    accountId,
    folder,
    limit: clampLimit(limit, 20, 100),
    offset: 0,
    accountIds,
    folders,
  });
  return {
    query: result.query,
    emails: result.messages.map(serializeContextMessage),
  };
}

export async function getContactHistoryForApplication({ userId, email, limit, accountIds = [], folders = [] }) {
  const contactEmail = normalizeEmail(email);
  const scopedAccountIds = scopedArray(accountIds);
  const scopedFolders = scopedArray(folders);
  const cap = clampLimit(limit, 20, 100);
  const result = await query(`
    SELECT
      m.id, m.uid, m.folder, m.thread_key AS thread_id, m.subject,
      m.from_name, m.from_email, m.date, m.snippet, m.is_read, m.is_starred,
      m.has_attachments, m.account_id,
      a.name AS account_name, a.email_address AS account_email, a.color AS account_color
    FROM messages m
    JOIN email_accounts a ON a.id = m.account_id
    WHERE a.user_id = $1
      AND a.enabled = true
      AND m.is_deleted = false
      AND ($2::uuid[] IS NULL OR m.account_id = ANY($2::uuid[]))
      AND ($3::text[] IS NULL OR m.folder = ANY($3::text[]))
      AND (
        lower(m.from_email) = $4
        OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(m.to_addresses, '[]'::jsonb)) AS addr
          WHERE lower(addr->>'email') = $4
        )
        OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(m.cc_addresses, '[]'::jsonb)) AS addr
          WHERE lower(addr->>'email') = $4
        )
      )
    ORDER BY m.date DESC
    LIMIT $5
  `, [userId, scopedAccountIds, scopedFolders, contactEmail, cap]);

  return {
    contact: { email: contactEmail },
    emails: result.rows.map(serializeContextMessage),
  };
}

export async function findSimilarEmailsForApplication({ userId, messageId, limit, accountIds = [], folders = [] }) {
  const scopedAccountIds = scopedArray(accountIds);
  const scopedFolders = scopedArray(folders);
  const seedResult = await query(`
    SELECT m.id, m.account_id, m.folder, m.thread_key, m.subject, m.from_email
    FROM messages m
    JOIN email_accounts a ON a.id = m.account_id
    WHERE m.id = $1
      AND a.user_id = $2
      AND a.enabled = true
      AND m.is_deleted = false
      AND ($3::uuid[] IS NULL OR m.account_id = ANY($3::uuid[]))
      AND ($4::text[] IS NULL OR m.folder = ANY($4::text[]))
    LIMIT 1
  `, [messageId, userId, scopedAccountIds, scopedFolders]);
  if (!seedResult.rows.length) {
    throw Object.assign(new Error('Email not found'), { status: 404 });
  }

  const seed = seedResult.rows[0];
  const terms = subjectTerms(seed.subject);
  const textQuery = terms.join(' ');
  const patterns = terms.map(term => `%${term}%`);
  const cap = clampLimit(limit, 10, 50);

  const result = await query(`
    SELECT
      m.id, m.uid, m.folder, m.thread_key AS thread_id, m.subject,
      m.from_name, m.from_email, m.date, m.snippet, m.is_read, m.is_starred,
      m.has_attachments, m.account_id,
      a.name AS account_name, a.email_address AS account_email, a.color AS account_color,
      (
        CASE WHEN m.thread_key = $5 THEN 4 ELSE 0 END
        + CASE WHEN lower(m.from_email) = lower($6) THEN 2 ELSE 0 END
        + CASE WHEN $7 <> '' AND m.search_vector @@ plainto_tsquery('english', $7) THEN 3 ELSE 0 END
        + CASE WHEN $8::text[] IS NOT NULL AND m.subject ILIKE ANY($8::text[]) THEN 1 ELSE 0 END
      ) AS similarity_score
    FROM messages m
    JOIN email_accounts a ON a.id = m.account_id
    WHERE a.user_id = $1
      AND a.enabled = true
      AND m.is_deleted = false
      AND m.id <> $2
      AND ($3::uuid[] IS NULL OR m.account_id = ANY($3::uuid[]))
      AND ($4::text[] IS NULL OR m.folder = ANY($4::text[]))
      AND (
        m.thread_key = $5
        OR lower(m.from_email) = lower($6)
        OR ($7 <> '' AND m.search_vector @@ plainto_tsquery('english', $7))
        OR ($8::text[] IS NOT NULL AND m.subject ILIKE ANY($8::text[]))
      )
    ORDER BY similarity_score DESC, m.date DESC
    LIMIT $9
  `, [userId, messageId, scopedAccountIds, scopedFolders, seed.thread_key, seed.from_email || '', textQuery, patterns.length ? patterns : null, cap]);

  return {
    seed: {
      id: seed.id,
      threadId: seed.thread_key,
      subject: seed.subject || '',
      fromEmail: seed.from_email || '',
    },
    emails: result.rows.map(row => ({
      ...serializeContextMessage(row),
      similarityScore: Number(row.similarity_score) || 0,
    })),
  };
}
