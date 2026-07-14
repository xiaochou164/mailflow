import { describe, expect, it } from 'vitest';

import { redactPayload, redactSensitiveText } from './contentRedaction.js';

describe('contentRedaction', () => {
  it('redacts common sensitive content in text', () => {
    const text = 'Email alex@example.com or +1 (415) 555-1212 with card 4242 4242 4242 4242 and token mf_sk_abcdefghijklmnop_abcdefghijklmnopqrstuvwxyzABCDE12';

    expect(redactSensitiveText(text)).toBe(
      'Email [redacted-email] or [redacted-phone] with card [redacted-number] and token [redacted-token]'
    );
  });

  it('recursively redacts payload strings without changing non-string values', () => {
    expect(redactPayload({
      subject: 'Invoice for sam@example.com',
      nested: [{ body: 'Call 415-555-1212', count: 2, ok: true }],
    })).toEqual({
      subject: 'Invoice for [redacted-email]',
      nested: [{ body: 'Call [redacted-phone]', count: 2, ok: true }],
    });
  });
});
