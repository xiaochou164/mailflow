import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { isIP } from 'net';
import { query, withTransaction } from './db.js';

export const APPLICATION_PERMISSIONS = Object.freeze([
  'account.read',
  'email.search',
  'email.read',
  'email.thread',
  'email.attachments',
  'email.draft',
  'email.send',
  'email.reply',
  'email.forward',
  'email.modify',
  'email.move',
  'email.delete',
  'ai.summarize',
  'webhook.manage',
]);

const TOKEN_PATTERN = /^mf_sk_([A-Za-z0-9_-]{16})_([A-Za-z0-9_-]{43})$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function keyPepper() {
  const pepper = process.env.APPLICATION_KEY_PEPPER || process.env.ENCRYPTION_KEY;
  if (!pepper) throw new Error('APPLICATION_KEY_PEPPER or ENCRYPTION_KEY is required');
  return pepper;
}

function hashSecret(secret) {
  return createHmac('sha256', keyPepper())
    .update('mailflow:application-key:v1:')
    .update(secret)
    .digest('hex');
}

function newApplicationToken() {
  const keyId = randomBytes(12).toString('base64url');
  const secret = randomBytes(32).toString('base64url');
  return {
    keyId,
    secret,
    secretHash: hashSecret(secret),
    token: `mf_sk_${keyId}_${secret}`,
  };
}

function validatePermissions(permissions) {
  if (!Array.isArray(permissions) || permissions.length === 0) {
    throw Object.assign(new Error('At least one permission is required'), { status: 400 });
  }
  const unique = [...new Set(permissions)];
  if (unique.some(permission => !APPLICATION_PERMISSIONS.includes(permission))) {
    throw Object.assign(new Error('Unknown application permission'), { status: 400 });
  }
  return unique;
}

function normalizeText(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function normalizeFolders(folders) {
  if (!Array.isArray(folders)) return null;
  const clean = [...new Set(folders
    .map(folder => typeof folder === 'string' ? folder.trim() : '')
    .filter(Boolean)
    .map(folder => folder.slice(0, 500)))];
  return clean.length ? clean : null;
}

function normalizeAllowedIps(allowedIps) {
  if (!Array.isArray(allowedIps)) return null;
  const clean = [...new Set(allowedIps
    .map(ip => typeof ip === 'string' ? ip.trim() : '')
    .filter(Boolean)
    .map(ip => ip.slice(0, 100)))];
  if (!clean.length) return null;
  if (clean.some(ip => {
    const [address, bitsRaw] = ip.split('/');
    const family = isIP(address);
    if (!family) return true;
    if (bitsRaw === undefined) return false;
    const bits = Number(bitsRaw);
    const maxBits = family === 4 ? 32 : 128;
    return !Number.isInteger(bits) || bits < 0 || bits > maxBits;
  })) {
    throw Object.assign(new Error('IP whitelist contains an invalid address or CIDR'), { status: 400 });
  }
  return clean;
}

function normalizeAuditRetentionDays(value) {
  if (value == null || value === '') return 90;
  const days = Number(value);
  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    throw Object.assign(new Error('Audit retention must be between 1 and 3650 days'), { status: 400 });
  }
  return days;
}

async function normalizeAccountIds(userId, accountIds) {
  if (!Array.isArray(accountIds)) return null;
  const clean = [...new Set(accountIds
    .map(id => typeof id === 'string' ? id.trim() : '')
    .filter(Boolean))];
  if (!clean.length) return null;
  if (clean.some(id => !UUID_RE.test(id))) {
    throw Object.assign(new Error('Account scope contains an invalid account id'), { status: 400 });
  }
  const result = await query(
    'SELECT id FROM email_accounts WHERE user_id = $1 AND id = ANY($2::uuid[])',
    [userId, clean]
  );
  if (result.rows.length !== clean.length) {
    throw Object.assign(new Error('Account scope contains an account you do not own'), { status: 400 });
  }
  return clean;
}

function normalizeExpiresAt(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') {
    throw Object.assign(new Error('Token expiration must be an ISO date string'), { status: 400 });
  }
  const raw = value.trim();
  if (!raw) return null;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? new Date(`${raw}T23:59:59.999Z`)
    : new Date(raw);
  if (!Number.isFinite(date.getTime())) {
    throw Object.assign(new Error('Token expiration must be a valid date'), { status: 400 });
  }
  if (date.getTime() <= Date.now()) {
    throw Object.assign(new Error('Token expiration must be in the future'), { status: 400 });
  }
  return date.toISOString();
}

function applicationRow(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    permissions: row.permissions || [],
    accountIds: row.account_ids || [],
    folders: row.folders || [],
    allowedIps: row.allowed_ips || [],
    auditRetentionDays: row.audit_retention_days ?? 90,
    redactContent: row.redact_content === true,
    keyPrefix: row.key_id ? `mf_sk_${row.key_id.slice(0, 8)}…` : null,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
  };
}

export async function listApplications(userId) {
  const result = await query(`
    SELECT a.id, a.name, a.description, a.permissions, a.account_ids, a.folders,
           a.allowed_ips, a.audit_retention_days, a.redact_content, a.created_at,
           a.last_used_at, c.key_id, c.expires_at
    FROM applications a
    JOIN application_credentials c ON c.application_id = a.id
    WHERE a.user_id = $1
      AND a.revoked_at IS NULL
      AND c.revoked_at IS NULL
    ORDER BY a.created_at DESC
  `, [userId]);
  return result.rows.map(applicationRow);
}

