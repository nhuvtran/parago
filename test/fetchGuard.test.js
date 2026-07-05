import { describe, it, expect } from 'vitest';
import { isAllowedFetchOrigin } from '../src/relay/selectRelay.js';

// Guards the background parago_fetch proxy. If this predicate ever loosens, the
// worker becomes an open, credential-capable cross-origin fetch proxy.
const BASE = 'https://ref.functions.supabase.co';

describe('isAllowedFetchOrigin', () => {
  it('allows the exact configured origin (any path/query)', () => {
    expect(isAllowedFetchOrigin(`${BASE}/create-request`, BASE)).toBe(true);
    expect(isAllowedFetchOrigin(`${BASE}/get-status?id=req_1`, BASE)).toBe(true);
  });

  it('blocks a different origin', () => {
    expect(isAllowedFetchOrigin('https://evil.com/steal', BASE)).toBe(false);
    expect(isAllowedFetchOrigin('https://www.amazon.com/dp/X', BASE)).toBe(false);
  });

  it('blocks a lookalike host suffix (exact origin, not endsWith)', () => {
    expect(isAllowedFetchOrigin('https://ref.functions.supabase.co.evil.com/x', BASE)).toBe(false);
  });

  it('blocks non-https schemes', () => {
    expect(isAllowedFetchOrigin('http://ref.functions.supabase.co/x', BASE)).toBe(false);
    expect(isAllowedFetchOrigin('file:///etc/passwd', BASE)).toBe(false);
  });

  it('fails closed on garbage / relative URLs / empty base', () => {
    expect(isAllowedFetchOrigin('not a url', BASE)).toBe(false);
    expect(isAllowedFetchOrigin('/create-request', BASE)).toBe(false);
    expect(isAllowedFetchOrigin(`${BASE}/x`, '')).toBe(false);
  });
});
