import { describe, it, expect } from 'vitest';
import { DEFAULTS } from '../src/settings/storage.js';
import { SAMPLE_CART } from '../src/content/devSample.js';
import { buildBrevoPayload } from '../supabase/functions/_shared/email.js';

describe('developer mode', () => {
  it('is off by default', () => {
    expect(DEFAULTS.devMode).toBe(false);
  });

  it('telegram is the default delivery method, with telegram config keys present but empty', () => {
    expect(DEFAULTS.deliveryMethod).toBe('telegram');
    expect(DEFAULTS.telegramLinkCode).toBe('');
    expect(DEFAULTS.telegramLinked).toBe(false);
  });

  it('sample cart carries the rich item fields the email/page render', () => {
    expect(SAMPLE_CART.items.length).toBeGreaterThan(0);
    for (const it of SAMPLE_CART.items) {
      expect(typeof it.title).toBe('string');
      expect(typeof it.price).toBe('number');
      expect(typeof it.rating).toBe('number');
      expect(it.url).toMatch(/^https:\/\//);
    }
  });

  it('the test email renders the sample cart richly with no em dash', () => {
    const p = buildBrevoPayload({
      senderEmail: 'noreply@example.com', senderName: 'Parago',
      guardianEmail: 'mom@example.com', guardianName: 'Mom',
      total: SAMPLE_CART.total, items: SAMPLE_CART.items,
      link: 'https://x.functions.supabase.co/decision?token=abc',
    });
    expect(p.subject).toContain('47.98');
    expect(p.subject).not.toContain('—');
    expect(p.htmlContent).not.toContain('—');
    for (const it of SAMPLE_CART.items) {
      expect(p.htmlContent).toContain(it.title);
    }
    // rating line present (star glyph)
    expect(p.htmlContent).toContain('★');
  });
});
