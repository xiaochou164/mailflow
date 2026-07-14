import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { query, withTransaction } from './db.js';

export const MCP_OAUTH_SCOPES = Object.freeze([
  'email.search',
  'email.read',
  'email.thread',
  'ai.summarize',
]);

const CHATGPT_TOOL_PERMISSIONS = Object.freeze([
  'account.read',
  'email.search',
  'email.read',
  'email.thread',
  'ai.summarize',
]);

const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CODE_TTL_MS = 10 * 60 * 1000;
const TOKEN_PREFIX = 'mf_oat_';
const REFRESH_PREFIX = 'mf_ort_';

function token(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

function hash(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

function safeEqualHex(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

function normalizeScopes(scope) {
  const requested = String(scope || '')
    .split(/\s+/)
    .map(item => item.trim())
    .filter(Boolean);
  const clean = [...new Set(requested.filter(item => MCP_OAUTH_SCOPES.includes(item)))];
  return clean.length ? clean : [...MCP_OAUTH_SCOPES];
}

function scopeString(scopes) {
  return normalizeScopes(scopes.join ? scopes.join(' ') : scopes).join(' ');
}

function normalizeRedirectUris(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map(uri => typeof uri === 'string' ? uri.trim() : '')
    .filter(Boolean)
    .slice(0, 20))];
}

function publicOrigin() {
  return (process.env.MCP_PUBLIC_ORIGIN || process.env.APP_URL || '').replace(/\/+$/, '');
}

export function resourceUrl(req) {
  const origin = publicOrigin() || `${req.protocol}://${req.get('host')}`;
  return `${origin}/mcp`;
}

export function issuerUrl(req) {
  return publicOrigin() || `${req.protocol}://${req.get('host')}`;
}

export function protectedResourceMetadata(req) {
  const issuer = issuerUrl(req);
  return {
    resource: `${issuer}/mcp`,
    authorization_servers: [issuer],
    scopes_supported: MCP_OAUTH_SCOPES,
    bearer_methods_supported: ['header'],
  };
}

export function authorizationServerMetadata(req) {
  const issuer = issuerUrl(req);
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: MCP_OAUTH_SCOPES,
  };
}

export async function registerOAuthClient(payload = {}) {
  const clientId = `mf_oauth_${token(18)}`;
  const clientName = String(payload.client_name || payload.clientName || 'ChatGPT').slice(0, 120);
  const redirectUris = normalizeRedirectUris(payload.redirect_uris || payload.redirectUris);
  const grantTypes = Array.isArray(payload.grant_types) && payload.grant_types.length
    ? payload.grant_types
    : ['authorization_code', 'refresh_token'];
  const responseTypes = Array.isArray(payload.response_types) && payload.response_types.length
    ? payload.response_types
    : ['code'];
  const scope = scopeString(payload.scope || MCP_OAUTH_SCOPES.join(' '));

  await query(`
    INSERT INTO mcp_oauth_clients (
      client_id, client_name, redirect_uris, grant_types, response_types, scope
    )
    VALUES ($1, $2, $3::text[], $4::text[], $5::text[], $6)
  `, [clientId, clientName, redirectUris, grantTypes, responseTypes, scope]);

  return {
    client_id: clientId,
    client_name: clientName,
    redirect_uris: redirectUris,
    grant_types: grantTypes,
    response_types: responseTypes,
    token_endpoint_auth_method: 'none',
    scope,
  };
}

export async function getClient(clientId) {
  if (!clientId) return null;
  const result = await query('SELECT * FROM mcp_oauth_clients WHERE client_id = $1', [clientId]);
  return result.rows[0] || null;
}

export function validateAuthorizeRequest(params) {
  if (params.response_type !== 'code') return 'response_type must be code';
  if (!params.client_id) return 'client_id is required';
  if (!params.redirect_uri) return 'redirect_uri is required';
  if (!params.code_challenge) return 'code_challenge is required';
  if (params.code_challenge_method !== 'S256') return 'code_challenge_method must be S256';
  return null;
}

export async function ensureChatGptApplication(userId) {
  const existing = await query(`
    SELECT id, permissions
    FROM applications
    WHERE user_id = $1
      AND name = 'ChatGPT MCP'
      AND revoked_at IS NULL
    ORDER BY created_at ASC
    LIMIT 1
  `, [userId]);
  if (existing.rows.length) {
    const permissions = new Set(existing.rows[0].permissions || []);
    let changed = false;
    for (const permission of CHATGPT_TOOL_PERMISSIONS) {
      if (!permissions.has(permission)) {
        permissions.add(permission);
        changed = true;
      }
    }
    if (changed) {
      await query('UPDATE applications SET permissions = $1::text[], updated_at = NOW() WHERE id = $2', [
        [...permissions],
        existing.rows[0].id,
      ]);
    }
    return existing.rows[0].id;
  }

  const created = await query(`
    INSERT INTO applications (
      user_id, name, description, permissions, redact_content
    )
    VALUES ($1, 'ChatGPT MCP', 'OAuth adapter application for ChatGPT custom MCP access.', $2::text[], true)
    RETURNING id
  `, [userId, CHATGPT_TOOL_PERMISSIONS]);
  return created.rows[0].id;
}

