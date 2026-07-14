import { redisClient } from '../services/redis.js';
import { authenticateApplicationToken } from '../services/applicationService.js';

function bearerToken(req) {
  const header = req.get('Authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

export async function requireApplication(req, res, next) {
  try {
    const application = await authenticateApplicationToken(bearerToken(req));
    if (!application) return res.status(401).json({ error: 'Invalid or revoked application token' });
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
