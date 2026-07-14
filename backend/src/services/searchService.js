import { query } from './db.js';

export function parseSearchQuery(raw) {
  const filters = [];
  const terms = [];
  const opPattern = /(-?)\b(from|to|subject|has|is|after|before|in):("([^"]*)"|([\S]+))/gi;
  const remaining = raw.replace(opPattern, (_, neg, key, _v, quoted, unquoted) => {
    const k = key.toLowerCase();
    const v = (quoted !== undefined ? quoted : (unquoted || '')).toLowerCase().trim();
    if (v) filters.push({ key: k, value: v, negate: neg === '-' });
    return ' ';
  }).trim();

  for (const word of remaining.split(/\s+/)) {
    let value = word.trim();
    if (!value || value === '-') continue;
    let negate = false;
    if (value[0] === '-' && value.length > 1) {
      negate = true;
      value = value.slice(1);
    }
    terms.push({ value, negate });
  }
  return { filters, terms };
}

function negateCondition(sql) {
  return `NOT COALESCE((${sql}), false)`;
}

export function resolveSearchFolderScope(filters, folderParam = '') {
  let folderScope;
  let folderFuzzy = false;
  for (const filter of filters) {
    if (filter.key !== 'in') continue;
    if (filter.value === 'all') folderScope = null;
    else {
      folderScope = filter.value;
      folderFuzzy = true;
    }
  }
  if (folderScope === undefined) {
    folderScope = (folderParam || '').trim() || null;
    folderFuzzy = false;
  }
  return { folderScope, folderFuzzy };
}

export function shouldExcludeTrashFromSearch(folderScope) {
  return folderScope === null;
}

export function trashFolderExclusionCondition() {
  return `NOT EXISTS (
        SELECT 1
        FROM folders f
        WHERE f.account_id = m.account_id
          AND f.path = m.folder
          AND (f.special_use = '\\Trash'
               OR lower(f.name) LIKE '%trash%'
               OR lower(f.name) LIKE '%deleted%')
      )`;
}

export async function searchMessages({ userId, q, accountId, folder = '', limit = 50, offset = 0 }) {
  const trimmed = (q || '').trim();
  if (!trimmed) return { messages: [], query: q || '' };
  if (trimmed.length > 500) {
    throw Object.assign(new Error('Search query too long'), { status: 400 });
  }

  const accountsResult = await query(
    'SELECT id FROM email_accounts WHERE user_id = $1 AND enabled = true',
    [userId]
  );
  const userAccountIds = accountsResult.rows.map(row => row.id);
  if (!userAccountIds.length) return { messages: [], query: trimmed };

  const targetIds = accountId && userAccountIds.includes(accountId)
    ? [accountId]
    : userAccountIds;
  const cap = Math.max(1, Math.min(parseInt(limit) || 50, 200));
  const { filters, terms } = parseSearchQuery(trimmed);
  const conditions = [];
  const params = [targetIds];
  let parameter = 2;

  for (const filter of filters) {
    if (filter.key === 'in') continue;
    let condition = null;
    if (filter.key === 'from') {
      params.push(`%${filter.value}%`);
      condition = `(m.from_email ILIKE $${parameter} OR m.from_name ILIKE $${parameter})`;
      parameter++;
    } else if (filter.key === 'subject') {
      params.push(`%${filter.value}%`);
      condition = `m.subject ILIKE $${parameter++}`;
    } else if (filter.key === 'to') {
      params.push(`%${filter.value}%`);
      condition = `(m.to_addresses::text ILIKE $${parameter} OR m.cc_addresses::text ILIKE $${parameter})`;
      parameter++;
    } else if (filter.key === 'has') {
      if (filter.value === 'attachment' || filter.value === 'attachments') condition = 'm.has_attachments = true';
    } else if (filter.key === 'is') {
      if (filter.value === 'unread') condition = 'm.is_read = false';
      else if (filter.value === 'read') condition = 'm.is_read = true';
      else if (filter.value === 'starred') condition = 'm.is_starred = true';
    } else if (filter.key === 'after') {
      const date = new Date(filter.value);
      if (!isNaN(date)) {
        params.push(date.toISOString());
        condition = `m.date >= $${parameter++}`;
      }
    } else if (filter.key === 'before') {
      const date = new Date(filter.value);
      if (!isNaN(date)) {
        params.push(date.toISOString());
        condition = `m.date < $${parameter++}`;
      }
    }
    if (condition) conditions.push(filter.negate ? negateCondition(condition) : condition);
  }

  for (const term of terms.slice(0, 10)) {
    if (term.value.length < 2) continue;
    params.push(`%${term.value}%`);
    const likeParameter = parameter++;
    params.push(term.value);
    const fullTextParameter = parameter++;
    const condition = `(
        m.from_name ILIKE $${likeParameter}
        OR m.from_email ILIKE $${likeParameter}
        OR m.subject ILIKE $${likeParameter}
        OR m.search_vector @@ plainto_tsquery('english', $${fullTextParameter})
        OR to_tsvector('english', coalesce(m.body_text,'')) @@ plainto_tsquery('english', $${fullTextParameter})
      )`;
    conditions.push(term.negate ? negateCondition(condition) : condition);
  }

  if (!conditions.length) return { messages: [], query: trimmed };

  const { folderScope, folderFuzzy } = resolveSearchFolderScope(filters, folder);
  if (folderScope) {
    if (folderFuzzy) {
      params.push(folderScope, `%/${folderScope}`);
      conditions.push(`(m.folder ILIKE $${parameter} OR m.folder ILIKE $${parameter + 1})`);
      parameter += 2;
    } else {
      params.push(folderScope);
      conditions.push(`m.folder = $${parameter++}`);
    }
  } else if (shouldExcludeTrashFromSearch(folderScope)) {
    conditions.push(trashFolderExclusionCondition());
  }

  const safeOffset = Math.max(0, parseInt(offset) || 0);
  params.push(cap, safeOffset);
  const result = await query(`
    SELECT
      m.id, m.uid, m.folder, m.thread_key AS thread_id, m.subject,
      m.from_name, m.from_email, m.date, m.snippet, m.is_read, m.is_starred,
      m.has_attachments, m.account_id,
      a.name AS account_name, a.email_address AS account_email, a.color AS account_color
    FROM messages m
    JOIN email_accounts a ON m.account_id = a.id
    WHERE m.account_id = ANY($1)
      AND m.is_deleted = false
      AND ${conditions.join('\n      AND ')}
    ORDER BY m.date DESC
    LIMIT $${parameter} OFFSET $${parameter + 1}
  `, params);

  return { messages: result.rows, query: trimmed };
}
