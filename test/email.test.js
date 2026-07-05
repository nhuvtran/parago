import { describe, it, expect } from 'vitest';
import { buildBrevoPayload } from '../supabase/functions/_shared/email.js';

describe('buildBrevoPayload', () => {
  const opts = {
    senderEmail: 'noreply@example.com',
    senderName: 'Parago',
    guardianEmail: 'helper@example.com',
    guardianName: 'Alex',
    total: 42.5,
    items: [
      {
        title: 'Reading glasses',
        price: 19.99,
        qty: 2,
        rating: 4.7,
        reviewCount: 18432,
        image: 'https://m.media-amazon.com/images/I/abc.jpg',
        url: 'https://www.amazon.com/dp/B00ABC',
      },
      { title: 'Lamp', rating: null, reviewCount: null },
    ],
    link: 'https://x.functions.supabase.co/decision?token=abc',
  };

  it('addresses the guardian and a verified sender', () => {
    const p = buildBrevoPayload(opts);
    expect(p.sender).toEqual({ email: 'noreply@example.com', name: 'Parago' });
    expect(p.to).toEqual([{ email: 'helper@example.com', name: 'Alex' }]);
  });
  it('strips "Opens in a new tab" from titles and drops a spinner image', () => {
    const p = buildBrevoPayload({
      ...opts,
      items: [{ title: 'MAREE Batana Oil Opens in a new tab', price: 9.99, image: 'https://m.media-amazon.com/images/G/01/ui/loadIndicators/loading-large.gif' }],
    });
    expect(p.htmlContent).toContain('MAREE Batana Oil');
    expect(p.htmlContent).not.toMatch(/opens in a new tab/i);
    expect(p.textContent).not.toMatch(/opens in a new tab/i);
    expect(p.subject).not.toMatch(/opens in a new tab/i);
    expect(p.htmlContent).not.toContain('loading-large.gif'); // spinner not emitted as <img>
  });
  it('puts the total in the subject', () => {
    expect(buildBrevoPayload(opts).subject).toContain('42.50');
  });
  it('names the first item and the extra count in the subject', () => {
    const p = buildBrevoPayload(opts);
    expect(p.subject).toContain('Reading glasses'); // first item, so multiple requests are distinguishable
    expect(p.subject).toContain('(+1 more)');       // opts has 2 items
    expect(p.subject).toContain('42.50');
  });
  it('includes the approval link and item titles in the HTML and text', () => {
    const p = buildBrevoPayload(opts);
    expect(p.htmlContent).toContain(opts.link);
    expect(p.htmlContent).toContain('Reading glasses');
    expect(p.textContent).toContain(opts.link);
    expect(p.textContent).toContain('Lamp');
  });
  it('omits the name when guardianName is empty', () => {
    const p = buildBrevoPayload({ ...opts, guardianName: '' });
    expect(p.to).toEqual([{ email: 'helper@example.com' }]);
  });

  it('renders rich item detail: image, linked title, stars, and per-item price', () => {
    const p = buildBrevoPayload(opts);
    // Image src (URL has no special chars, so escaped === raw).
    expect(p.htmlContent).toContain('https://m.media-amazon.com/images/I/abc.jpg');
    // Full title, linked to the product page.
    expect(p.htmlContent).toContain('Reading glasses');
    expect(p.htmlContent).toContain('https://www.amazon.com/dp/B00ABC');
    // Star glyph and/or the numeric rating (avoid asserting locale-formatted count).
    expect(p.htmlContent).toContain('★');
    expect(p.htmlContent).toContain('4.7');
    expect(p.htmlContent).toContain('ratings');
    // Per-item price.
    expect(p.htmlContent).toContain('19.99');
    // textContent fallback carries title, price, and the rating.
    expect(p.textContent).toContain('Reading glasses');
    expect(p.textContent).toContain('19.99');
    expect(p.textContent).toContain('4.7');
  });

  it('omits the rating meta line for an item with rating == null', () => {
    const p = buildBrevoPayload(opts);
    // Only the rated item (Reading glasses) emits a rating meta <div>; Lamp
    // (rating: null) must not. Count the rating divs (the expiry note is a <p>,
    // so it does not collide); a raw '·' count would also catch price separators.
    expect((p.htmlContent.match(/<div style="color:#888;font-size:12px">/g) || []).length).toBe(1);
  });

  it('shows the rating without a count when reviewCount == null', () => {
    const p = buildBrevoPayload({
      ...opts,
      items: [{ title: 'Mug', rating: 4.0, reviewCount: null }],
    });
    expect(p.htmlContent).toContain('4.0');
    // "rating without count": the ` · <n> ratings` separator must be absent.
    expect(p.htmlContent).not.toContain('·');
    expect(p.htmlContent).not.toContain('ratings');
  });

  it('does not throw on a finite but out-of-range rating (clamps to 0..5)', () => {
    // Items come from the request body, validated nowhere; an out-of-range rating
    // must not make star.repeat() negative and crash the whole email build.
    expect(() => buildBrevoPayload({ ...opts, items: [{ title: 'Hi', rating: 1000, reviewCount: 5 }] })).not.toThrow();
    expect(() => buildBrevoPayload({ ...opts, items: [{ title: 'Lo', rating: -3, reviewCount: 5 }] })).not.toThrow();
    const p = buildBrevoPayload({ ...opts, items: [{ title: 'Hi', rating: 1000 }] });
    expect(p.htmlContent).toContain('5.0'); // clamped
  });

  it('escapes a title containing an HTML/script payload (XSS guard)', () => {
    const p = buildBrevoPayload({ ...opts, items: [{ title: '<script>alert(1)</script>' }] });
    expect(p.htmlContent).not.toContain('<script');
    expect(p.htmlContent).toContain('&lt;script&gt;');
  });

  it('does not emit a non-http(s) url as a link href (scheme allowlist)', () => {
    // url comes from the request body; a javascript: scheme has no chars escapeHtml
    // touches, so without a scheme check it would render a clickable js: link.
    const p = buildBrevoPayload({ ...opts, items: [{ title: 'Trap', url: 'javascript:alert(1)' }] });
    expect(p.htmlContent).not.toContain('href="javascript:');
    expect(p.htmlContent).not.toContain('javascript:alert');
    // A normal https url still links.
    const ok = buildBrevoPayload({ ...opts, items: [{ title: 'Good', url: 'https://www.amazon.com/dp/B0' }] });
    expect(ok.htmlContent).toContain('href="https://www.amazon.com/dp/B0"');
  });
});
