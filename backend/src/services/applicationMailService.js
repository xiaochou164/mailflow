import { query } from './db.js';
import { getEmailForApplication } from './emailReadService.js';

function parseJson(value, fallback = []) {
  if (value == null) return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

export async function listAccountsForApplication(userId, { accountIds = [], folders = [] } = {}) {
  const scopedAccountIds = Array.isArray(accountIds) && accountIds.length ? accountIds : null;
  const scopedFolders = Array.isArray(folders) && folders.length ? folders : null;
  const result = await query(`
    SELECT a.id, a.name, a.email_address, a.color, a.protocol, a.enabled,
           a.last_sync, a.sync_error,
           COALESCE(json_agg(json_build_object(
             'path', f.path, 'name', f.name, 'specialUse', f.special_use,
             'totalCount', f.total_count, 'unreadCount', f.unread_count
           ) ORDER BY f.name) FILTER (WHERE f.id IS NOT NULL), '[]') AS folders
    FROM email_accounts a
    LEFT JOIN folders f ON f.account_id = a.id
      AND ($3::text[] IS NULL OR f.path = ANY($3::text[]))
    WHERE a.user_id = $1 AND a.enabled = true
      AND ($2::uuid[] IS NULL OR a.id = ANY($2::uuid[]))
    GROUP BY a.id
    ORDER BY a.sort_order, a.created_at
  `, [userId, scopedAccountIds, scopedFolders]);
  return result.rows.map(row => ({
    id: row.id,
    name: row.name,
    emailAddress: row.email_address,
    color: row.color,
    protocol: row.protocol,
    enabled: row.enabled,
    lastSync: row.last_sync,
    syncError: row.sync_error,
    folders: parseJson(row.folders),
  }));
}

export async function getThreadForApplication({ userId, threadId, imapManager, accountIds = [], folders = [] }) {
  const scopedAccountIds = Array.isArray(accountIds) && accountIds.length ? accountIds : null;
  const scopedFolders = Array.isArray(folders) && folders.length ? folders : null;
  const result = await query(`
    WITH deduped AS (
      SELECT DISTINCT ON (m.message_id)
             m.id, m.message_id, m.date, m.folder
      FROM messages m
      JOIN email_accounts a ON a.id = m.account_id
      WHERE a.user_id = $1
        AND a.enabled = true
        AND m.is_deleted = false
        AND m.thread_key = $2
        AND ($3::uuid[] IS NULL OR m.account_id = ANY($3::uuid[]))
        AND ($4::text[] IS NULL OR m.folder = ANY($4::text[]))
      ORDER BY m.message_id,
               CASE WHEN m.folder = 'INBOX' THEN 0 ELSE 1 END,
               m.date ASC
    )
    SELECT id FROM deduped ORDER BY date ASC
    LIMIT 100
  `, [userId, threadId, scopedAccountIds, scopedFolders]);
  if (!result.rows.length) {
    throw Object.assign(new Error('Thread not found'), { status: 404 });
  }
  return Promise.all(result.rows.map(row => getEmailForApplication({
    userId,
    messageId: row.id,
    imapManager,
    accountIds,
    folders,
  })));
}

export async function getAttachmentForApplication({ userId, messageId, part, imapManager, accountIds = [], folders = [] }) {
  const scopedAccountIds = Array.isArray(accountIds) && accountIds.length ? accountIds : null;
  const scopedFolders = Array.isArray(folders) && folders.length ? folders : null;
  const result = await query(`
    SELECT m.uid, m.folder, m.attachments, m.account_id, a.*
    FROM messages m
    JOIN email_accounts a ON a.id = m.account_id
    WHERE m.id = $1 AND a.user_id = $2 AND m.is_deleted = false
      AND ($3::uuid[] IS NULL OR m.account_id = ANY($3::uuid[]))
      AND ($4::text[] IS NULL OR m.folder = ANY($4::text[]))
  `, [messageId, userId, scopedAccountIds, scopedFolders]);
  if (!result.rows.length) {
    throw Object.assign(new Error('Email not found'), { status: 404 });
  }
  const message = result.rows[0];
  const attachments = parseJson(message.attachments);
  const attachment = attachments.find(item => String(item.part ?? item.partId) === String(part));
  if (!attachment) {
    throw Object.assign(new Error('Attachment not found'), { status: 404 });
  }
  const maxBytes = 50 * 1024 * 1024;
  if (Number(attachment.size) > maxBytes) {
    throw Object.assign(new Error('Attachment exceeds the 50 MB limit'), { status: 413 });
  }
  if (!imapManager) {
    throw Object.assign(new Error('IMAP is unavailable'), { status: 503 });
  }
  const buffer = await imapManager.fetchAttachment(message, message.uid, message.folder, String(part));
  if (!buffer) {
    throw Object.assign(new Error('Could not fetch attachment'), { status: 502 });
  }
  return {
    buffer,
    filename: String(attachment.filename || 'attachment').replace(/[\r\n\\/]/g, '_').slice(0, 255),
    contentType: attachment.type || attachment.contentType || 'application/octet-stream',
    size: buffer.length,
  };
}
