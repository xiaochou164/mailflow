import { redisClient } from '../services/redis.js';
import { authenticateApplicationToken } from '../services/applicationService.js';
import { authenticateOAuthAccessToken } from '../services/mcpOAuthService.js';
import {
  recordApplicationAuditEvent,
  recordApplicationSecurityAlert,
} from '../services/applicationAudit.js';

function normalizeIp(ip) {
  return String(ip || '')
    .trim()
    .replace(/^::ffff:/i, '');
}

function ipv4ToInt(ip) {
  const parts = normalizeIp(ip).split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    value = (value << 8) + n;
  }
  return value >>> 0;
}

export function ipAllowed(ip, rules = []) {
  if (!Array.isArray(rules) || rules.length === 0) return true;
  const normalizedIp = normalizeIp(ip);
  const ipInt = ipv4ToInt(normalizedIp);
  return rules.some(rule => {
    const normalizedRule = normalizeIp(rule);
    if (normalizedRule === normalizedIp) return true;
    const [base, bitsRaw] = normalizedRule.split('/');
    if (bitsRaw === undefined) return false;
    const bits = Number(bitsRaw);
    const baseInt = ipv4ToInt(base);
    if (ipInt == null || baseInt == null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (ipInt & mask) === (baseInt & mask);
  });
}

function bearerToken(req) {
  const header = req.get('Authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

export async function requireApplication(req, res, next) {
  try {
    const token = bearerToken(req);
    const application = await authenticateApplicationToken(token) || await authenticateOAuthAccessToken(token);
    if (!application) return res.status(401).json({ error: 'Invalid or revoked application token' });
    if (!ipAllowed(req.ip, application.allowedIps)) {
      recordApplicationSecurityAlert({
        userId: application.userId,
        applicationId: application.id,
        type: 'ip_blocked',
        details: { ipAddress: req.ip, path: `${req.baseUrl}${req.path}`, method: req.method },
      }).catch(err => console.warn('Application security alert write failed:', err.message));
      return res.status(403).json({ error: 'IP address is outside this application whitelist' });
    }
    req.application = application;
    next();
  } catch (err) {
    next(err);
  }
}

export function requireApplicationPermission(permission) {
  return (req, res, next) => {
    if (!req.application?.permissions?.includes(permission)) {
      return res.status(403).json({ error: `Missing permission: ${permission}` });
    }
    next();
  };
}

export function applicationAudit(req, res, next) {
  const started = Date.now();
  const path = `${req.baseUrl}${req.path}`;
  res.on('finish', () => {
    const application = req.application;
    if (!application?.id || !application.userId) return;
    recordApplicationAuditEvent({
      userId: application.userId,
      applicationId: application.id,
      method: req.method,
      path,
      statusCode: res.statusCode,
      durationMs: Date.now() - started,
      ipAddress: req.ip,
      userAgent: req.get('User-Agent'),
      retentionDays: application.auditRetentionDays,
    }).catch(err => console.warn('Application audit write failed:', err.message));
  });
  next();
}

export async function applicationRateLimit(req, res, next) {
  const applicationId = req.application?.id;
  if (!applicationId) return res.status(401).json({ error: 'Application authentication required' });
  const minute = Math.floor(Date.now() / 60_000);
  const key = `app_rate:${applicationId}:${minute}`;
  try {
    const count = await redisClient.incr(key);
    if (count === 1) await redisClient.expire(key, 70);
    if (count > 120) {
      res.setHeader('Retry-After', '60');
      return res.status(429).json({ error: 'Application rate limit exceeded' });
    }
    next();
  } catch (err) {
    next(err);
  }
}
