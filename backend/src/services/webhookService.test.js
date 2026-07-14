import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./encryption.js', () => ({ encrypt: vi.fn(value => `encrypted:${value}`), decrypt: vi.fn(() => 'whsec_test') }));
vi.mock('./safeFetch.js', () => ({ safeFetch: vi.fn() }));

const { query } = await import('./db.js');
const { safeFetch } = await import('./safeFetch.js');
const {
  createWebhook,
  enqueueWebhookEvent,
  processWebhookQueueOnce,
} = await import('./webhookService.js');

beforeEach(() => {
  query.mockReset();
  safeFetch.mockReset();
});

describe('webhookService', () => {
  it('creates an encrypted webhook secret and only returns plaintext once', async () => {
    query.mockResolvedValueOnce({ rows: [{
      id: 'webhook-1', user_id: 'user-1', name: 'n8n', url: 'https://hooks.example.com/mail',
      events: ['email.received'], enabled: true, created_at: new Date(),
    }] });
    const result = await createWebhook({
      userId: 'user-1', name: 'n8n', url: 'https://hooks.example.com/mail', events: ['email.received'],
    });
    expect(result.secret).toMatch(/^whsec_/);
    expect(result.webhook).not.toHaveProperty('secret');
    expect(query.mock.calls[0][1][4]).toMatch(/^encrypted:whsec_/);
  });

  it('enqueues an event for every matching enabled webhook', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'delivery-1' }, { id: 'delivery-2' }] });
    await expect(enqueueWebhookEvent({ userId: 'user-1', event: 'email.sent', payload: { id: 'message-1' } })).resolves.toBe(2);
    expect(query.mock.calls[0][0]).toContain('$2::text');
  });

  it('signs and completes a queued delivery', async () => {
    query
      .mockResolvedValueOnce({ rows: [{
        id: 'delivery-1', webhook_id: 'webhook-1', event: 'webhook.test', payload: { ok: true },
        created_at: new Date(), attempt_count: 1, url: 'https://hooks.example.com/mail',
        secret_encrypted: 'encrypted', user_id: 'user-1',
      }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    safeFetch.mockResolvedValueOnce({ ok: true, status: 204, text: vi.fn().mockResolvedValue('') });
    await expect(processWebhookQueueOnce()).resolves.toBe(true);
    expect(safeFetch).toHaveBeenCalledWith(
      'https://hooks.example.com/mail',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'X-MailFlow-Signature': expect.stringMatching(/^v1=/) }),
      }),
      expect.any(Object),
    );
    expect(query.mock.calls[1][0]).toContain("status = 'succeeded'");
  });
});
