import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({
  query: vi.fn(),
}));

const { query } = await import('../services/db.js');
const {
  ADMIN_ROLES,
  hasAdminRole,
  requireAdminRole,
} = await import('./auth.js');

function createReq(userId = 'user-1') {
  return { session: { userId } };
}

function createRes() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

describe('admin RBAC', () => {
  beforeEach(() => {
    query.mockReset();
  });

  it('treats full admins as having every admin role', () => {
    expect(hasAdminRole({ is_admin: true, admin_roles: [] }, ADMIN_ROLES.DEVELOPER_APPS)).toBe(true);
  });

  it('allows users with a matching scoped admin role', async () => {
    query.mockResolvedValueOnce({
      rows: [{ is_admin: false, admin_roles: [ADMIN_ROLES.DEVELOPER_APPS] }],
    });
    const req = createReq();
    const res = createRes();
    const next = vi.fn();

    await requireAdminRole(ADMIN_ROLES.DEVELOPER_APPS)(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(null);
  });

  it('rejects authenticated users without the required admin role', async () => {
    query.mockResolvedValueOnce({
      rows: [{ is_admin: false, admin_roles: [] }],
    });
    const req = createReq();
    const res = createRes();
    const next = vi.fn();

    await requireAdminRole(ADMIN_ROLES.DEVELOPER_APPS)(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'Admin role required' });
  });
});
