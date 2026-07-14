import { query } from './db.js';

function clampText(value, maxLength) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : null;
}

function normalizeLimit(limit) {
  return Math.max(1, Math.min(Number(limit) || 50, 200));
}

function normalizeRetentionDays(days) {
  const value = Number(days);
  return Number.isInteger(value) && value >= 1 && value <= 3650 ? value : 90;
}

function alertSeverity(type) {
  if (type === 'ip_blocked' || type === 'server_error') return 'high';
  if (type === 'rate_limited' || type === 'client_error_spike') return 'medium';
  return 'low';
}

function alertMessage(type, meta = {}) {
  if (type === 'ip_blocked') return `Application request blocked from IP ${meta.ipAddress || 'unknown'}`;
  if (type === 'rate_limited') return 'Application hit the API rate limit';
  if (type === 'server_error') return `Application received a server error on ${meta.path || 'an API route'}`;
  if (type === 'client_error_spike') return 'Application produced repeated client errors in a short window';
  return 'Application security alert';
}

export async function recordApplicationSecurityAlert({
  userId,
  applicationId,
  type,
  details = {},
}) {
  if (!userId || !applicationId || !type) return null;
  const result = await query(`
    INSERT INTO application_security_alerts (
      user_id, application_id, type, severity, message, details
    )
    SELECT $1, $2, $3, $4, $5, $6::jsonb
    WHERE NOT EXISTS (
      SELECT 1
      FROM application_security_alerts
      WHERE application_id = $2
        AND type = $3
        AND created_at > NOW() - INTERVAL '15 minutes'
    )
    RETURNING id
  `, [
    userId,
    applicationId,
    type,
    alertSeverity(type),
    alertMessage(type, details),
    JSON.stringify(details || {}),
  ]);
  return result.rows[0]?.id || null;
}

async function detectApplicationAnomaly({
  userId,
  applicationId,
  method,
  path,
  statusCode,
  ipAddress,
}) {
  if (statusCode === 429) {
    await recordApplicationSecurityAlert({
      userId,
      applicationId,
      type: 'rate_limited',
      details: { method, path, statusCode, ipAddress },
    });
    return;
  }
  if (statusCode >= 500) {
    await recordApplicationSecurityAlert({
      userId,
      applicationId,
      type: 'server_error',
      details: { method, path, statusCode, ipAddress },
    });
    return;
  }
  if (statusCode >= 400) {
    const result = await query(`
      SELECT COUNT(*)::int AS count
      FROM application_audit_events
      WHERE application_id = $1
        AND status_code BETWEEN 400 AND 499
        AND status_code <> 429
        AND created_at > NOW() - INTERVAL '10 minutes'
    `, [applicationId]);
    const count = Number(result.rows[0]?.count) || 0;
    if (count >= 10) {
      await recordApplicationSecurityAlert({
        userId,
        applicationId,
        type: 'client_error_spike',
        details: { method, path, statusCode, ipAddress, recentClientErrors: count },
      });
    }
  }
}

export async function pruneApplicationAuditEvents({ applicationId, retentionDays = 90 }) {
  if (!applicationId) return;
  await query(`
    DELETE FROM application_audit_events
    WHERE application_id = $1
      AND created_at < NOW() - ($2::int * INTERVAL '1 day')
  `, [applicationId, normalizeRetentionDays(retentionDays)]);
}

export async function recordApplicationAuditEvent({
  userId,
  applicationId,
  method,
  path,
  statusCode,
  durationMs,
  ipAddress,
  userAgent,
  retentionDays,
}) {
  if (!userId || !applicationId) return;
  await query(`
    INSERT INTO application_audit_events (
      user_id, application_id, method, path, status_code,
      duration_ms, ip_address, user_agent
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  `, [
    userId,
    applicationId,
    String(method || 'GET').slice(0, 10),
    String(path || '/').slice(0, 1000),
    Number(statusCode) || 0,
    Math.max(0, Math.round(Number(durationMs) || 0)),
    clampText(ipAddress, 100),
    clampText(userAgent, 500),
  ]);
  await pruneApplicationAuditEvents({ applicationId, retentionDays });
  await detectApplicationAnomaly({
    userId,
    applicationId,
    method: String(method || 'GET').slice(0, 10),
    path: String(path || '/').slice(0, 1000),
    statusCode: Number(statusCode) || 0,
    ipAddress: clampText(ipAddress, 100),
  });
}

export async function listApplicationAuditEvents({ userId, applicationId, limit = 50 }) {
  await query(`
    DELETE FROM application_audit_events e
    USING applications a
    WHERE a.id = e.application_id
      AND e.application_id = $1
      AND a.user_id = $2
      AND e.created_at < NOW() - (COALESCE(a.audit_retention_days, 90)::int * INTERVAL '1 day')
  `, [applicationId, userId]);
  const result = await query(`
    SELECT e.id, e.method, e.path, e.status_code, e.duration_ms,
           e.ip_address, e.user_agent, e.created_at
    FROM application_audit_events e
    JOIN applications a ON a.id = e.application_id
    WHERE e.application_id = $1
      AND a.user_id = $2
    ORDER BY e.created_at DESC
    LIMIT $3
  `, [applicationId, userId, normalizeLimit(limit)]);

  return result.rows.map(row => ({
    id: row.id,
    method: row.method,
    path: row.path,
    statusCode: row.status_code,
    durationMs: row.duration_ms,
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
    createdAt: row.created_at,
  }));
}

export async function listApplicationSecurityAlerts({ userId, applicationId, limit = 50, includeAcknowledged = false }) {
  const result = await query(`
    SELECT id, type, severity, message, details, acknowledged_at, created_at
    FROM application_security_alerts
    WHERE user_id = $1
      AND application_id = $2
      AND ($3::boolean = true OR acknowledged_at IS NULL)
    ORDER BY created_at DESC
    LIMIT $4
  `, [userId, applicationId, includeAcknowledged === true, normalizeLimit(limit)]);

  return result.rows.map(row => ({
    id: row.id,
    type: row.type,
    severity: row.severity,
    message: row.message,
    details: row.details || {},
    acknowledgedAt: row.acknowledged_at,
    createdAt: row.created_at,
  }));
}

export async function acknowledgeApplicationSecurityAlert({ userId, applicationId, alertId }) {
  const result = await query(`
    UPDATE application_security_alerts
    SET acknowledged_at = NOW()
    WHERE id = $1
      AND user_id = $2
      AND application_id = $3
      AND acknowledged_at IS NULL
    RETURNING id
  `, [alertId, userId, applicationId]);
  return result.rows.length > 0;
}
