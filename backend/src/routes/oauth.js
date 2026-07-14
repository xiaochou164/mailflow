import { randomBytes } from 'crypto';
import { Router } from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { query, withTransaction } from '../services/db.js';
import { imapManager } from '../index.js';
import { encrypt, decrypt } from '../services/encryption.js';
import { redactEmail } from '../utils/redact.js';
import {
  authorizationServerMetadata,
  createAuthorizationCode,
  exchangeAuthorizationCode,
  protectedResourceMetadata,
  registerOAuthClient,
  revokeOAuthToken,
  refreshAccessToken,
  validateAuthorizeRequest,
} from '../services/mcpOAuthService.js';

// Cache JWKS fetchers per tenant — createRemoteJWKSet handles caching internally.
const jwksCache = new Map();
function getMsJwks(tenantId) {
  if (!jwksCache.has(tenantId)) {
    jwksCache.set(tenantId, createRemoteJWKSet(
      new URL(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`)
    ));
  }
  return jwksCache.get(tenantId);
}

const router = Router();

const MICROSOFT_AUTH_URL = 'https://login.microsoftonline.com';

function htmlPage(title, body) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title}</title>
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;background:#0f172a;color:#e5e7eb}
    main{max-width:560px;margin:12vh auto;padding:28px;border:1px solid #334155;border-radius:12px;background:#111827}
    h1{font-size:22px;margin:0 0 12px}
    p{line-height:1.6;color:#cbd5e1}
    code{background:#020617;padding:2px 5px;border-radius:4px}
    button,a.button{display:inline-block;border:0;border-radius:8px;background:#2563eb;color:white;padding:10px 14px;text-decoration:none;cursor:pointer;font-size:14px}
    .muted{color:#94a3b8;font-size:13px}
    ul{color:#cbd5e1;line-height:1.7}
  </style>
</head>
<body><main>${body}</main></body></html>`;
}

function redirectWithCode(res, redirectUri, code, state) {
  const target = new URL(redirectUri);
  target.searchParams.set('code', code);
  if (state) target.searchParams.set('state', state);
  res.redirect(target.toString());
}

function oauthError(res, status, error, description) {
  return res.status(status).json({
    error,
    ...(description ? { error_description: description } : {}),
  });
}

router.get('/.well-known/oauth-protected-resource', (req, res) => {
  res.json(protectedResourceMetadata(req));
});

router.get('/.well-known/oauth-authorization-server', (req, res) => {
  res.json(authorizationServerMetadata(req));
});

router.get('/authorize', async (req, res) => {
  const validationError = validateAuthorizeRequest(req.query);
  if (validationError) return res.status(400).send(htmlPage('OAuth 参数错误', `<h1>OAuth 参数错误</h1><p>${validationError}</p>`));
  if (!req.session?.userId) {
    const returnTo = encodeURIComponent(`${req.originalUrl}`);
    return res.status(401).send(htmlPage(
      '需要登录 MailFlow',
      `<h1>需要登录 MailFlow</h1>
       <p>请先在当前浏览器登录 MailFlow，然后重新从 ChatGPT 发起连接。</p>
       <p class="muted">授权请求：<code>${returnTo}</code></p>
       <a class="button" href="/">打开 MailFlow 登录页</a>`
    ));
  }

  const scope = String(req.query.scope || '').trim() || 'email.search email.read email.thread ai.summarize';
  if (req.query.approve === '1') {
    try {
      const { code } = await createAuthorizationCode({
        clientId: req.query.client_id,
        userId: req.session.userId,
        redirectUri: req.query.redirect_uri,
        scope,
        codeChallenge: req.query.code_challenge,
        codeChallengeMethod: req.query.code_challenge_method,
      });
      return redirectWithCode(res, req.query.redirect_uri, code, req.query.state);
    } catch (err) {
      return res.status(err.status || 500).send(htmlPage('授权失败', `<h1>授权失败</h1><p>${err.message}</p>`));
    }
  }

  const params = new URLSearchParams(req.query);
  params.set('approve', '1');
  res.send(htmlPage(
    '授权 ChatGPT 访问 MailFlow',
    `<h1>授权 ChatGPT 访问 MailFlow</h1>
     <p>ChatGPT 请求通过 MailFlow MCP 读取你的邮件数据。第一阶段只开放只读和 AI 摘要能力，不开放发送、转发或删除。</p>
     <ul>
       <li>搜索邮件：<code>email.search</code></li>
       <li>读取邮件：<code>email.read</code></li>
       <li>读取线程：<code>email.thread</code></li>
       <li>AI 摘要：<code>ai.summarize</code></li>
     </ul>
     <form method="get" action="/oauth/authorize">
       ${[...params].map(([key, value]) => `<input type="hidden" name="${key}" value="${String(value).replaceAll('"', '&quot;')}">`).join('')}
       <button type="submit">授权 ChatGPT</button>
     </form>
     <p class="muted">授权后可在开发者应用中撤销 ChatGPT MCP 应用。</p>`
  ));
});

router.post('/register', async (req, res) => {
  const client = await registerOAuthClient(req.body || {});
  res.status(201).json(client);
});

router.post('/token', async (req, res) => {
  const body = req.body || {};
  try {
    if (body.grant_type === 'authorization_code') {
      const token = await exchangeAuthorizationCode({
        clientId: body.client_id,
        code: body.code,
        redirectUri: body.redirect_uri,
        codeVerifier: body.code_verifier,
      });
      return res.json(token);
    }
    if (body.grant_type === 'refresh_token') {
      const token = await refreshAccessToken({
        clientId: body.client_id,
        refreshToken: body.refresh_token,
        scope: body.scope,
      });
      return res.json(token);
    }
    return oauthError(res, 400, 'unsupported_grant_type');
  } catch (err) {
    return oauthError(res, err.status || 500, err.oauthError || 'server_error', err.message);
  }
});

router.post('/revoke', async (req, res) => {
  await revokeOAuthToken(req.body?.token);
  res.status(200).json({});
});

// In-memory store for pending device code flows — keyed by userId.
// Device codes expire in 15 minutes so no persistence is needed.
const deviceFlows = new Map();

function getMsConfig() {
  return {
    clientId: process.env.MS_CLIENT_ID,
    clientSecret: process.env.MS_CLIENT_SECRET,
    tenantId: process.env.MS_TENANT_ID || 'common',
    redirectUri: process.env.MS_REDIRECT_URI,
  };
}

// Step 1: redirect user to Microsoft login
router.get('/microsoft', async (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });

  const { clientId, tenantId, redirectUri } = getMsConfig();
  if (!clientId || !tenantId || !redirectUri) {
    return res.status(500).json({ error: 'Microsoft OAuth not configured. Set MS_CLIENT_ID, MS_CLIENT_SECRET, MS_TENANT_ID, MS_REDIRECT_URI in .env' });
  }

  // Generate a random CSRF nonce for the state parameter and store it alongside
  // the userId so the callback can verify it without trusting the state value.
  const oauthNonce = randomBytes(16).toString('hex');
  req.session.oauthNonce  = oauthNonce;
  req.session.oauthUserId = req.session.userId;

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    response_mode: 'query',
    scope: 'https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access openid email profile',
    state: oauthNonce,
    prompt: 'select_account',
  });

  // Save session before redirecting so the nonce is committed to the store
  // before the external provider redirects back with the authorization code.
  await new Promise((resolve, reject) => req.session.save(err => err ? reject(err) : resolve()));
  res.redirect(`${MICROSOFT_AUTH_URL}/${tenantId}/oauth2/v2.0/authorize?${params}`);
});

// Step 2: Microsoft redirects back here with auth code
router.get('/microsoft/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;

  if (error) {
    console.error('Microsoft OAuth error:', error, error_description);
    return res.redirect(`/?oauth_error=${encodeURIComponent(error_description || error)}`);
  }

  // Validate CSRF nonce BEFORE making any external requests
  if (!state || state !== req.session.oauthNonce) {
    return res.redirect(`/?oauth_error=${encodeURIComponent('Invalid OAuth state — please try again')}`);
  }
  const userId = req.session.oauthUserId;
  if (!userId) return res.redirect(`/?oauth_error=${encodeURIComponent('OAuth session expired — please try again')}`);
  delete req.session.oauthNonce;
  delete req.session.oauthUserId;

  const { clientId, clientSecret, tenantId, redirectUri } = getMsConfig();

  try {
    // Exchange code for tokens
    const tokenRes = await fetch(`${MICROSOFT_AUTH_URL}/${tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
      signal: AbortSignal.timeout(10000),
    });

    const tokens = await tokenRes.json();
    if (!tokenRes.ok) {
      throw new Error(tokens.error_description || tokens.error || 'Token exchange failed');
    }

    // Authorization-code flow uses the client secret → confidential client.
    await processMicrosoftTokens(userId, tokens, { tenantId, clientId, publicClient: false });

    // Redirect back to app with success
    res.redirect('/?oauth_success=microsoft');
  } catch (err) {
    console.error('Microsoft OAuth callback error:', err);
    res.redirect('/?oauth_error=Authentication+failed');
  }
});

// Shared: validate tokens, upsert account, connect IMAP.
async function processMicrosoftTokens(userId, tokens, { tenantId, clientId, publicClient = false }) {
  const { access_token, refresh_token, expires_in, id_token } = tokens;
  const expiresInSecs = Number.isFinite(expires_in) && expires_in > 0 ? expires_in : 3600;
  const expiry = new Date(Date.now() + expiresInSecs * 1000);

  // Validate the id_token via Microsoft's JWKS, then extract user info.
  // The access_token is scoped to outlook.office.com (IMAP/SMTP) and cannot be used
  // with graph.microsoft.com, so id_token is the right source for email/name.
  let email = null;
  let displayName = null;
  if (id_token) {
    const jwks = getMsJwks(tenantId);
    const verifyOpts = { audience: clientId };
    // For multi-tenant ('common'/'organizations'/'consumers'), issuers vary per tenant,
    // so we skip issuer validation and rely on audience + signature instead.
    const fixedTenants = new Set(['common', 'organizations', 'consumers']);
    if (!fixedTenants.has(tenantId)) {
      verifyOpts.issuer = `https://login.microsoftonline.com/${tenantId}/v2.0`;
    }
    try {
      const { payload } = await jwtVerify(id_token, jwks, verifyOpts);
      // For multi-tenant configs the issuer check is skipped above, so validate that
      // the iss claim matches the token's own tid.  This prevents cross-tenant identity
      // injection where an attacker creates a Microsoft tenant with the victim's email,
      // obtains a JWT signed by Microsoft, and submits it to a MailFlow instance
      // configured for 'common'.
      if (fixedTenants.has(tenantId) && payload.tid && payload.iss) {
        const expectedIss = `https://login.microsoftonline.com/${payload.tid}/v2.0`;
        if (payload.iss !== expectedIss) {
          throw new Error(`id_token issuer mismatch: expected ${expectedIss}, got ${payload.iss}`);
        }
      }
      email = payload.email || payload.preferred_username || null;
      displayName = payload.name || null;
    } catch (jwtErr) {
      console.error('Microsoft id_token validation failed:', jwtErr.message);
      throw new Error('Could not validate Microsoft identity token — please try again', { cause: jwtErr });
    }
  }

  if (!email) throw new Error('Could not retrieve email address from Microsoft profile — ensure the openid, email, and profile scopes are granted');

  // Serialize the check-then-insert per (user, email) with a transaction-scoped
  // advisory lock. Two OAuth callbacks racing for the same mailbox would otherwise
  // both miss the SELECT and each INSERT, producing duplicate account rows. The
  // second waiter blocks until the first commits, then sees the row and updates it.
  const account = await withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',
      [`oauth-account:${userId}:${email.toLowerCase()}`]);

    const existing = await client.query(
      'SELECT id FROM email_accounts WHERE user_id = $1 AND email_address = $2',
      [userId, email]
    );

    let accountId;
    if (existing.rows.length) {
      accountId = existing.rows[0].id;
      await client.query(`
        UPDATE email_accounts SET
          oauth_access_token = $1, oauth_refresh_token = $2, oauth_token_expiry = $3,
          name = $4, oauth_public_client = $5, sync_error = NULL
        WHERE id = $6
      `, [encrypt(access_token), encrypt(refresh_token), expiry, displayName || email, publicClient, accountId]);
    } else {
      const colors = ['#0078d4', '#106ebe', '#005a9e', '#004578'];
      const color = colors[Math.floor(Math.random() * colors.length)];
      const result = await client.query(`
        INSERT INTO email_accounts (
          user_id, name, email_address, color, protocol,
          imap_host, imap_port, imap_tls,
          smtp_host, smtp_port, smtp_tls,
          auth_user,
          oauth_provider, oauth_access_token, oauth_refresh_token, oauth_token_expiry,
          oauth_public_client
        ) VALUES ($1,$2,$3,$4,'imap',
          'outlook.office365.com', 993, true,
          'smtp.office365.com', 587, 'STARTTLS',
          $3,
          'microsoft', $5, $6, $7,
          $8)
        RETURNING *
      `, [userId, displayName, email, color, encrypt(access_token), encrypt(refresh_token), expiry, publicClient]);
      accountId = result.rows[0].id;
    }

    const accountResult = await client.query('SELECT * FROM email_accounts WHERE id = $1', [accountId]);
    return accountResult.rows[0];
  });

  imapManager.connectAccount(account).catch(err =>
    console.error(`OAuth connect failed for ${redactEmail(email)}:`, err.message)
  );
  return email;
}

// Step 1: initiate device code flow — returns user_code + verification_uri to the frontend.
router.post('/microsoft/device', async (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });
  const { clientId, tenantId } = getMsConfig();
  if (!clientId || !tenantId) {
    return res.status(400).json({ error: 'Microsoft integration not configured. Set Client ID and Tenant ID in the Integrations tab.' });
  }

  try {
    const dcRes = await fetch(`${MICROSOFT_AUTH_URL}/${tenantId}/oauth2/v2.0/devicecode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        scope: 'https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access openid email profile',
      }),
      signal: AbortSignal.timeout(10000),
    });
    const dc = await dcRes.json();
    if (!dcRes.ok) {
      throw new Error(dc.error_description || dc.error || 'Failed to start device code flow');
    }

    deviceFlows.set(req.session.userId, {
      deviceCode: dc.device_code,
      tenantId,
      clientId,
      expiresAt: Date.now() + dc.expires_in * 1000,
    });

    res.json({
      userCode: dc.user_code,
      verificationUri: dc.verification_uri,
      expiresIn: dc.expires_in,
      interval: dc.interval || 5,
    });
  } catch (err) {
    console.error('Device code init error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Step 2: poll for token — called repeatedly by the frontend until resolved.
router.get('/microsoft/device/poll', async (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });
  const flow = deviceFlows.get(req.session.userId);
  if (!flow) return res.status(400).json({ status: 'error', error: 'No pending device code flow' });
  if (Date.now() > flow.expiresAt) {
    deviceFlows.delete(req.session.userId);
    return res.json({ status: 'expired' });
  }

  try {
    const tokenRes = await fetch(`${MICROSOFT_AUTH_URL}/${flow.tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: flow.clientId,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: flow.deviceCode,
      }),
      signal: AbortSignal.timeout(10000),
    });
    const tokens = await tokenRes.json();

    if (tokens.error === 'authorization_pending') return res.json({ status: 'pending' });
    if (tokens.error === 'authorization_declined') {
      deviceFlows.delete(req.session.userId);
      return res.json({ status: 'declined' });
    }
    if (tokens.error === 'expired_token') {
      deviceFlows.delete(req.session.userId);
      return res.json({ status: 'expired' });
    }
    if (!tokenRes.ok) {
      deviceFlows.delete(req.session.userId);
      return res.json({ status: 'error', error: tokens.error_description || tokens.error || 'Token exchange failed' });
    }

    deviceFlows.delete(req.session.userId);
    // Device-code flow never uses a client secret → public client. Its refresh must
    // omit the secret too, or Microsoft rejects it with AADSTS90023 (#216).
    await processMicrosoftTokens(req.session.userId, tokens, { tenantId: flow.tenantId, clientId: flow.clientId, publicClient: true });
    res.json({ status: 'success' });
  } catch (err) {
    console.error('Device code poll error:', err.message);
    deviceFlows.delete(req.session.userId);
    res.json({ status: 'error', error: err.message });
  }
});

