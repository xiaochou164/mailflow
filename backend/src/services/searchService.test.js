import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));

const { query } = await import('./db.js');
const { searchMessages } = await import('./searchService.js');

beforeEach(() => query.mockReset());

describe('searchMessages application scopes', () => {
  it('returns no messages when an explicit account is outside the application scope', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'account-1' }, { id: 'account-2' }] });

    const result = await searchMessages({
      userId: 'user-1',
      q: 'invoice',
      accountId: 'account-2',
      accountIds: ['account-1'],
    });

    expect(result.messages).toEqual([]);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('returns no messages when an explicit folder is outside the application scope', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'account-1' }] });

    const result = await searchMessages({
      userId: 'user-1',
      q: 'invoice',
      folder: 'Sent',
      folders: ['INBOX'],
    });

    expect(result.messages).toEqual([]);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('adds folder scope to the search query when provided', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'account-1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'message-1' }] });

    const result = await searchMessages({
      userId: 'user-1',
      q: 'invoice',
      accountIds: ['account-1'],
      folders: ['INBOX'],
    });

    expect(result.messages).toEqual([{ id: 'message-1' }]);
    expect(query.mock.calls[1][0]).toContain('m.folder = ANY');
    expect(query.mock.calls[1][1]).toContainEqual(['INBOX']);
  });
});
