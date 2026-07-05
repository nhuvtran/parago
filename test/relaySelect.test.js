import { describe, it, expect } from 'vitest';
import { shouldUseSupabase, resolveFunctionsBaseUrl } from '../src/relay/selectRelay.js';

describe('shouldUseSupabase', () => {
  const cfg = { functionsBaseUrl: 'https://x.functions.supabase.co' };
  it('true when a base URL and guardian email are both present', () => {
    expect(shouldUseSupabase({ guardianEmail: 'h@e.com' }, cfg)).toBe(true);
  });
  it('false when guardian email is empty (fall back to local MockRelay)', () => {
    expect(shouldUseSupabase({ guardianEmail: '' }, cfg)).toBe(false);
  });
  it('false when the base URL is the unreplaced placeholder', () => {
    expect(shouldUseSupabase({ guardianEmail: 'h@e.com' }, { functionsBaseUrl: 'https://<PROJECT_REF>.functions.supabase.co' })).toBe(false);
  });

  // The in-extension Options field lets a machine be pointed at a project without
  // editing code; a value there overrides the baked config.js default.
  it('true from the Options field (settings.functionsBaseUrl) even when config is a placeholder', () => {
    const settings = { guardianEmail: 'h@e.com', functionsBaseUrl: 'https://ref.functions.supabase.co' };
    expect(shouldUseSupabase(settings, { functionsBaseUrl: 'https://<PROJECT_REF>.functions.supabase.co' })).toBe(true);
  });
  it('false when the Options field holds a malformed URL (fails safe, no fetch)', () => {
    const settings = { guardianEmail: 'h@e.com', functionsBaseUrl: 'not a url' };
    expect(shouldUseSupabase(settings, cfg)).toBe(false);
  });

  // Delivery method: round one only 'email' has a transport. A telegram selection
  // must not use the email relay; the call site falls back to local popup approval.
  it('email is the default method: absent deliveryMethod behaves as email', () => {
    expect(shouldUseSupabase({ guardianEmail: 'h@e.com' }, cfg)).toBe(true);
  });
  it('true when deliveryMethod is explicitly email', () => {
    expect(shouldUseSupabase({ deliveryMethod: 'email', guardianEmail: 'h@e.com' }, cfg)).toBe(true);
  });
  it('telegram: true only once linked (else fall back to popup)', () => {
    expect(shouldUseSupabase({ deliveryMethod: 'telegram', telegramLinked: false }, cfg)).toBe(false);
    expect(shouldUseSupabase({ deliveryMethod: 'telegram', telegramLinked: true }, cfg)).toBe(true);
  });
  it('telegram ignores guardianEmail: an email without a link does not enable remote', () => {
    expect(shouldUseSupabase({ deliveryMethod: 'telegram', guardianEmail: 'h@e.com', telegramLinked: false }, cfg)).toBe(false);
  });
});

describe('resolveFunctionsBaseUrl', () => {
  it('prefers the Options field over config and trims a trailing slash', () => {
    const settings = { functionsBaseUrl: 'https://ref.functions.supabase.co/' };
    expect(resolveFunctionsBaseUrl(settings, { functionsBaseUrl: 'https://baked.functions.supabase.co' }))
      .toBe('https://ref.functions.supabase.co');
  });
  it('falls back to config when the Options field is blank', () => {
    expect(resolveFunctionsBaseUrl({ functionsBaseUrl: '   ' }, { functionsBaseUrl: 'https://baked.functions.supabase.co' }))
      .toBe('https://baked.functions.supabase.co');
  });
  it('returns empty string when neither is set', () => {
    expect(resolveFunctionsBaseUrl({}, {})).toBe('');
  });
  it('normalizes a pasted project URL to the Edge Functions URL', () => {
    expect(resolveFunctionsBaseUrl({ functionsBaseUrl: 'https://ref123.supabase.co' }, {}))
      .toBe('https://ref123.functions.supabase.co');
  });
  it('leaves an already-correct functions URL unchanged', () => {
    expect(resolveFunctionsBaseUrl({ functionsBaseUrl: 'https://ref123.functions.supabase.co' }, {}))
      .toBe('https://ref123.functions.supabase.co');
  });
});
