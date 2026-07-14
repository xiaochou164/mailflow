import { decrypt } from './encryption.js';
import { query } from './db.js';

const THREAD_PROMPT_LIMIT = 18_000;
const MESSAGE_BODY_LIMIT = 3_500;
const DIGEST_PROMPT_LIMIT = 16_000;
const INSIGHT_SCHEMA = Object.freeze({
  summary: '',
  replySuggestions: [],
  labels: [],
  tasks: [],
  dates: [],
  risks: [],
  important: false,
  importanceReason: '',
  needsReply: false,
  needsReplyReason: '',
  contacts: [],
});

function addressList(addresses) {
  if (!Array.isArray(addresses) || !addresses.length) return '';
  return addresses
    .map(item => item?.email ? `${item.name || ''} <${item.email}>`.trim() : String(item || ''))
    .filter(Boolean)
    .join(', ')
    .slice(0, 500);
}

function attachmentList(attachments) {
  if (!Array.isArray(attachments) || !attachments.length) return '';
  return attachments
    .slice(0, 10)
    .map(item => item.filename || item.name || item.part || 'attachment')
    .join(', ')
    .slice(0, 500);
}

function textForEmail(email) {
  const text = email.text || email.snippet || '';
  return String(text).replace(/\s+/g, ' ').trim().slice(0, MESSAGE_BODY_LIMIT);
}

export function buildThreadSummaryPrompt(emails) {
  const parts = [
    'Summarize this email thread for a busy user.',
    'Focus on decisions, requests, deadlines, risks, open questions, and who owes the next action.',
    'Return concise Markdown with these sections: Summary, Key points, Action items, Risks or blockers.',
    '',
  ];
  let remaining = THREAD_PROMPT_LIMIT;
  for (const [index, email] of emails.entries()) {
    const block = [
      `Message ${index + 1}`,
      `Date: ${email.date || ''}`,
      `From: ${email.from?.name || ''} <${email.from?.email || ''}>`,
      `To: ${addressList(email.to)}`,
      email.cc?.length ? `Cc: ${addressList(email.cc)}` : '',
      `Subject: ${email.subject || '(no subject)'}`,
      email.attachments?.length ? `Attachments: ${attachmentList(email.attachments)}` : '',
      '',
      textForEmail(email),
      '',
      '---',
      '',
    ].filter(line => line !== '').join('\n');
    if (remaining - block.length <= 0) break;
    parts.push(block);
    remaining -= block.length;
  }
  return parts.join('\n').slice(0, THREAD_PROMPT_LIMIT);
}

export function buildThreadInsightsPrompt(emails) {
  return [
    'Analyze this email thread for an AI-native email workspace.',
    'Return only valid JSON with this exact shape:',
    JSON.stringify(INSIGHT_SCHEMA),
    'Rules: replySuggestions are short draftable reply ideas; labels are useful mailbox tags; tasks include owner, task, dueDate if known; dates include date and meaning; risks include severity and reason; contacts include email and relationship/context. Do not invent facts.',
    '',
    buildThreadSummaryPrompt(emails),
  ].join('\n').slice(0, THREAD_PROMPT_LIMIT + 1_500);
}

function digestDateRange(dateValue) {
  const raw = String(dateValue || new Date().toISOString().slice(0, 10)).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw Object.assign(new Error('Digest date must use YYYY-MM-DD'), { status: 400 });
  }
  const start = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime())) {
    throw Object.assign(new Error('Invalid digest date'), { status: 400 });
  }
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return {
    date: raw,
    start: start.toISOString(),
    end: end.toISOString(),
    nextDate: end.toISOString().slice(0, 10),
  };
}

export function buildDailyDigestSearchQuery(dateValue, { allFolders = true } = {}) {
  const range = digestDateRange(dateValue);
  return {
    ...range,
    query: `after:${range.date} before:${range.nextDate}${allFolders ? ' in:all' : ''}`,
  };
}

