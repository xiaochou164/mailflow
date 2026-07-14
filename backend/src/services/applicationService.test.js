import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
}));

const { query, withTransaction } = await import('./db.js');
const {
  authenticateApplicationToken,
  createApplication,
  revokeApplication,
} = await import('./applicationService.js');

beforeEach(() => {
  query.mockReset();
  withTransaction.mockReset();
  process.env.APPLICATION_KEY_PEPPER = 'test-application-pepper';
});

describe('application credentials', () => {
  it('creates a one-time mf_sk token and authenticates it from the stored hash', async () => {
    let storedHash;
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({
          rows: [{
            id: 'app-1', name: 'MCP', description: '',
            permissions: ['email.search', 'email.read'],
            created_at: new Date('2026-01-01'), last_used_at: null,
          }],
        })
        .mockImplementationOnce(async (_sql, params) => {
          storedHash = params[2];
          return { rows: [] };
        }),
    };
    withTransaction.mockImplementationOnce(fn => fn(client));

    const created = await createApplication({
      userId: 'user-1',
      name: 'MCP',
      permissions: ['email.search', 'email.read'],
    });

    expect(created.token).toMatch(/^mf_sk_[A-Za-z0-9_-]{16}_[A-Za-z0-9_-]{43}$/);
    expect(storedHash).toMatch(/^[a-f0-9]{64}$/);

    query
      .mockResolvedValueOnce({
        rows: [{
          id: 'app-1', user_id: 'user-1', name: 'MCP',
          permissions: ['email.search', 'email.read'],
          credential_id: 'credential-1', secret_hash: storedHash,
        }],
      })
      .mockResolvedValueOnce({ rows: [] });

    await expect(authenticateApplicationToken(created.token)).resolves.toEqual({
      id: 'app-1', userId: 'user-1', name: 'MCP', permissions: ['email.search', 'email.read'],
    });
  });

  it('rejects unknown permissions before writing to the database', async () => {
    await expect(createApplication({
      userId: 'user-1',
      name: 'Dangerous app',
      permissions: ['admin.root'],
    })).rejects.toMatchObject({ status: 400 });
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it('revokes only an application owned by the current user', async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ id: 'app-1' }] })
        .mockResolvedValueOnce({ rows: [] }),
    };
    withTransaction.mockImplementationOnce(fn => fn(client));

    await expect(revokeApplication({ userId: 'user-1', applicationId: 'app-1' })).resolves.toBe(true);
    expect(client.query.mock.calls[0][1]).toEqual(['app-1', 'user-1']);
  });
});
