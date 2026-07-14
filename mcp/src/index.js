import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as z from 'zod/v4';

const PORT = Number(process.env.PORT) || 3001;
const API_BASE_URL = (process.env.MAILFLOW_API_BASE_URL || 'http://backend:3000/api/v1').replace(/\/+$/, '');

function bearerToken(req) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

async function mailflowRequest(path, token, options = {}) {
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

async function mailflowBinary(path, token) {
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

function toolError(err) {
  return {
    isError: true,
    content: [{ type: 'text', text: err.message || 'MailFlow request failed' }],
  };
}

function createServer(token) {
  const server = new McpServer({ name: 'mailflow-mcp', version: '0.1.0' });

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

const app = createMcpExpressApp();

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.post('/mcp', async (req, res) => {
  const token = bearerToken(req);
  if (!token?.startsWith('mf_sk_')) {
    res.setHeader('WWW-Authenticate', 'Bearer realm="MailFlow MCP"');
    return res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'A MailFlow application token is required' },
      id: null,
    });
  }

  try {
    await mailflowRequest('/application', token);
  } catch (err) {
    res.setHeader('WWW-Authenticate', 'Bearer realm="MailFlow MCP"');
    return res.status(err.status === 401 ? 401 : 502).json({
      jsonrpc: '2.0',
      error: {
        code: err.status === 401 ? -32001 : -32603,
        message: err.status === 401 ? 'Invalid or revoked MailFlow application token' : 'MailFlow API is unavailable',
      },
      id: null,
    });
  }

  const server = createServer(token);
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

app.listen(PORT, error => {
  if (error) {
    console.error('Failed to start MailFlow MCP:', error);
    process.exit(1);
  }
  console.log(`MailFlow MCP listening on port ${PORT}`);
});