export async function createApplication({
  userId,
  name,
  description,
  permissions,
  expiresAt,
  accountIds,
  folders,
  allowedIps,
  auditRetentionDays,
  redactContent,
}) {
  const normalizedName = normalizeText(name, 100);
  if (!normalizedName) {
    throw Object.assign(new Error('Application name is required'), { status: 400 });
  }
  const normalizedDescription = normalizeText(description, 500);
  const normalizedPermissions = validatePermissions(permissions);
  const normalizedExpiresAt = normalizeExpiresAt(expiresAt);
  const normalizedAccountIds = await normalizeAccountIds(userId, accountIds);
  const normalizedFolders = normalizeFolders(folders);
  const normalizedAllowedIps = normalizeAllowedIps(allowedIps);
  const normalizedAuditRetentionDays = normalizeAuditRetentionDays(auditRetentionDays);
  const normalizedRedactContent = redactContent === true;
  const token = newApplicationToken();

  const row = await withTransaction(async client => {
    const appResult = await client.query(`
      INSERT INTO applications (
        user_id, name, description, permissions, account_ids, folders,
        allowed_ips, audit_retention_days, redact_content
      )
      VALUES ($1, $2, $3, $4::text[], $5::uuid[], $6::text[], $7::text[], $8::int, $9::boolean)
      RETURNING id, name, description, permissions, account_ids, folders,
                allowed_ips, audit_retention_days, redact_content, created_at, last_used_at
    `, [
      userId,
      normalizedName,
      normalizedDescription,
      normalizedPermissions,
      normalizedAccountIds,
      normalizedFolders,
      normalizedAllowedIps,
      normalizedAuditRetentionDays,
      normalizedRedactContent,
    ]);
    const application = appResult.rows[0];
    await client.query(`
      INSERT INTO application_credentials (application_id, key_id, secret_hash, expires_at)
      VALUES ($1, $2, $3, $4)
    `, [application.id, token.keyId, token.secretHash, normalizedExpiresAt]);
    return { ...application, key_id: token.keyId, expires_at: normalizedExpiresAt };
  });

  return {
    application: applicationRow(row),
    token: token.token,
  };
}

export async function rotateApplicationToken({ userId, applicationId, expiresAt }) {
  const normalizedExpiresAt = normalizeExpiresAt(expiresAt);
  const token = newApplicationToken();
  const row = await withTransaction(async client => {
    const appResult = await client.query(`
      SELECT id, name, description, permissions, account_ids, folders,
             allowed_ips, audit_retention_days, redact_content, created_at, last_used_at
      FROM applications
      WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
      FOR UPDATE
    `, [applicationId, userId]);
    if (!appResult.rows.length) return null;
    await client.query(`
      UPDATE application_credentials
      SET revoked_at = NOW()
      WHERE application_id = $1 AND revoked_at IS NULL
    `, [applicationId]);
    await client.query(`
      INSERT INTO application_credentials (application_id, key_id, secret_hash, expires_at)
      VALUES ($1, $2, $3, $4)
    `, [applicationId, token.keyId, token.secretHash, normalizedExpiresAt]);
    await client.query('UPDATE applications SET updated_at = NOW() WHERE id = $1', [applicationId]);
    return { ...appResult.rows[0], key_id: token.keyId, expires_at: normalizedExpiresAt };
  });
  if (!row) return null;
  return {
    application: applicationRow(row),
    token: token.token,
  };
}

export async function revokeApplication({ userId, applicationId }) {
  const revoked = await withTransaction(async client => {
    const result = await client.query(`
      UPDATE applications
      SET revoked_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
      RETURNING id
    `, [applicationId, userId]);
    if (!result.rows.length) return false;
    await client.query(`
      UPDATE application_credentials
      SET revoked_at = NOW()
      WHERE application_id = $1 AND revoked_at IS NULL
    `, [applicationId]);
    return true;
  });
  return revoked;
}

export async function authenticateApplicationToken(token) {
  if (typeof token !== 'string') return null;
  const match = token.match(TOKEN_PATTERN);
  if (!match) return null;
  const [, keyId, secret] = match;

  const result = await query(`
    SELECT a.id, a.user_id, a.name, a.permissions, a.account_ids, a.folders,
           a.allowed_ips, a.audit_retention_days, a.redact_content, c.id AS credential_id,
           c.secret_hash, c.expires_at
    FROM application_credentials c
    JOIN applications a ON a.id = c.application_id
    JOIN users u ON u.id = a.user_id
    WHERE c.key_id = $1
      AND c.revoked_at IS NULL
      AND (c.expires_at IS NULL OR c.expires_at > NOW())
      AND a.revoked_at IS NULL
    LIMIT 1
  `, [keyId]);
  if (!result.rows.length) return null;

  const row = result.rows[0];
  const supplied = Buffer.from(hashSecret(secret), 'hex');
  const stored = Buffer.from(row.secret_hash, 'hex');
  if (supplied.length !== stored.length || !timingSafeEqual(supplied, stored)) return null;

  await query(`
    WITH credential_update AS (
      UPDATE application_credentials SET last_used_at = NOW() WHERE id = $1
    )
    UPDATE applications SET last_used_at = NOW() WHERE id = $2
  `, [row.credential_id, row.id]);

  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    permissions: row.permissions || [],
    accountIds: row.account_ids || [],
    folders: row.folders || [],
    allowedIps: row.allowed_ips || [],
    auditRetentionDays: row.audit_retention_days ?? 90,
    redactContent: row.redact_content === true,
  };
}