export function buildDailyDigestPrompt(emails, dateValue) {
  const { date } = digestDateRange(dateValue);
  const parts = [
    `Create a daily email digest for ${date}.`,
    'Return concise Markdown with these sections: Executive summary, Important emails, Needs reply, Deadlines and tasks, FYI.',
    'Use only the provided email metadata and snippets. Do not invent details. Group similar messages where useful.',
    '',
  ];
  let remaining = DIGEST_PROMPT_LIMIT;
  for (const [index, email] of emails.entries()) {
    const isRead = email.isRead ?? email.is_read;
    const isStarred = email.isStarred ?? email.is_starred;
    const hasAttachments = email.hasAttachments ?? email.has_attachments;
    const block = [
      `Email ${index + 1}`,
      `Date: ${email.date || ''}`,
      `Account: ${email.accountName || email.account_name || ''}`,
      `Folder: ${email.folder || ''}`,
      `From: ${email.from?.name || email.from_name || ''} <${email.from?.email || email.from_email || ''}>`,
      `Subject: ${email.subject || '(no subject)'}`,
      `Read: ${isRead ? 'yes' : 'no'}`,
      `Starred: ${isStarred ? 'yes' : 'no'}`,
      hasAttachments ? 'Has attachments: yes' : '',
      '',
      textForEmail(email),
      '',
      '---',
      '',
    ].filter(line => line !== '').join('\n');
    if (remaining - block.length <= 0) break;
    parts.push(block);
    remaining -= block.length;
  }
  return parts.join('\n').slice(0, DIGEST_PROMPT_LIMIT);
}

function markdownEscape(value) {
  return String(value || '')
    .replace(/\0/g, '')
    .replace(/\r\n/g, '\n')
    .trim();
}

export function exportThreadMarkdown(emails, threadId = '') {
  if (!Array.isArray(emails) || emails.length === 0) {
    throw Object.assign(new Error('Thread has no emails to export'), { status: 404 });
  }
  const first = emails[0] || {};
  const subject = markdownEscape(first.subject || '(no subject)');
  const participants = [...new Set(emails.flatMap(email => [
    email.from?.email,
    ...(Array.isArray(email.to) ? email.to.map(item => item?.email).filter(Boolean) : []),
  ]).filter(Boolean))];
  const lines = [
    '---',
    `mailflow_thread_id: "${markdownEscape(threadId || first.threadId || '')}"`,
    `subject: "${subject.replaceAll('"', '\\"')}"`,
    `message_count: ${emails.length}`,
    `participants: [${participants.map(item => `"${String(item).replaceAll('"', '\\"')}"`).join(', ')}]`,
    '---',
    '',
    `# ${subject}`,
    '',
    '## Messages',
    '',
  ];
  for (const [index, email] of emails.entries()) {
    lines.push(
      `### ${index + 1}. ${markdownEscape(email.from?.name || email.from?.email || 'Unknown sender')}`,
      '',
      `- Date: ${markdownEscape(email.date)}`,
      `- From: ${markdownEscape(email.from?.name || '')} <${markdownEscape(email.from?.email || '')}>`,
      `- To: ${addressList(email.to) || '-'}`,
      email.cc?.length ? `- Cc: ${addressList(email.cc)}` : '',
      `- Folder: ${markdownEscape(email.folder || '')}`,
      email.attachments?.length ? `- Attachments: ${attachmentList(email.attachments)}` : '',
      '',
      markdownEscape(email.text || email.snippet || ''),
      ''
    );
  }
  return lines.filter(line => line !== '').join('\n').slice(0, 200_000);
}

function cleanSummary(value) {
  return String(value || '')
    .replace(/\0/g, '')
    .trim()
    .slice(0, 12_000);
}

