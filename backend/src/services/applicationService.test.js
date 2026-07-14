import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
}));

const { query, withTransaction } = await import('./db.js');
const {
  authenticateApplicationToken,
  createApplication,
  rotateApplicationToken,
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
            allowed_ips: null, audit_retention_days: 90, redact_content: false,
            created_at: new Date('2026-01-01'), last_used_at: null, expires_at: new Date('2026-12-31T23:59:59.999Z'),
          }],
        })
        .mockImplementationOnce(async (_sql, params) => {
          storedHash = params[2];
          expect(params[3]).toBe('2026-12-31T23:59:59.999Z');
          return { rows: [] };
        }),
    };
    withTransaction.mockImplementationOnce(fn => fn(client));

    const created = await createApplication({
      userId: 'user-1',
      name: 'MCP',
      permissions: ['email.search', 'email.read'],
      expiresAt: '2026-12-31',
    });

    expect(created.token).toMatch(/^mf_sk_[A-Za-z0-9_-]{16}_[A-Za-z0-9_-]{43}$/);
    expect(storedHash).toMatch(/^[a-f0-9]{64}$/);

    query
      .mockResolvedValueOnce({
        rows: [{
          id: 'app-1', user_id: 'user-1', name: 'MCP',
          permissions: ['email.search', 'email.read'],
          allowed_ips: null, audit_retention_days: 90, redact_content: false,
          credential_id: 'credential-1', secret_hash: storedHash,
          expires_at: new Date('2026-12-31T23:59:59.999Z'),
        }],
      })
      .mockResolvedValueOnce({ rows: [] });

    await expect(authenticateApplicationToken(created.token)).resolves.toEqual({
      id: 'app-1', userId: 'user-1', name: 'MCP', permissions: ['email.search', 'email.read'],
      accountIds: [], folders: [], allowedIps: [], auditRetentionDays: 90, redactContent: false,
    });
    expect(query.mock.calls[0][0]).toContain('c.expires_at > NOW()');
  });

  it('stores account and folder scopes after validating account ownership', async () => {
    const accountId = '11111111-1111-4111-8111-111111111111';
    query.mockResolvedValueOnce({ rows: [{ id: accountId }] });
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({
          rows: [{
            id: 'app-1', name: 'Scoped MCP', description: '',
            permissions: ['email.search'], account_ids: [accountId], folders: ['INBOX'],
            allowed_ips: ['203.0.113.10', '198.51.100.0/24'], audit_retention_days: 30, redact_content: true,
            created_at: new Date('2026-01-01'), last_used_at: null,
          }],
        })
        .mockResolvedValueOnce({ rows: [] }),
    };
    withTransaction.mockImplementationOnce(fn => fn(client));

    const created = await createApplication({
      userId: 'user-1',
      name: 'Scoped MCP',
      permissions: ['email.search'],
      accountIds: [accountId, accountId],
      folders: ['INBOX', 'INBOX', ''],
      allowedIps: ['203.0.113.10', '198.51.100.0/24'],
      auditRetentionDays: 30,
      redactContent: true,
    });

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('email_accounts'),
      ['user-1', [accountId]]
    );
    expect(client.query.mock.calls[0][1]).toEqual([
      'user-1', 'Scoped MCP', '', ['email.search'], [accountId], ['INBOX'],
      ['203.0.113.10', '198.51.100.0/24'], 30, true,
    ]);
    expect(created.application.accountIds).toEqual([accountId]);
    expect(created.application.folders).toEqual(['INBOX']);
    expect(created.application.allowedIps).toEqual(['203.0.113.10', '198.51.100.0/24']);
    expect(created.application.auditRetentionDays).toBe(30);
    expect(created.application.redactContent).toBe(true);
  });

  it('rejects invalid IP whitelist and audit retention values before writing to the database', async () => {
    await expect(createApplication({
      userId: 'user-1',
      name: 'Bad IP',
      permissions: ['email.search'],
      allowedIps: ['not an ip'],
    })).rejects.toMatchObject({ status: 400 });
    await expect(createApplication({
      userId: 'user-1',
      name: 'Bad retention',
      permissions: ['email.search'],
      auditRetentionDays: 0,
    })).rejects.toMatchObject({ status: 400 });
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it('rejects invalid account scope ids before writing to the database', async () => {
    await expect(createApplication({
      userId: 'user-1',
      name: 'Bad scope',
      permissions: ['email.search'],
      accountIds: ['not-a-uuid'],
    })).rejects.toMatchObject({ status: 400 });
    expect(query).not.toHaveBeenCalled();
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it('rejects account scope ids not owned by the user', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await expect(createApplication({
      userId: 'user-1',
      name: 'Bad scope',
      permissions: ['email.search'],
      accountIds: ['11111111-1111-4111-8111-111111111111'],
    })).rejects.toMatchObject({ status: 400 });
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it('rejects past token expiration dates before writing to the database', async () => {
    await expect(createApplication({
      userId: 'user-1',
      name: 'Expired app',
      permissions: ['email.search'],
      expiresAt: '2000-01-01T00:00:00Z',
    })).rejects.toMatchObject({ status: 400 });
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it('rejects unknown permissions before writing to the database', async () => {
    await expect(createApplication({
      userId: 'user-1',
      name: 'Dangerous app',
      permissions: ['admin.root'],
    })).rejects.toMatchObject({ status: 400 });
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it('rotates an application token and revokes the previous active credential', async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({
          rows: [{
            id: 'app-1', name: 'MCP', description: '',
            permissions: ['email.search'], account_ids: [], folders: [],
            allowed_ips: ['203.0.113.10'], audit_retention_days: 30, redact_content: true,
            created_at: new Date('2026-01-01'), last_used_at: null,
          }],
        })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] }),
    };
    withTransaction.mockImplementationOnce(fn => fn(client));

    const rotated = await rotateApplicationToken({
      userId: 'user-1',
      applicationId: 'app-1',
      expiresAt: '2026-12-31',
    });

    expect(rotated.token).toMatch(/^mf_sk_[A-Za-z0-9_-]{16}_[A-Za-z0-9_-]{43}$/);
    expect(client.query.mock.calls[0][1]).toEqual(['app-1', 'user-1']);
    expect(client.query.mock.calls[1][1]).toEqual(['app-1']);
    expect(client.query.mock.calls[2][1][0]).toBe('app-1');
    expect(client.query.mock.calls[2][1][1]).toHaveLength(16);
    expect(client.query.mock.calls[2][1][2]).toMatch(/^[a-f0-9]{64}$/);
    expect(client.query.mock.calls[2][1][3]).toBe('2026-12-31T23:59:59.999Z');
    expect(rotated.application).toMatchObject({
      id: 'app-1',
      keyPrefix: `mf_sk_${client.query.mock.calls[2][1][1].slice(0, 8)}…`,
      allowedIps: ['203.0.113.10'],
      auditRetentionDays: 30,
      redactContent: true,
    });
  });

  it('returns null when rotating a missing or revoked application', async () => {
    const client = {
      query: vi.fn().mockResolvedValueOnce({ rows: [] }),
    };
    withTransaction.mockImplementationOnce(fn => fn(client));

    await expect(rotateApplicationToken({
      userId: 'user-1',
      applicationId: 'missing-app',
      expiresAt: null,
    })).resolves.toBeNull();
    expect(client.query).toHaveBeenCalledTimes(1);
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
