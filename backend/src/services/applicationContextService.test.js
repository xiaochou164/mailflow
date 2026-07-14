import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./searchService.js', () => ({ searchMessages: vi.fn() }));

const { query } = await import('./db.js');
const { searchMessages } = await import('./searchService.js');
const {
  findSimilarEmailsForApplication,
  getContactHistoryForApplication,
  searchKnowledgeForApplication,
} = await import('./applicationContextService.js');

beforeEach(() => {
  query.mockReset();
  searchMessages.mockReset();
});

describe('applicationContextService', () => {
  it('delegates knowledge search through scoped searchMessages', async () => {
    searchMessages.mockResolvedValueOnce({
      query: 'launch',
      messages: [{
        id: 'message-1',
        thread_id: 'thread-1',
        account_id: 'account-1',
        account_name: 'Work',
        folder: 'INBOX',
        subject: 'Launch plan',
        from_name: 'Alex',
        from_email: 'alex@example.com',
        date: '2026-07-14T10:00:00Z',
        snippet: 'Please review.',
        is_read: false,
        is_starred: true,
        has_attachments: false,
      }],
    });

    const result = await searchKnowledgeForApplication({
      userId: 'user-1',
      q: 'launch',
      accountId: 'account-1',
      folder: 'INBOX',
      limit: 25,
      accountIds: ['account-1'],
      folders: ['INBOX'],
    });

    expect(searchMessages).toHaveBeenCalledWith({
      userId: 'user-1',
      q: 'launch',
      accountId: 'account-1',
      folder: 'INBOX',
      limit: 25,
      offset: 0,
      accountIds: ['account-1'],
      folders: ['INBOX'],
    });
    expect(result.emails[0]).toMatchObject({
      id: 'message-1',
      from: { email: 'alex@example.com' },
      isStarred: true,
    });
  });

  it('returns scoped contact history for from/to/cc matches', async () => {
    query.mockResolvedValueOnce({
      rows: [{
        id: 'message-1',
        thread_id: 'thread-1',
        account_id: 'account-1',
        account_name: 'Work',
        folder: 'INBOX',
        subject: 'Follow up',
        from_name: 'Alex',
        from_email: 'alex@example.com',
        date: '2026-07-14T10:00:00Z',
        snippet: 'Checking in.',
      }],
    });

    const result = await getContactHistoryForApplication({
      userId: 'user-1',
      email: 'Alex@Example.com',
      limit: 10,
      accountIds: ['account-1'],
      folders: ['INBOX'],
    });

    expect(query.mock.calls[0][1]).toEqual(['user-1', ['account-1'], ['INBOX'], 'alex@example.com', 10]);
    expect(query.mock.calls[0][0]).toContain('jsonb_array_elements');
    expect(result.contact.email).toBe('alex@example.com');
    expect(result.emails).toHaveLength(1);
  });

  it('rejects invalid contact email values', async () => {
    await expect(getContactHistoryForApplication({
      userId: 'user-1',
      email: 'not-an-email',
    })).rejects.toMatchObject({ status: 400 });
    expect(query).not.toHaveBeenCalled();
  });

  it('finds similar emails from a scoped seed message', async () => {
    query
      .mockResolvedValueOnce({
        rows: [{
          id: 'seed-1',
          account_id: 'account-1',
          folder: 'INBOX',
          thread_key: 'thread-1',
          subject: 'Launch plan review',
          from_email: 'alex@example.com',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'message-2',
          thread_id: 'thread-2',
          account_id: 'account-1',
          account_name: 'Work',
          folder: 'INBOX',
          subject: 'Launch checklist',
          from_name: 'Alex',
          from_email: 'alex@example.com',
          date: '2026-07-13T10:00:00Z',
          snippet: 'Checklist',
          similarity_score: 5,
        }],
      });

    const result = await findSimilarEmailsForApplication({
      userId: 'user-1',
      messageId: 'seed-1',
      limit: 10,
      accountIds: ['account-1'],
      folders: ['INBOX'],
    });

    expect(query.mock.calls[0][1]).toEqual(['seed-1', 'user-1', ['account-1'], ['INBOX']]);
    expect(query.mock.calls[1][1][6]).toBe('launch plan review');
    expect(result.seed).toMatchObject({ id: 'seed-1', threadId: 'thread-1' });
    expect(result.emails[0].similarityScore).toBe(5);
  });

  it('rejects similar search when the seed is outside scope', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await expect(findSimilarEmailsForApplication({
      userId: 'user-1',
      messageId: 'seed-1',
    })).rejects.toMatchObject({ status: 404 });
  });
});