// Serialize refreshes per account so concurrent callers share one token-endpoint
// call — AAD rotates the refresh token on each refresh, and two racing refreshes
// would strand a superseded refresh token and lock the account out.
const inFlightMsRefresh = new Map(); // accountId -> Promise
export function refreshMicrosoftToken(account) {
  const existing = inFlightMsRefresh.get(account.id);
  if (existing) return existing;
  const p = doRefreshMicrosoftToken(account).finally(() => inFlightMsRefresh.delete(account.id));
  inFlightMsRefresh.set(account.id, p);
  return p;
}

// Refresh an expired Microsoft token
async function doRefreshMicrosoftToken(account) {
  const { clientId, clientSecret, tenantId } = getMsConfig();

  const storedRefreshToken = decrypt(account.oauth_refresh_token);
  if (!storedRefreshToken) throw new Error('OAuth refresh token is missing or corrupted — please reconnect your account');

  // Public clients (device-code flow — personal Outlook.com/Hotmail) must NOT send a
  // client_secret on refresh: Microsoft rejects it with AADSTS90023 ("Public clients
  // can't send a client secret"). Confidential clients (auth-code flow) must send it.
  // Key this on the account's recorded flow, not on whether a secret is configured
  // globally, since one instance can host both kinds. (#216)
  const tokenUrl = `${MICROSOFT_AUTH_URL}/${tenantId}/oauth2/v2.0/token`;
  const postRefresh = (withSecret) => {
    const params = new URLSearchParams({
      client_id: clientId,
      refresh_token: storedRefreshToken,
      grant_type: 'refresh_token',
      scope: 'https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access',
    });
    if (withSecret) params.set('client_secret', clientSecret);
    return fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
      signal: AbortSignal.timeout(10000),
    });
  };

  const sendSecret = !!clientSecret && !account.oauth_public_client;
  let tokenRes = await postRefresh(sendSecret);
  let tokens = await tokenRes.json();
  let becamePublic = false;

  // Self-heal accounts predating the oauth_public_client column: if we sent a secret
  // and Microsoft says a public client can't (AADSTS90023), this is really a public
  // (device-code) client — retry without the secret and record it so future refreshes
  // skip the secret straight away.
  if (!tokenRes.ok && sendSecret && /AADSTS90023/i.test(tokens.error_description || tokens.error || '')) {
    tokenRes = await postRefresh(false);
    tokens = await tokenRes.json();
    becamePublic = tokenRes.ok;
  }

  if (!tokenRes.ok) throw new Error(tokens.error_description || 'Token refresh failed');

  const { access_token, refresh_token, expires_in } = tokens;
  const refreshExpiresInSecs = Number.isFinite(expires_in) && expires_in > 0 ? expires_in : 3600;
  const expiry = new Date(Date.now() + refreshExpiresInSecs * 1000);
  const isPublic = !!account.oauth_public_client || becamePublic;

  await query(`
    UPDATE email_accounts SET
      oauth_access_token = $1,
      oauth_refresh_token = COALESCE($2, oauth_refresh_token),
      oauth_token_expiry = $3,
      oauth_public_client = $4
    WHERE id = $5
  `, [encrypt(access_token), refresh_token ? encrypt(refresh_token) : null, expiry, isPublic, account.id]);

  // Return plaintext tokens so callers can use them immediately without decrypting
  return { ...account, oauth_access_token: access_token, oauth_token_expiry: expiry, oauth_public_client: isPublic };
}

export default router;
