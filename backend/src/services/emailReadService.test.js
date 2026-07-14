import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));

const { query } = await import('./db.js');
const { getEmailForApplication } = await import('./emailReadService.js');

beforeEach(() => query.mockReset());

describe('getEmailForApplication', () => {
  it('returns a cached email without opening IMAP', async () => {
    query.mockResolvedValueOnce({
      rows: [{
        id: 'message-1', thread_key: 'thread-1', message_id: '<message@example.com>',
        account_id: 'account-1', account_name: 'Work', account_email: 'me@example.com',
        folder: 'INBOX', subject: 'Status', from_name: 'Alice', from_email: 'alice@example.com',
        to_addresses: [{ email: 'me@example.com' }], cc_addresses: [], reply_to: [],
        date: new Date('2026-01-01'), snippet: 'Cached', is_read: false, is_starred: false,
        body_text: 'Cached body', body_html: '<p>Cached body</p>', attachments: [],
      }],
    });
    const imapManager = { fetchMessageBody: vi.fn(), noteUserActivity: vi.fn() };

    const email = await getEmailForApplication({ userId: 'user-1', messageId: 'message-1', imapManager });

    expect(email.text).toBe('Cached body');
    expect(email.bodySource).toBe('cache');
    expect(imapManager.fetchMessageBody).not.toHaveBeenCalled();
  });

  it('does not expose a message outside the application owner', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await expect(getEmailForApplication({
      userId: 'user-1', messageId: 'message-other', imapManager: {},
    })).rejects.toMatchObject({ status: 404 });
  });
});
