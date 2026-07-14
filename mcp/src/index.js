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

async function mailflowRequest(path, token) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
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
