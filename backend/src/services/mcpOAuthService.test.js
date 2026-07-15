import { createHash } from 'crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
}));

const { query, withTransaction } = await import('./db.js');
const {
  authorizationServerMetadata,
  authenticateOAuthAccessToken,
  exchangeAuthorizationCode,
  protectedResourceMetadata,
  registerOAuthClient,
  refreshAccessToken,
  validateAuthorizeRequest,
} = await import('./mcpOAuthService.js');

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function pkceChallenge(verifier) {
  return createHash('sha256').update(verifier).digest('base64url');
}

beforeEach(() => {
  query.mockReset();
  withTransaction.mockReset();
  process.env.APP_URL = 'https://mail.example.test';
  delete process.env.MCP_PUBLIC_ORIGIN;
});

describe('mcpOAuthService metadata', () => {
  it('returns protected resource and authorization server metadata', () => {
    const req = { protocol: 'https', get: () => 'mail.example.test' };
    expect(protectedResourceMetadata(req)).toMatchObject({
      resource: 'https://mail.example.test/mcp',
      authorization_servers: ['https://mail.example.test'],
      scopes_supported: ['email.search', 'email.read', 'email.thread', 'ai.summarize'],
    });
    expect(authorizationServerMetadata(req)).toMatchObject({
      issuer: 'https://mail.example.test',
      authorization_endpoint: 'https://mail.example.test/oauth/authorize',
      token_endpoint: 'https://mail.example.test/oauth/token',
      registration_endpoint: 'https://mail.example.test/oauth/register',
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
    });
  });

  it('requires the OAuth resource parameter to match the MCP resource URL', () => {
    const base = {
      response_type: 'code',
      client_id: 'client-1',
      redirect_uri: 'https://chatgpt.com/connector/oauth/callback-id',
      code_challenge: 'challenge',
      code_challenge_method: 'S256',
    };

    expect(validateAuthorizeRequest(base, 'https://mail.example.test/mcp')).toBe('resource is required');
    expect(validateAuthorizeRequest({ ...base, resource: 'https://other.example/mcp' }, 'https://mail.example.test/mcp'))
      .toBe('resource must match the MailFlow MCP URL');
    expect(validateAuthorizeRequest({ ...base, resource: 'https://mail.example.test/mcp' }, 'https://mail.example.test/mcp'))
      .toBeNull();
  });
});

describe('mcpOAuthService clients and tokens', () => {
  it('registers a public OAuth client for DCR', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const client = await registerOAuthClient({
      client_name: 'ChatGPT',
      redirect_uris: ['https://chat.openai.com/aip/g-123/oauth/callback'],
      scope: 'email.search email.read unknown',
    });

    expect(client.client_id).toMatch(/^mf_oauth_/);
    expect(client.token_endpoint_auth_method).toBe('none');
    expect(client.scope).toBe('email.search email.read');
    expect(query.mock.calls[0][0]).toContain('INSERT INTO mcp_oauth_clients');
  });

  it('exchanges a PKCE authorization code for short-lived access and refresh tokens', async () => {
    const verifier = 'correct horse battery staple';
    const challenge = pkceChallenge(verifier);
    query
      .mockResolvedValueOnce({
        rows: [{
          client_id: 'client-1',
          scope: 'email.search email.read',
        }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const db = {
      query: vi.fn()
        .mockResolvedValueOnce({
          rows: [{
            code_hash: sha256('mf_code_test'),
            client_id: 'client-1',
            user_id: 'user-1',
            application_id: 'app-1',
            redirect_uri: 'https://chat.openai.com/callback',
            scope: 'email.search email.read',
            resource: 'https://mail.example.test/mcp',
            code_challenge: challenge,
            consumed_at: null,
            expires_at: new Date(Date.now() + 60_000),
          }],
        })
        .mockResolvedValueOnce({ rows: [] }),
    };
    withTransaction.mockImplementationOnce(fn => fn(db));

    const token = await exchangeAuthorizationCode({
      clientId: 'client-1',
      code: 'mf_code_test',
      redirectUri: 'https://chat.openai.com/callback',
      codeVerifier: verifier,
      resource: 'https://mail.example.test/mcp',
    });

    expect(token.access_token).toMatch(/^mf_oat_/);
    expect(token.refresh_token).toMatch(/^mf_ort_/);
    expect(token.expires_in).toBe(3600);
    expect(token.scope).toBe('email.search email.read');
    expect(db.query.mock.calls[1][0]).toContain('consumed_at = NOW()');
    expect(query.mock.calls[1][0]).toContain('INSERT INTO mcp_oauth_tokens');
  });

  it('refreshes by revoking the old refresh token and issuing a new pair', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ client_id: 'client-1', scope: 'email.search' }] })
      .mockResolvedValueOnce({ rows: [] });
    const db = {
      query: vi.fn()
        .mockResolvedValueOnce({
          rows: [{
            id: 'token-1',
            client_id: 'client-1',
            user_id: 'user-1',
            application_id: 'app-1',
            scope: 'email.search',
            resource: 'https://mail.example.test/mcp',
            revoked_at: null,
            refresh_expires_at: new Date(Date.now() + 60_000),
          }],
        })
        .mockResolvedValueOnce({ rows: [] }),
    };
    withTransaction.mockImplementationOnce(fn => fn(db));

    const token = await refreshAccessToken({
      clientId: 'client-1',
      refreshToken: 'mf_ort_old',
      resource: 'https://mail.example.test/mcp',
    });

    expect(token.access_token).toMatch(/^mf_oat_/);
    expect(token.refresh_token).toMatch(/^mf_ort_/);
    expect(db.query.mock.calls[1][0]).toContain('revoked_at = NOW()');
  });

  it('rejects refresh requests that try to expand the original scope', async () => {
    query.mockResolvedValueOnce({ rows: [{ client_id: 'client-1', scope: 'email.search' }] });
    const db = {
      query: vi.fn().mockResolvedValueOnce({
        rows: [{
          id: 'token-1',
          client_id: 'client-1',
          user_id: 'user-1',
          application_id: 'app-1',
          scope: 'email.search',
          resource: 'https://mail.example.test/mcp',
          revoked_at: null,
          refresh_expires_at: new Date(Date.now() + 60_000),
        }],
      }),
    };
    withTransaction.mockImplementationOnce(fn => fn(db));

    await expect(refreshAccessToken({
      clientId: 'client-1',
      refreshToken: 'mf_ort_old',
      resource: 'https://mail.example.test/mcp',
      scope: 'email.search email.read',
    })).rejects.toMatchObject({ oauthError: 'invalid_scope', status: 400 });
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it('maps a valid OAuth access token to application permissions and scopes', async () => {
    query
      .mockResolvedValueOnce({
        rows: [{
          token_id: 'token-1',
          scope: 'email.search email.thread',
          resource: 'https://mail.example.test/mcp',
          access_expires_at: new Date(Date.now() + 60_000),
          id: 'app-1',
          user_id: 'user-1',
          name: 'ChatGPT MCP',
          permissions: ['account.read', 'email.search', 'email.read', 'email.thread', 'ai.summarize'],
          account_ids: [],
          folders: [],
          allowed_ips: [],
          audit_retention_days: 90,
          redact_content: true,
        }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const app = await authenticateOAuthAccessToken('mf_oat_live');

    expect(app).toMatchObject({
      id: 'app-1',
      userId: 'user-1',
      permissions: ['account.read', 'email.search', 'email.thread'],
      oauth: true,
      scopes: ['email.search', 'email.thread'],
      redactContent: true,
    });
  });
});
