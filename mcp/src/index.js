import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { pathToFileURL } from 'node:url';
import * as z from 'zod/v4';

const PORT = Number(process.env.PORT) || 3001;
const API_BASE_URL = (process.env.MAILFLOW_API_BASE_URL || 'http://backend:3000/api/v1').replace(/\/+$/, '');
const PUBLIC_ORIGIN = (process.env.MCP_PUBLIC_ORIGIN || process.env.APP_URL || '').replace(/\/+$/, '');
const CHATGPT_TOOL_NAMES = new Set([
  'list_accounts',
  'search_email',
  'read_email',
  'read_thread',
  'daily_email_digest',
  'summarize_thread',
]);

function publicOrigin(req) {
  if (PUBLIC_ORIGIN) return PUBLIC_ORIGIN;
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  return `${proto}://${host}`;
}

function resourceMetadataUrl(req) {
  return `${publicOrigin(req)}/.well-known/oauth-protected-resource`;
}

export function bearerToken(req) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

export async function mailflowRequest(path, token, options = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(50_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `MailFlow API returned ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

export async function mailflowBinary(path, token) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const error = new Error(data.error || `MailFlow API returned ${response.status}`);
    error.status = response.status;
    throw error;
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 10 * 1024 * 1024) {
    throw new Error('Attachment is larger than the 10 MB MCP transfer limit');
  }
  const disposition = response.headers.get('content-disposition') || '';
  const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  return {
    bytes,
    contentType: response.headers.get('content-type') || 'application/octet-stream',
    filename: encodedName ? decodeURIComponent(encodedName) : 'attachment',
  };
}

export function toolError(err) {
  const result = {
    isError: true,
    content: [{ type: 'text', text: err.message || 'MailFlow request failed' }],
  };
  if (err.status === 401) {
    result._meta = {
      'mcp/www_authenticate': err.wwwAuthenticate || 'Bearer',
    };
  }
  return result;
}

export const TOOL_PERMISSIONS = Object.freeze({
  search_email: 'email.search',
  search_knowledge: 'email.search',
  contact_history: 'email.search',
  similar_emails: 'email.search',
  read_email: 'email.read',
  daily_email_digest: ['email.search', 'ai.summarize'],
  list_accounts: 'account.read',
  read_thread: 'email.thread',
  summarize_thread: ['email.thread', 'ai.summarize'],
  analyze_thread: ['email.thread', 'ai.summarize'],
  export_thread_markdown: 'email.thread',
  get_attachment: 'email.attachments',
  create_draft: 'email.draft',
  draft_reply: 'email.draft',
  send_email: 'email.send',
  reply_email: 'email.reply',
  forward_email: 'email.forward',
  set_email_read: 'email.modify',
  set_email_starred: 'email.modify',
  archive_email: 'email.modify',
  move_email: 'email.move',
  delete_email: 'email.delete',
  list_webhooks: 'webhook.manage',
  create_webhook: 'webhook.manage',
  update_webhook: 'webhook.manage',
  test_webhook: 'webhook.manage',
  list_webhook_deliveries: 'webhook.manage',
  delete_webhook: 'webhook.manage',
});

function toolSecurity(required) {
  const scopes = (Array.isArray(required) ? required : [required])
    .filter(permission => ['email.search', 'email.read', 'email.thread', 'ai.summarize'].includes(permission));
  return scopes.length ? [{ type: 'oauth2', scopes }] : undefined;
}

function withSecurity(name, config) {
  const schemes = toolSecurity(TOOL_PERMISSIONS[name]);
  if (!schemes) return config;
  return {
    ...config,
    securitySchemes: schemes,
    _meta: {
      ...(config._meta || {}),
      securitySchemes: schemes,
    },
  };
}

export function createServer(token, permissions, options = {}) {
  const server = new McpServer({ name: 'mailflow-mcp', version: '0.1.0' });
  const granted = new Set(permissions);
  const registerTool = server.registerTool.bind(server);
  server.registerTool = (name, ...args) => {
    if (options.chatgpt === true && !CHATGPT_TOOL_NAMES.has(name)) return undefined;
    const required = TOOL_PERMISSIONS[name];
    const requiredList = Array.isArray(required) ? required : [required];
    if (required && requiredList.some(permission => !granted.has(permission))) return undefined;
    if (args[0] && typeof args[0] === 'object') args[0] = withSecurity(name, args[0]);
    return registerTool(name, ...args);
  };

  server.registerTool('search_email', {
    title: 'Search email',
    description: 'Search email metadata and snippets across the user’s connected MailFlow accounts. Supports MailFlow operators such as from:, subject:, after:, before:, is:, has:, and in:all.',
    inputSchema: {
      query: z.string().min(2).max(500).describe('Keywords or a MailFlow search query'),
      account_id: z.string().uuid().optional().describe('Optional MailFlow account UUID'),
      folder: z.string().max(500).optional().describe('Optional exact folder path'),
      limit: z.number().int().min(1).max(50).default(20).describe('Maximum results'),
    },
  }, async ({ query, account_id, folder, limit }) => {
    try {
      const params = new URLSearchParams({ q: query, limit: String(limit) });
      if (account_id) params.set('accountId', account_id);
      if (folder) params.set('folder', folder);
      const data = await mailflowRequest(`/emails/search?${params}`, token);
      return {
        content: [{ type: 'text', text: JSON.stringify(data.emails || [], null, 2) }],
      };
    } catch (err) {
      return toolError(err);
    }
  });

  server.registerTool('read_email', {
    title: 'Read email',
    description: 'Read one MailFlow email by UUID, including its plain-text body, sanitized HTML, recipients, thread ID, and attachment metadata.',
    inputSchema: {
      id: z.string().uuid().describe('MailFlow email UUID returned by search_email'),
    },
  }, async ({ id }) => {
    try {
      const data = await mailflowRequest(`/emails/${encodeURIComponent(id)}`, token);
      return {
        content: [{ type: 'text', text: JSON.stringify(data.email, null, 2) }],
      };
    } catch (err) {
      return toolError(err);
    }
  });

  server.registerTool('search_knowledge', {
    title: 'Search email knowledge base',
    description: 'Search MailFlow as an email knowledge base using indexed subjects, senders, snippets, and cached body text.',
    inputSchema: {
      query: z.string().min(2).max(500).describe('Knowledge search query. Supports the same operators as search_email.'),
      account_id: z.string().uuid().optional(),
      folder: z.string().max(500).optional(),
      limit: z.number().int().min(1).max(100).default(20),
    },
  }, async ({ query, account_id, folder, limit }) => {
    try {
      const params = new URLSearchParams({ q: query, limit: String(limit) });
      if (account_id) params.set('accountId', account_id);
      if (folder) params.set('folder', folder);
      const data = await mailflowRequest(`/knowledge/search?${params}`, token);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return toolError(err);
    }
  });

  server.registerTool('contact_history', {
    title: 'Contact email history',
    description: 'Retrieve recent MailFlow email history with a contact, including messages from, to, or cc’ing that contact.',
    inputSchema: {
      email: z.string().email().describe('Contact email address'),
      limit: z.number().int().min(1).max(100).default(20),
    },
  }, async ({ email, limit }) => {
    try {
      const params = new URLSearchParams({ limit: String(limit) });
      const data = await mailflowRequest(`/contacts/${encodeURIComponent(email)}/history?${params}`, token);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return toolError(err);
    }
  });

  server.registerTool('similar_emails', {
    title: 'Find similar emails',
    description: 'Find emails related to a seed email by thread, sender, and subject/body search terms.',
    inputSchema: {
      email_id: z.string().uuid().describe('Seed MailFlow email UUID'),
      limit: z.number().int().min(1).max(50).default(10),
    },
  }, async ({ email_id, limit }) => {
    try {
      const params = new URLSearchParams({ limit: String(limit) });
      const data = await mailflowRequest(`/emails/${encodeURIComponent(email_id)}/similar?${params}`, token);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return toolError(err);
    }
  });

  server.registerTool('daily_email_digest', {
    title: 'Daily email digest',
    description: 'Create an AI-generated daily digest for a date using scoped MailFlow search results. Requires email.search and ai.summarize permissions.',
    inputSchema: {
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Digest date in YYYY-MM-DD, UTC day. Defaults to today.'),
      account_id: z.string().uuid().optional().describe('Optional account UUID, still constrained by application scope.'),
      folder: z.string().min(1).max(500).optional().describe('Optional exact folder path, still constrained by application scope.'),
      limit: z.number().int().min(1).max(200).default(100).describe('Maximum emails to include in the digest prompt.'),
    },
  }, async ({ date, account_id, folder, limit }) => {
    try {
      const body = { limit };
      if (date) body.date = date;
      if (account_id) body.accountId = account_id;
      if (folder) body.folder = folder;
      const data = await mailflowRequest('/emails/daily-digest', token, { method: 'POST', body });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return toolError(err);
    }
  });

  server.registerTool('list_accounts', {
    title: 'List email accounts',
    description: 'List connected MailFlow accounts and their folders.',
    inputSchema: {},
  }, async () => {
    try {
      const data = await mailflowRequest('/accounts', token);
      return { content: [{ type: 'text', text: JSON.stringify(data.accounts || [], null, 2) }] };
    } catch (err) {
      return toolError(err);
    }
  });

  server.registerTool('read_thread', {
    title: 'Read email thread',
    description: 'Read every available message in an email thread in chronological order.',
    inputSchema: {
      thread_id: z.string().min(1).max(500).describe('Thread ID returned by search_email or read_email'),
    },
  }, async ({ thread_id }) => {
    try {
      const data = await mailflowRequest(`/threads/${encodeURIComponent(thread_id)}`, token);
      return { content: [{ type: 'text', text: JSON.stringify(data.thread, null, 2) }] };
    } catch (err) {
      return toolError(err);
    }
  });

  server.registerTool('summarize_thread', {
    title: 'Summarize email thread',
    description: 'Summarize a complete email thread with the configured MailFlow AI provider. Requires both email.thread and ai.summarize permissions.',
    inputSchema: {
      thread_id: z.string().min(1).max(500).describe('Thread ID returned by search_email or read_email'),
    },
  }, async ({ thread_id }) => {
    try {
      const data = await mailflowRequest(`/threads/${encodeURIComponent(thread_id)}/summary`, token, { method: 'POST', body: {} });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return toolError(err);
    }
  });

  server.registerTool('analyze_thread', {
    title: 'Analyze email thread',
    description: 'Extract structured AI insights from a complete email thread: tasks, dates, risks, labels, importance, reply-needed state, and reply suggestions.',
    inputSchema: {
      thread_id: z.string().min(1).max(500).describe('Thread ID returned by search_email or read_email'),
    },
  }, async ({ thread_id }) => {
    try {
      const data = await mailflowRequest(`/threads/${encodeURIComponent(thread_id)}/insights`, token, { method: 'POST', body: {} });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return toolError(err);
    }
  });

  server.registerTool('export_thread_markdown', {
    title: 'Export thread Markdown',
    description: 'Export a complete email thread as Obsidian-friendly Markdown with front matter and message metadata.',
    inputSchema: {
      thread_id: z.string().min(1).max(500).describe('Thread ID returned by search_email or read_email'),
    },
  }, async ({ thread_id }) => {
    try {
      const data = await mailflowRequest(`/threads/${encodeURIComponent(thread_id)}/markdown`, token);
      return { content: [{ type: 'text', text: data.markdown || '' }] };
    } catch (err) {
      return toolError(err);
    }
  });

  server.registerTool('get_attachment', {
    title: 'Get email attachment',
    description: 'Fetch one attachment by email UUID and MIME part identifier. MCP transfers are limited to 10 MB.',
    inputSchema: {
      email_id: z.string().uuid().describe('MailFlow email UUID'),
      part: z.string().min(1).max(100).describe('Attachment MIME part identifier'),
    },
  }, async ({ email_id, part }) => {
    try {
      const attachment = await mailflowBinary(`/emails/${encodeURIComponent(email_id)}/attachments/${encodeURIComponent(part)}`, token);
      return {
        content: [
          { type: 'text', text: JSON.stringify({ filename: attachment.filename, contentType: attachment.contentType, size: attachment.bytes.length }) },
          {
            type: 'resource',
            resource: {
              uri: `mailflow://emails/${email_id}/attachments/${encodeURIComponent(part)}`,
              mimeType: attachment.contentType,
              blob: attachment.bytes.toString('base64'),
            },
          },
        ],
      };
    } catch (err) {
      return toolError(err);
    }
  });

  server.registerTool('create_draft', {
    title: 'Create email draft',
    description: 'Create a draft in an account Drafts folder without sending it.',
    inputSchema: {
      account_id: z.string().uuid(),
      to: z.array(z.string().email()).default([]),
      cc: z.array(z.string().email()).default([]),
      bcc: z.array(z.string().email()).default([]),
      subject: z.string().max(998).default(''),
      body: z.string().max(500_000).default(''),
      body_is_html: z.boolean().default(false),
    },
  }, async ({ account_id, to, cc, bcc, subject, body, body_is_html }) => {
    try {
      const data = await mailflowRequest('/drafts', token, {
        method: 'POST',
        body: { accountId: account_id, to, cc, bcc, subject, body, bodyIsHtml: body_is_html },
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return toolError(err);
    }
  });

  server.registerTool('draft_reply', {
    title: 'Draft email reply',
    description: 'Create a reply draft for an existing email. The message is not sent.',
    inputSchema: {
      email_id: z.string().uuid(),
      body: z.string().max(500_000),
      body_is_html: z.boolean().default(false),
      include_quoted: z.boolean().default(true),
    },
  }, async ({ email_id, body, body_is_html, include_quoted }) => {
    try {
      const data = await mailflowRequest(`/emails/${encodeURIComponent(email_id)}/draft-reply`, token, {
        method: 'POST',
        body: { body, bodyIsHtml: body_is_html, includeQuoted: include_quoted },
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return toolError(err);
    }
  });

  server.registerTool('send_email', {
    title: 'Send email',
    description: 'Send a new email immediately. Requires the explicit email.send permission.',
    inputSchema: {
      account_id: z.string().uuid(),
      to: z.array(z.string().email()).min(1),
      cc: z.array(z.string().email()).default([]),
      bcc: z.array(z.string().email()).default([]),
      subject: z.string().max(998).default(''),
      body: z.string().max(500_000),
      body_is_html: z.boolean().default(false),
    },
  }, async ({ account_id, to, cc, bcc, subject, body, body_is_html }) => {
    try {
      const data = await mailflowRequest('/send', token, {
        method: 'POST', body: { accountId: account_id, to, cc, bcc, subject, body, bodyIsHtml: body_is_html },
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (err) { return toolError(err); }
  });

  server.registerTool('reply_email', {
    title: 'Reply to email',
    description: 'Reply to an existing email immediately. Requires the explicit email.reply permission.',
    inputSchema: {
      email_id: z.string().uuid(),
      body: z.string().max(500_000),
      body_is_html: z.boolean().default(false),
      include_quoted: z.boolean().default(true),
    },
  }, async ({ email_id, body, body_is_html, include_quoted }) => {
    try {
      const data = await mailflowRequest(`/emails/${encodeURIComponent(email_id)}/reply`, token, {
        method: 'POST', body: { body, bodyIsHtml: body_is_html, includeQuoted: include_quoted },
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (err) { return toolError(err); }
  });

  server.registerTool('forward_email', {
    title: 'Forward email',
    description: 'Forward an existing email immediately, optionally including its attachments.',
    inputSchema: {
      email_id: z.string().uuid(),
      to: z.array(z.string().email()).min(1),
      cc: z.array(z.string().email()).default([]),
      bcc: z.array(z.string().email()).default([]),
      body: z.string().max(500_000).default(''),
      body_is_html: z.boolean().default(false),
      include_attachments: z.boolean().default(true),
    },
  }, async ({ email_id, to, cc, bcc, body, body_is_html, include_attachments }) => {
    try {
      const data = await mailflowRequest(`/emails/${encodeURIComponent(email_id)}/forward`, token, {
        method: 'POST', body: { to, cc, bcc, body, bodyIsHtml: body_is_html, includeAttachments: include_attachments },
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (err) { return toolError(err); }
  });

  server.registerTool('set_email_read', {
    title: 'Set email read state',
    description: 'Mark an email read or unread.',
    inputSchema: { email_id: z.string().uuid(), read: z.boolean() },
  }, async ({ email_id, read }) => {
    try {
      const data = await mailflowRequest(`/emails/${encodeURIComponent(email_id)}/read`, token, { method: 'PATCH', body: { read } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (err) { return toolError(err); }
  });

  server.registerTool('set_email_starred', {
    title: 'Set email starred state',
    description: 'Star or unstar an email.',
    inputSchema: { email_id: z.string().uuid(), starred: z.boolean() },
  }, async ({ email_id, starred }) => {
    try {
      const data = await mailflowRequest(`/emails/${encodeURIComponent(email_id)}/star`, token, { method: 'PATCH', body: { starred } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (err) { return toolError(err); }
  });

  server.registerTool('archive_email', {
    title: 'Archive email',
    description: 'Archive an email by moving its inbox copy to the configured archive folder.',
    inputSchema: { email_id: z.string().uuid() },
  }, async ({ email_id }) => {
    try {
      const data = await mailflowRequest(`/emails/${encodeURIComponent(email_id)}/archive`, token, { method: 'POST', body: {} });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (err) { return toolError(err); }
  });

  server.registerTool('move_email', {
    title: 'Move email',
    description: 'Move an email to another folder.',
    inputSchema: { email_id: z.string().uuid(), folder: z.string().min(1).max(500) },
  }, async ({ email_id, folder }) => {
    try {
      const data = await mailflowRequest(`/emails/${encodeURIComponent(email_id)}/move`, token, { method: 'POST', body: { folder } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (err) { return toolError(err); }
  });

  server.registerTool('delete_email', {
    title: 'Delete email',
    description: 'Delete an email according to the account delete policy. Requires explicit email.delete permission.',
    inputSchema: { email_id: z.string().uuid() },
  }, async ({ email_id }) => {
    try {
      const data = await mailflowRequest(`/emails/${encodeURIComponent(email_id)}`, token, { method: 'DELETE' });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (err) { return toolError(err); }
  });

  server.registerTool('list_webhooks', {
    title: 'List webhooks',
    description: 'List webhooks owned by this MailFlow application.',
    inputSchema: {},
  }, async () => {
    try {
      const data = await mailflowRequest('/webhooks', token);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (err) { return toolError(err); }
  });

  server.registerTool('create_webhook', {
    title: 'Create webhook',
    description: 'Create a signed webhook subscription. The signing secret is returned only once.',
    inputSchema: {
      name: z.string().min(1).max(100),
      url: z.string().url(),
      events: z.array(z.enum(['email.received', 'email.updated', 'email.sent', 'email.deleted', 'attachment.received'])).min(1),
    },
  }, async ({ name, url, events }) => {
    try {
      const data = await mailflowRequest('/webhooks', token, { method: 'POST', body: { name, url, events } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (err) { return toolError(err); }
  });

  server.registerTool('update_webhook', {
    title: 'Update webhook',
    description: 'Update a webhook subscription name, URL, event set, or enabled state.',
    inputSchema: {
      webhook_id: z.string().uuid(),
      name: z.string().min(1).max(100).optional(),
      url: z.string().url().optional(),
      events: z.array(z.enum(['email.received', 'email.updated', 'email.sent', 'email.deleted', 'attachment.received'])).min(1).optional(),
      enabled: z.boolean().optional(),
    },
  }, async ({ webhook_id, name, url, events, enabled }) => {
    try {
      const body = {};
      if (name !== undefined) body.name = name;
      if (url !== undefined) body.url = url;
      if (events !== undefined) body.events = events;
      if (enabled !== undefined) body.enabled = enabled;
      const data = await mailflowRequest(`/webhooks/${encodeURIComponent(webhook_id)}`, token, { method: 'PATCH', body });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (err) { return toolError(err); }
  });

  server.registerTool('test_webhook', {
    title: 'Test webhook',
    description: 'Queue a signed test delivery for a webhook.',
    inputSchema: { webhook_id: z.string().uuid() },
  }, async ({ webhook_id }) => {
    try {
      const data = await mailflowRequest(`/webhooks/${encodeURIComponent(webhook_id)}/test`, token, { method: 'POST', body: {} });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (err) { return toolError(err); }
  });

  server.registerTool('list_webhook_deliveries', {
    title: 'List webhook deliveries',
    description: 'Inspect recent webhook delivery status and retry attempts.',
    inputSchema: { webhook_id: z.string().uuid() },
  }, async ({ webhook_id }) => {
    try {
      const data = await mailflowRequest(`/webhooks/${encodeURIComponent(webhook_id)}/deliveries`, token);
      return { content: [{ type: 'text', text: JSON.stringify(data.deliveries || [], null, 2) }] };
    } catch (err) { return toolError(err); }
  });

  server.registerTool('delete_webhook', {
    title: 'Delete webhook',
    description: 'Delete a webhook and its delivery history.',
    inputSchema: { webhook_id: z.string().uuid() },
  }, async ({ webhook_id }) => {
    try {
      const data = await mailflowRequest(`/webhooks/${encodeURIComponent(webhook_id)}`, token, { method: 'DELETE' });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (err) { return toolError(err); }
  });

  return server;
}

export function createApp() {
  const app = createMcpExpressApp();

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  app.post('/mcp', async (req, res) => {
    const token = bearerToken(req);
    const isMfToken = token?.startsWith('mf_sk_');
    const isOAuthToken = token?.startsWith('mf_oat_');
    const wwwAuthenticate = `Bearer resource_metadata="${resourceMetadataUrl(req)}"`;
    if (!isMfToken && !isOAuthToken) {
      res.setHeader('WWW-Authenticate', wwwAuthenticate);
      return res.status(401).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'A MailFlow application or OAuth token is required' },
        id: null,
      });
    }

    try {
      const { application } = await mailflowRequest('/application', token);
      req.applicationPermissions = application.permissions || [];
    } catch (err) {
      res.setHeader('WWW-Authenticate', wwwAuthenticate);
      return res.status(err.status === 401 ? 401 : 502).json({
        jsonrpc: '2.0',
        error: {
          code: err.status === 401 ? -32001 : -32603,
          message: err.status === 401 ? 'Invalid or revoked MailFlow token' : 'MailFlow API is unavailable',
        },
        id: null,
      });
    }

    const server = createServer(token, req.applicationPermissions, { chatgpt: isOAuthToken });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('MCP request failed:', err.message);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  app.get('/mcp', (_req, res) => res.status(405).set('Allow', 'POST').send('Method Not Allowed'));
  app.delete('/mcp', (_req, res) => res.status(405).set('Allow', 'POST').send('Method Not Allowed'));

  return app;
}

export function start(port = PORT) {
  const app = createApp();
  return app.listen(port, error => {
    if (error) {
      console.error('Failed to start MailFlow MCP:', error);
      process.exit(1);
    }
    console.log(`MailFlow MCP listening on port ${port}`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start();
}
