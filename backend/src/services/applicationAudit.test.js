import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({
  query: vi.fn(),
}));

const { query } = await import('./db.js');
const {
  acknowledgeApplicationSecurityAlert,
  listApplicationAuditEvents,
  listApplicationSecurityAlerts,
  pruneApplicationAuditEvents,
  recordApplicationAuditEvent,
  recordApplicationSecurityAlert,
} = await import('./applicationAudit.js');

beforeEach(() => {
  query.mockReset();
});

describe('applicationAudit', () => {
  it('records bounded request metadata without request bodies', async () => {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await recordApplicationAuditEvent({
      userId: 'user-1',
      applicationId: 'app-1',
      method: 'POST',
      path: '/api/v1/emails/:id/reply',
      statusCode: 202,
      durationMs: 12.6,
      ipAddress: '203.0.113.10',
      userAgent: 'MailFlow MCP test',
      retentionDays: 30,
      body: 'must not be persisted',
    });

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0][1]).toEqual([
      'user-1',
      'app-1',
      'POST',
      '/api/v1/emails/:id/reply',
      202,
      13,
      '203.0.113.10',
      'MailFlow MCP test',
    ]);
    expect(query.mock.calls[1][1]).toEqual(['app-1', 30]);
  });

  it('skips writes when no authenticated application is present', async () => {
    await recordApplicationAuditEvent({ userId: 'user-1', method: 'GET' });
    expect(query).not.toHaveBeenCalled();
  });

  it('lists only audit events for an application owned by the current user', async () => {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'event-1',
          method: 'GET',
          path: '/api/v1/emails/:id',
          status_code: 200,
          duration_ms: 8,
          ip_address: '203.0.113.10',
          user_agent: 'client',
          created_at: new Date('2026-07-14T12:00:00Z'),
        }],
      });

    await expect(listApplicationAuditEvents({
      userId: 'user-1',
      applicationId: 'app-1',
      limit: 500,
    })).resolves.toEqual([{
      id: 'event-1',
      method: 'GET',
      path: '/api/v1/emails/:id',
      statusCode: 200,
      durationMs: 8,
      ipAddress: '203.0.113.10',
      userAgent: 'client',
      createdAt: new Date('2026-07-14T12:00:00Z'),
    }]);
    expect(query.mock.calls[0][1]).toEqual(['app-1', 'user-1']);
    expect(query.mock.calls[1][1]).toEqual(['app-1', 'user-1', 200]);
  });

  it('prunes old audit events with a bounded retention window', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await pruneApplicationAuditEvents({ applicationId: 'app-1', retentionDays: 4000 });
    expect(query.mock.calls[0][1]).toEqual(['app-1', 90]);
  });

  it('records a de-duplicated security alert', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'alert-1' }] });

    await expect(recordApplicationSecurityAlert({
      userId: 'user-1',
      applicationId: 'app-1',
      type: 'ip_blocked',
      details: { ipAddress: '203.0.113.10' },
    })).resolves.toBe('alert-1');

    expect(query.mock.calls[0][0]).toContain('WHERE NOT EXISTS');
    expect(query.mock.calls[0][1]).toEqual([
      'user-1',
      'app-1',
      'ip_blocked',
      'high',
      'Application request blocked from IP 203.0.113.10',
      JSON.stringify({ ipAddress: '203.0.113.10' }),
    ]);
  });

  it('creates a rate-limit security alert from audited 429 responses', async () => {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'alert-1' }] });

    await recordApplicationAuditEvent({
      userId: 'user-1',
      applicationId: 'app-1',
      method: 'GET',
      path: '/api/v1/emails/search',
      statusCode: 429,
      durationMs: 4,
    });

    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[2][1][2]).toBe('rate_limited');
  });

  it('creates a client-error spike alert when recent 4xx count crosses the threshold', async () => {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: 10 }] })
      .mockResolvedValueOnce({ rows: [{ id: 'alert-1' }] });

    await recordApplicationAuditEvent({
      userId: 'user-1',
      applicationId: 'app-1',
      method: 'POST',
      path: '/api/v1/send',
      statusCode: 403,
      durationMs: 5,
    });

    expect(query.mock.calls[2][0]).toContain('status_code BETWEEN 400 AND 499');
    expect(query.mock.calls[3][1][2]).toBe('client_error_spike');
    expect(JSON.parse(query.mock.calls[3][1][5]).recentClientErrors).toBe(10);
  });

  it('lists and acknowledges open security alerts for an owned application', async () => {
    query.mockResolvedValueOnce({
      rows: [{
        id: 'alert-1',
        type: 'server_error',
        severity: 'high',
        message: 'Application received a server error on /api/v1/send',
        details: { statusCode: 502 },
        acknowledged_at: null,
        created_at: new Date('2026-07-14T12:00:00Z'),
      }],
    });

    await expect(listApplicationSecurityAlerts({
      userId: 'user-1',
      applicationId: 'app-1',
      limit: 500,
    })).resolves.toEqual([{
      id: 'alert-1',
      type: 'server_error',
      severity: 'high',
      message: 'Application received a server error on /api/v1/send',
      details: { statusCode: 502 },
      acknowledgedAt: null,
      createdAt: new Date('2026-07-14T12:00:00Z'),
    }]);
    expect(query.mock.calls[0][1]).toEqual(['user-1', 'app-1', false, 200]);

    query.mockResolvedValueOnce({ rows: [{ id: 'alert-1' }] });
    await expect(acknowledgeApplicationSecurityAlert({
      userId: 'user-1',
      applicationId: 'app-1',
      alertId: 'alert-1',
    })).resolves.toBe(true);
    expect(query.mock.calls[1][1]).toEqual(['alert-1', 'user-1', 'app-1']);
  });
});
