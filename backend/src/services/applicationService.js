import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { query, withTransaction } from './db.js';

export const APPLICATION_PERMISSIONS = Object.freeze([
  'email.search',
  'email.read',
]);

const TOKEN_PATTERN = /^mf_sk_([A-Za-z0-9_-]{16})_([A-Za-z0-9_-]{43})$/;

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

function applicationRow(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    permissions: row.permissions || [],
    keyPrefix: row.key_id ? `mf_sk_${row.key_id.slice(0, 8)}…` : null,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

export async function listApplications(userId) {
  const result = await query(`
    SELECT a.id, a.name, a.description, a.permissions, a.created_at,
           a.last_used_at, c.key_id
    FROM applications a
    JOIN application_credentials c ON c.application_id = a.id
    WHERE a.user_id = $1
      AND a.revoked_at IS NULL
      AND c.revoked_at IS NULL
    ORDER BY a.created_at DESC
  `, [userId]);
  return result.rows.map(applicationRow);
}

export async function createApplication({ userId, name, description, permissions }) {
  const normalizedName = normalizeText(name, 100);
  if (!normalizedName) {
    throw Object.assign(new Error('Application name is required'), { status: 400 });
  }
  const normalizedDescription = normalizeText(description, 500);
  const normalizedPermissions = validatePermissions(permissions);
  const keyId = randomBytes(12).toString('base64url');
  const secret = randomBytes(32).toString('base64url');
  const secretHash = hashSecret(secret);

  const row = await withTransaction(async client => {
    const appResult = await client.query(`
      INSERT INTO applications (user_id, name, description, permissions)
      VALUES ($1, $2, $3, $4::text[])
      RETURNING id, name, description, permissions, created_at, last_used_at
    `, [userId, normalizedName, normalizedDescription, normalizedPermissions]);
    const application = appResult.rows[0];
    await client.query(`
      INSERT INTO application_credentials (application_id, key_id, secret_hash)
      VALUES ($1, $2, $3)
    `, [application.id, keyId, secretHash]);
    return { ...application, key_id: keyId };
  });

  return {
    application: applicationRow(row),
    token: `mf_sk_${keyId}_${secret}`,
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
    SELECT a.id, a.user_id, a.name, a.permissions, c.id AS credential_id,
           c.secret_hash
    FROM application_credentials c
    JOIN applications a ON a.id = c.application_id
    JOIN users u ON u.id = a.user_id
    WHERE c.key_id = $1
      AND c.revoked_at IS NULL
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
  };
}