export async function createAuthorizationCode({
  clientId,
  userId,
  redirectUri,
  scope,
  codeChallenge,
  codeChallengeMethod,
}) {
  const client = await getClient(clientId);
  if (!client) throw Object.assign(new Error('Unknown OAuth client'), { status: 400 });
  const allowedRedirects = client.redirect_uris || [];
  if (allowedRedirects.length && !allowedRedirects.includes(redirectUri)) {
    throw Object.assign(new Error('redirect_uri is not registered for this client'), { status: 400 });
  }
  const applicationId = await ensureChatGptApplication(userId);
  const code = `mf_code_${token(32)}`;
  const scopes = scopeString(scope || client.scope || MCP_OAUTH_SCOPES.join(' '));
  await query(`
    INSERT INTO mcp_oauth_authorization_codes (
      code_hash, client_id, user_id, application_id, redirect_uri, scope,
      code_challenge, code_challenge_method, expires_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  `, [
    hash(code),
    clientId,
    userId,
    applicationId,
    redirectUri,
    scopes,
    codeChallenge,
    codeChallengeMethod,
    new Date(Date.now() + CODE_TTL_MS),
  ]);
  return { code, scope: scopes };
}

function pkceHash(verifier) {
  return createHash('sha256').update(verifier).digest('base64url');
}

async function issueTokens(client, row, scope) {
  const accessToken = `${TOKEN_PREFIX}${token(32)}`;
  const refreshToken = `${REFRESH_PREFIX}${token(32)}`;
  const now = Date.now();
  const accessExpires = new Date(now + ACCESS_TOKEN_TTL_MS);
  const refreshExpires = new Date(now + REFRESH_TOKEN_TTL_MS);
  const scopes = scopeString(scope || row.scope || client.scope || MCP_OAUTH_SCOPES.join(' '));

  await query(`
    INSERT INTO mcp_oauth_tokens (
      access_token_hash, refresh_token_hash, client_id, user_id, application_id,
      scope, access_expires_at, refresh_expires_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  `, [
    hash(accessToken),
    hash(refreshToken),
    client.client_id,
    row.user_id,
    row.application_id,
    scopes,
    accessExpires,
    refreshExpires,
  ]);

  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    refresh_token: refreshToken,
    scope: scopes,
  };
}

export async function exchangeAuthorizationCode({ clientId, code, redirectUri, codeVerifier }) {
  const client = await getClient(clientId);
  if (!client) throw Object.assign(new Error('invalid_client'), { status: 400, oauthError: 'invalid_client' });
  const codeHash = hash(code);

  const row = await withTransaction(async db => {
    const result = await db.query(`
      SELECT *
      FROM mcp_oauth_authorization_codes
      WHERE code_hash = $1
        AND client_id = $2
      FOR UPDATE
    `, [codeHash, clientId]);
    const found = result.rows[0];
    if (!found) return null;
    if (found.consumed_at || new Date(found.expires_at).getTime() <= Date.now()) return null;
    if (found.redirect_uri !== redirectUri) return null;
    const expected = hash(found.code_challenge);
    const supplied = hash(pkceHash(codeVerifier || ''));
    if (!safeEqualHex(expected, supplied)) return null;
    await db.query('UPDATE mcp_oauth_authorization_codes SET consumed_at = NOW() WHERE code_hash = $1', [codeHash]);
    return found;
  });

  if (!row) throw Object.assign(new Error('invalid_grant'), { status: 400, oauthError: 'invalid_grant' });
  return issueTokens(client, row, row.scope);
}

export async function refreshAccessToken({ clientId, refreshToken, scope }) {
  const client = await getClient(clientId);
  if (!client) throw Object.assign(new Error('invalid_client'), { status: 400, oauthError: 'invalid_client' });
  const refreshHash = hash(refreshToken);

  const row = await withTransaction(async db => {
    const result = await db.query(`
      SELECT *
      FROM mcp_oauth_tokens
      WHERE refresh_token_hash = $1
        AND client_id = $2
      FOR UPDATE
    `, [refreshHash, clientId]);
    const found = result.rows[0];
    if (!found) return null;
    if (found.revoked_at || new Date(found.refresh_expires_at).getTime() <= Date.now()) return null;
    await db.query('UPDATE mcp_oauth_tokens SET revoked_at = NOW() WHERE id = $1', [found.id]);
    return found;
  });

  if (!row) throw Object.assign(new Error('invalid_grant'), { status: 400, oauthError: 'invalid_grant' });
  return issueTokens(client, row, scope || row.scope);
}

export async function revokeOAuthToken(tokenValue) {
  if (!tokenValue) return;
  const tokenHash = hash(tokenValue);
  await query(`
    UPDATE mcp_oauth_tokens
    SET revoked_at = NOW()
    WHERE access_token_hash = $1 OR refresh_token_hash = $1
  `, [tokenHash]);
}

export async function authenticateOAuthAccessToken(tokenValue) {
  if (typeof tokenValue !== 'string' || !tokenValue.startsWith(TOKEN_PREFIX)) return null;
  const result = await query(`
    SELECT
      t.id AS token_id, t.scope, t.access_expires_at,
      a.id, a.user_id, a.name, a.permissions, a.account_ids, a.folders,
      a.allowed_ips, a.audit_retention_days, a.redact_content
    FROM mcp_oauth_tokens t
    JOIN applications a ON a.id = t.application_id
    WHERE t.access_token_hash = $1
      AND t.revoked_at IS NULL
      AND t.access_expires_at > NOW()
      AND a.revoked_at IS NULL
    LIMIT 1
  `, [hash(tokenValue)]);
  const row = result.rows[0];
  if (!row) return null;
  await query('UPDATE mcp_oauth_tokens SET last_used_at = NOW() WHERE id = $1', [row.token_id]);
  const tokenScopes = normalizeScopes(row.scope);
  const effective = (row.permissions || []).filter(permission => {
    if (permission === 'account.read') return true;
    return tokenScopes.includes(permission);
  });
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    permissions: effective,
    accountIds: row.account_ids || [],
    folders: row.folders || [],
    allowedIps: row.allowed_ips || [],
    auditRetentionDays: row.audit_retention_days ?? 90,
    redactContent: row.redact_content === true,
    oauth: true,
    scopes: tokenScopes,
  };
}