async function loadSummaryProvider() {
  const cfgResult = await query("SELECT value FROM system_settings WHERE key = 'ai_config'").catch(() => null);
  if (!cfgResult?.rows?.length) {
    throw Object.assign(new Error('AI provider not configured'), { status: 503 });
  }
  let cfg;
  try { cfg = JSON.parse(cfgResult.rows[0].value); } catch {
    throw Object.assign(new Error('Corrupted AI config'), { status: 500 });
  }
  if (!cfg.enabled) throw Object.assign(new Error('AI features are disabled'), { status: 503 });
  if (cfg.features && cfg.features.summarize === false) {
    throw Object.assign(new Error('AI summarization is disabled'), { status: 503 });
  }
  if (!cfg.baseUrl || !cfg.model) {
    throw Object.assign(new Error('AI provider not fully configured'), { status: 503 });
  }
  return {
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    apiKey: cfg.apiKey ? decrypt(cfg.apiKey) : null,
  };
}

async function runProviderPrompt(prompt, maxTokens) {
  const provider = await loadSummaryProvider();
  const headers = { 'Content-Type': 'application/json' };
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;

  let response;
  try {
    // Trust boundary: intentionally plain fetch, matching /api/ai/chat. The admin
    // validates and owns this provider URL, which may legitimately be private.
    response = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: provider.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens,
        stream: false,
        think: false,
      }),
      signal: AbortSignal.timeout(90_000),
    });
  } catch (err) {
    throw Object.assign(new Error(`AI request failed: ${err.message}`), { status: 502 });
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw Object.assign(new Error(`AI provider error (${response.status}): ${errText.slice(0, 300)}`), { status: 502 });
  }
  const data = await response.json().catch(() => ({}));
  return String(data.choices?.[0]?.message?.content || '');
}

function normalizeArray(value, limit) {
  return Array.isArray(value) ? value.slice(0, limit) : [];
}

function parseInsightsJson(content) {
  const raw = String(content || '').trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  const jsonText = start >= 0 && end > start ? raw.slice(start, end + 1) : raw;
  let parsed;
  try { parsed = JSON.parse(jsonText); } catch {
    throw Object.assign(new Error('AI provider returned invalid insight JSON'), { status: 502 });
  }
  return {
    summary: cleanSummary(parsed.summary).slice(0, 4_000),
    replySuggestions: normalizeArray(parsed.replySuggestions, 5),
    labels: normalizeArray(parsed.labels, 10),
    tasks: normalizeArray(parsed.tasks, 20),
    dates: normalizeArray(parsed.dates, 20),
    risks: normalizeArray(parsed.risks, 20),
    important: parsed.important === true,
    importanceReason: cleanSummary(parsed.importanceReason).slice(0, 1_000),
    needsReply: parsed.needsReply === true,
    needsReplyReason: cleanSummary(parsed.needsReplyReason).slice(0, 1_000),
    contacts: normalizeArray(parsed.contacts, 20),
  };
}

export async function summarizeThreadEmails(emails) {
  if (!Array.isArray(emails) || emails.length === 0) {
    throw Object.assign(new Error('Thread has no emails to summarize'), { status: 404 });
  }
  const summary = cleanSummary(await runProviderPrompt(buildThreadSummaryPrompt(emails), 900));
  if (!summary) throw Object.assign(new Error('AI provider returned an empty summary'), { status: 502 });
  return {
    summary,
    messageCount: emails.length,
  };
}

export async function summarizeDailyDigestEmails(emails, dateValue) {
  const { date } = digestDateRange(dateValue);
  if (!Array.isArray(emails)) {
    throw Object.assign(new Error('Digest emails must be an array'), { status: 400 });
  }
  if (!emails.length) {
    return {
      date,
      summary: `## Executive summary\n\nNo matching emails were found for ${date}.`,
      emailCount: 0,
    };
  }
  const summary = cleanSummary(await runProviderPrompt(buildDailyDigestPrompt(emails, date), 1_100));
  if (!summary) throw Object.assign(new Error('AI provider returned an empty digest'), { status: 502 });
  return {
    date,
    summary,
    emailCount: emails.length,
  };
}

export async function analyzeThreadEmails(emails) {
  if (!Array.isArray(emails) || emails.length === 0) {
    throw Object.assign(new Error('Thread has no emails to analyze'), { status: 404 });
  }
  const insights = parseInsightsJson(await runProviderPrompt(buildThreadInsightsPrompt(emails), 1_500));
  return {
    insights,
    messageCount: emails.length,
  };
}
