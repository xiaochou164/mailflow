import { describe, expect, it } from 'vitest';

const { ipAllowed } = await import('./applicationAuth.js');

describe('application IP whitelist', () => {
  it('allows requests when no whitelist is configured', () => {
    expect(ipAllowed('203.0.113.10', [])).toBe(true);
    expect(ipAllowed('203.0.113.10', null)).toBe(true);
  });

  it('matches exact IPs and IPv4-mapped addresses', () => {
    expect(ipAllowed('::ffff:203.0.113.10', ['203.0.113.10'])).toBe(true);
    expect(ipAllowed('203.0.113.11', ['203.0.113.10'])).toBe(false);
  });

  it('matches IPv4 CIDR ranges', () => {
    expect(ipAllowed('198.51.100.42', ['198.51.100.0/24'])).toBe(true);
    expect(ipAllowed('198.51.101.42', ['198.51.100.0/24'])).toBe(false);
  });
});
