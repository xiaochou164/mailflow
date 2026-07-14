import { query } from '../services/db.js';

export const ADMIN_ROLES = Object.freeze({
  DEVELOPER_APPS: 'developer_apps',
});

export function normalizeAdminRoles(roles) {
  if (!Array.isArray(roles)) return [];
  return [...new Set(roles.map(role => String(role || '').trim()).filter(Boolean))];
}

export function hasAdminRole(user, role) {
  if (!user) return false;
  if (user.is_admin || user.isAdmin) return true;
  const roles = normalizeAdminRoles(user.admin_roles || user.adminRoles);
  return roles.includes('super_admin') || roles.includes(role);
}

export async function requireAuth(req, res, next) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  try {
    const result = await query('SELECT id FROM users WHERE id = $1', [req.session.userId]);
    if (!result.rows.length) {
      req.session.destroy(() => {});
      return res.status(401).json({ error: 'Not authenticated' });
    }
    next();
  } catch (err) {
    next(err);
  }
}

// Always verifies against the DB so a revoked admin can't keep using
// a stale session. The extra query is cheap and only hits admin routes.
export async function requireAdmin(req, res, next) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  try {
    const result = await query(
      'SELECT is_admin FROM users WHERE id = $1',
      [req.session.userId]
    );
    if (!result.rows[0]?.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  } catch (err) {
    next(err);
  }
}

export function requireAdminRole(role) {
  return async function adminRoleMiddleware(req, res, next) {
    if (!req.session?.userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    try {
      const result = await query(
        'SELECT is_admin, admin_roles FROM users WHERE id = $1',
        [req.session.userId]
      );
      if (!hasAdminRole(result.rows[0], role)) {
        return res.status(403).json({ error: 'Admin role required' });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
