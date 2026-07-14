import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./emailReadService.js', () => ({ getEmailForApplication: vi.fn() }));

const { query } = await import('./db.js');
const { getEmailForApplication } = await import('./emailReadService.js');
const {
  getAttachmentForApplication,
  getThreadForApplication,
  listAccountsForApplication,
} = await import('./applicationMailService.js');

beforeEach(() => {
  query.mockReset();
  getEmailForApplication.mockReset();
});

describe('applicationMailService', () => {
  it('lists only the application owner accounts with folders', async () => {
    query.mockResolvedValueOnce({ rows: [{
      id: 'account-1', name: 'Work', email_address: 'me@example.com', color: '#123456',
      protocol: 'imap', enabled: true, last_sync: null, sync_error: null,
      folders: [{ path: 'INBOX', name: 'Inbox' }],
    }] });
    const accounts = await listAccountsForApplication('user-1');
    expect(accounts[0]).toMatchObject({ id: 'account-1', emailAddress: 'me@example.com' });
    expect(accounts[0].folders).toHaveLength(1);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('a.user_id = $1'), ['user-1', null, null]);
  });

  it('passes account and folder scopes when listing accounts', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await listAccountsForApplication('user-1', { accountIds: ['account-1'], folders: ['INBOX'] });
    expect(query.mock.calls[0][1]).toEqual(['user-1', ['account-1'], ['INBOX']]);
  });

  it('loads every deduplicated message in a thread', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'message-1' }, { id: 'message-2' }] });
    getEmailForApplication
      .mockResolvedValueOnce({ id: 'message-1' })
      .mockResolvedValueOnce({ id: 'message-2' });
    const emails = await getThreadForApplication({ userId: 'user-1', threadId: 'thread-1', imapManager: {} });
    expect(emails.map(email => email.id)).toEqual(['message-1', 'message-2']);
    expect(getEmailForApplication).toHaveBeenCalledTimes(2);
  });

  it('applies scopes when loading a thread', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'message-1' }] });
    getEmailForApplication.mockResolvedValueOnce({ id: 'message-1' });
    await getThreadForApplication({
      userId: 'user-1',
      threadId: 'thread-1',
      imapManager: {},
      accountIds: ['account-1'],
      folders: ['INBOX'],
    });
    expect(query.mock.calls[0][1]).toEqual(['user-1', 'thread-1', ['account-1'], ['INBOX']]);
    expect(getEmailForApplication).toHaveBeenCalledWith(expect.objectContaining({
      accountIds: ['account-1'],
      folders: ['INBOX'],
    }));
  });

  it('fetches an owned attachment from IMAP', async () => {
    query.mockResolvedValueOnce({ rows: [{
      uid: 12, folder: 'INBOX', account_id: 'account-1',
      attachments: [{ part: '2', filename: 'report.pdf', type: 'application/pdf', size: 10 }],
    }] });
    const imapManager = { fetchAttachment: vi.fn().mockResolvedValue(Buffer.from('pdf')) };
    const attachment = await getAttachmentForApplication({
      userId: 'user-1', messageId: 'message-1', part: '2', imapManager,
    });
    expect(attachment).toMatchObject({ filename: 'report.pdf', contentType: 'application/pdf', size: 3 });
    expect(imapManager.fetchAttachment).toHaveBeenCalledWith(expect.objectContaining({ account_id: 'account-1' }), 12, 'INBOX', '2');
    expect(query.mock.calls[0][1]).toEqual(['message-1', 'user-1', null, null]);
  });
});
