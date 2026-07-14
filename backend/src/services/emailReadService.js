import sanitizeHtml from 'sanitize-html';
import { query } from './db.js';
import { sanitizeEmail } from './emailSanitizer.js';
import { snippetFromBody } from './messageParser.js';

const BODY_FETCH_TIMEOUT_MS = 40_000;

function sanitizeDbText(value) {
  return typeof value === 'string' ? value.replace(/\0/g, '') : value;
}

function parseJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function plainTextFromHtml(html) {
  if (!html) return null;
  return sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} })
    .replace(/\s+/g, ' ')
    .trim() || null;
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('BODY_FETCH_TIMEOUT')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function serializeEmail(message, bodySource) {
  const html = message.body_html || null;
  const text = message.body_text || plainTextFromHtml(html);
  return {
    id: message.id,
    threadId: message.thread_key,
    messageId: message.message_id,
    accountId: message.account_id,
    accountName: message.account_name,
    accountEmail: message.account_email,
    folder: message.folder,
    subject: message.subject || '',
    from: {
      name: message.from_name || '',
      email: message.from_email || '',
    },
    to: parseJson(message.to_addresses, []),
    cc: parseJson(message.cc_addresses, []),
    replyTo: parseJson(message.reply_to, []),
    date: message.date,
    snippet: message.snippet || '',
    isRead: !!message.is_read,
    isStarred: !!message.is_starred,
    text,
    html,
    attachments: parseJson(message.attachments, []),
    bodySource,
  };
}

export async function getEmailForApplication({ userId, messageId, imapManager, accountIds = [], folders = [] }) {
  const scopedAccountIds = Array.isArray(accountIds) && accountIds.length ? accountIds : null;
  const scopedFolders = Array.isArray(folders) && folders.length ? folders : null;
  const result = await query(`
    SELECT m.*, m.thread_key,
           a.name AS account_name, a.email_address AS account_email
    FROM messages m
    JOIN email_accounts a ON a.id = m.account_id
    WHERE m.id = $1
      AND a.user_id = $2
      AND m.is_deleted = false
      AND ($3::uuid[] IS NULL OR m.account_id = ANY($3::uuid[]))
      AND ($4::text[] IS NULL OR m.folder = ANY($4::text[]))
  `, [messageId, userId, scopedAccountIds, scopedFolders]);
  if (!result.rows.length) {
    throw Object.assign(new Error('Email not found'), { status: 404 });
  }

  const message = result.rows[0];
  if (message.body_html || message.body_text) return serializeEmail(message, 'cache');
  if (!imapManager) {
    throw Object.assign(new Error('Email body is not cached and IMAP is unavailable'), { status: 503 });
  }

  const accountResult = await query('SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2', [message.account_id, userId]);
  if (!accountResult.rows.length) {
    throw Object.assign(new Error('Email account not found'), { status: 404 });
  }

  try {
    const account = accountResult.rows[0];
    imapManager.noteUserActivity(account.id);
    const fetched = await withTimeout(
      imapManager.fetchMessageBody(account, message.uid, message.folder),
      BODY_FETCH_TIMEOUT_MS
    );
    const safeHtml = fetched.html ? sanitizeDbText(sanitizeEmail(fetched.html)) : null;
    const safeText = sanitizeDbText(fetched.text) || plainTextFromHtml(safeHtml);
    const attachments = fetched.attachments || [];
    const snippet = sanitizeDbText(snippetFromBody(safeText, safeHtml));

    if (safeHtml || safeText || attachments.length) {
      await query(`
        UPDATE messages
        SET body_html = $1,
            body_text = $2,
            attachments = $3,
            snippet = CASE WHEN $5 <> '' THEN $5 ELSE snippet END
        WHERE id = $4
      `, [safeHtml, safeText, JSON.stringify(attachments), message.id, snippet]);
    }

    return serializeEmail({
      ...message,
      body_html: safeHtml,
      body_text: safeText,
      attachments,
      snippet: snippet || message.snippet,
    }, 'imap');
  } catch (err) {
    if (err.message === 'BODY_FETCH_TIMEOUT') {
      throw Object.assign(new Error('Email body fetch timed out'), { status: 504 });
    }
    if (/THROTTL/i.test(err.message || '')) {
      throw Object.assign(new Error('The mail server is temporarily throttling access'), { status: 503 });
    }
    throw Object.assign(new Error('Failed to fetch email body'), { status: 502, cause: err });
  }
}
