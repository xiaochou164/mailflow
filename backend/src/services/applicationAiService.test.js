import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({
  query: vi.fn(),
}));

vi.mock('./encryption.js', () => ({
  decrypt: vi.fn(value => `dec:${value}`),
}));

const { query } = await import('./db.js');
const {
  analyzeThreadEmails,
  buildDailyDigestPrompt,
  buildDailyDigestSearchQuery,
  buildThreadInsightsPrompt,
  buildThreadSummaryPrompt,
  exportThreadMarkdown,
  summarizeDailyDigestEmails,
  summarizeThreadEmails,
} = await import('./applicationAiService.js');

beforeEach(() => {
  query.mockReset();
  vi.unstubAllGlobals();
});

describe('applicationAiService', () => {
  it('builds a bounded prompt from thread text and attachment metadata', () => {
    const prompt = buildThreadSummaryPrompt([{
      date: '2026-07-14T10:00:00Z',
      from: { name: 'Alex', email: 'alex@example.com' },
      to: [{ name: 'Sam', email: 'sam@example.com' }],
      subject: 'Launch plan',
      text: 'Please review the plan by Friday.',
      attachments: [{ filename: 'plan.pdf' }],
    }]);

    expect(prompt).toContain('Message 1');
    expect(prompt).toContain('Launch plan');
    expect(prompt).toContain('plan.pdf');
    expect(prompt).toContain('Action items');
    expect(prompt.length).toBeLessThanOrEqual(18_000);
  });

  it('builds a structured insight prompt', () => {
    const prompt = buildThreadInsightsPrompt([{ text: 'Can you reply by Friday?' }]);
    expect(prompt).toContain('Return only valid JSON');
    expect(prompt).toContain('replySuggestions');
    expect(prompt).toContain('risks');
  });

  it('builds a bounded daily digest search query and prompt', () => {
    const search = buildDailyDigestSearchQuery('2026-07-14');
    expect(search).toMatchObject({
      date: '2026-07-14',
      query: 'after:2026-07-14 before:2026-07-15 in:all',
    });

    const scopedSearch = buildDailyDigestSearchQuery('2026-07-14', { allFolders: false });
    expect(scopedSearch.query).toBe('after:2026-07-14 before:2026-07-15');

    const prompt = buildDailyDigestPrompt([{
      date: '2026-07-14T10:00:00Z',
      accountName: 'Work',
      folder: 'INBOX',
      from: { name: 'Alex', email: 'alex@example.com' },
      subject: 'Launch plan',
      snippet: 'Please review the plan by Friday.',
      isRead: false,
      hasAttachments: true,
    }], '2026-07-14');

    expect(prompt).toContain('Create a daily email digest for 2026-07-14');
    expect(prompt).toContain('Needs reply');
    expect(prompt).toContain('Launch plan');
    expect(prompt.length).toBeLessThanOrEqual(16_000);
  });

  it('exports a thread as Obsidian-friendly Markdown', () => {
    const markdown = exportThreadMarkdown([{
      threadId: 'thread-1',
      date: '2026-07-14T10:00:00Z',
      folder: 'INBOX',
      from: { name: 'Alex', email: 'alex@example.com' },
      to: [{ email: 'sam@example.com' }],
      subject: 'Launch plan',
      text: 'Please review the plan.',
      attachments: [{ filename: 'plan.pdf' }],
    }], 'thread-1');

    expect(markdown).toContain('mailflow_thread_id: "thread-1"');
    expect(markdown).toContain('# Launch plan');
    expect(markdown).toContain('plan.pdf');
    expect(markdown).toContain('Please review the plan.');
  });

  it('rejects when summarization is disabled for the configured provider', async () => {
    query.mockResolvedValueOnce({
      rows: [{ value: JSON.stringify({ enabled: true, baseUrl: 'http://ai', model: 'm', features: { summarize: false } }) }],
    });

    await expect(summarizeThreadEmails([{ text: 'hello' }])).rejects.toMatchObject({
      status: 503,
      message: 'AI summarization is disabled',
    });
  });

  it('calls the configured provider and returns a thread summary', async () => {
    query.mockResolvedValueOnce({
      rows: [{ value: JSON.stringify({ enabled: true, baseUrl: 'http://ai', model: 'm', apiKey: 'secret' }) }],
    });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'Summary text' } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(summarizeThreadEmails([{ text: 'hello', from: { email: 'a@example.com' } }]))
      .resolves.toEqual({ summary: 'Summary text', messageCount: 1 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('http://ai/chat/completions');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer dec:secret');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      model: 'm',
      stream: false,
      think: false,
    });
  });

  it('returns an empty daily digest without calling the provider', async () => {
    await expect(summarizeDailyDigestEmails([], '2026-07-14')).resolves.toEqual({
      date: '2026-07-14',
      summary: '## Executive summary\n\nNo matching emails were found for 2026-07-14.',
      emailCount: 0,
    });
    expect(query).not.toHaveBeenCalled();
  });

  it('calls the configured provider and returns a daily digest', async () => {
    query.mockResolvedValueOnce({
      rows: [{ value: JSON.stringify({ enabled: true, baseUrl: 'http://ai', model: 'm' }) }],
    });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: '## Executive summary\n\nThree important emails.' } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await summarizeDailyDigestEmails([{
      subject: 'Launch',
      snippet: 'Please review by Friday.',
      from: { email: 'alex@example.com' },
    }], '2026-07-14');

    expect(result).toMatchObject({
      date: '2026-07-14',
      emailCount: 1,
      summary: '## Executive summary\n\nThree important emails.',
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).max_tokens).toBe(1100);
  });

  it('calls the configured provider and returns structured thread insights', async () => {
    query.mockResolvedValueOnce({
      rows: [{ value: JSON.stringify({ enabled: true, baseUrl: 'http://ai', model: 'm' }) }],
    });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        summary: 'Needs review',
        replySuggestions: ['I will review by Friday.'],
        labels: ['launch'],
        tasks: [{ owner: 'Sam', task: 'Review plan', dueDate: 'Friday' }],
        dates: [{ date: 'Friday', meaning: 'review deadline' }],
        risks: [{ severity: 'medium', reason: 'deadline' }],
        important: true,
        importanceReason: 'Deadline mentioned',
        needsReply: true,
        needsReplyReason: 'Asked for review',
        contacts: [{ email: 'alex@example.com', context: 'requester' }],
      }) } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await analyzeThreadEmails([{ text: 'Please review by Friday.', from: { email: 'alex@example.com' } }]);

    expect(result.messageCount).toBe(1);
    expect(result.insights).toMatchObject({
      summary: 'Needs review',
      important: true,
      needsReply: true,
    });
    expect(result.insights.tasks).toHaveLength(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).max_tokens).toBe(1500);
  });
});
