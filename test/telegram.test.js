import { describe, it, expect } from 'vitest';
import { buildTelegramMessage, parseCallbackData } from '../supabase/functions/_shared/telegram.js';

// buildTelegramMessage returns { sends: [{method,payload}, ...] }. The send that
// carries reply_markup is the approval message (Approve/Reject buttons); its caption
// (sendPhoto) or text (sendMessage) is the human-readable body.
const buttonSend = (m) => m.sends.find((s) => s.payload.reply_markup);
const body = (m) => { const b = buttonSend(m); return b.payload.caption ?? b.payload.text; };

describe('buildTelegramMessage', () => {
  const base = {
    chatId: 12345,
    total: 47.98,
    items: [
      { title: 'Anker USB-C Cable', price: 9.99, qty: 1, rating: 4.7, reviewCount: 18432, image: 'https://m.media-amazon.com/images/I/abc.jpg' },
      { title: 'Logitech Mouse', price: 37.99, qty: 1, rating: 4.5, reviewCount: 9210, image: 'https://m.media-amazon.com/images/I/def.jpg' },
    ],
    link: 'https://x.github.io/parago/approve.html?token=TOK',
    guardianName: 'Mom',
    token: 'TOK',
  };

  it('sends a media group with EVERY item image, then the details+buttons message', () => {
    const m = buildTelegramMessage(base);
    expect(m.sends[0].method).toBe('sendMediaGroup');
    expect(m.sends[0].payload.media.map((x) => x.media)).toEqual([
      'https://m.media-amazon.com/images/I/abc.jpg',
      'https://m.media-amazon.com/images/I/def.jpg',
    ]);
    expect(m.sends[1].method).toBe('sendMessage'); // buttons live here (media groups can't carry them)
    expect(buttonSend(m).payload.reply_markup).toBeTruthy();
  });

  it('uses a single sendPhoto (with buttons) when only one item has an image', () => {
    const m = buildTelegramMessage({ ...base, items: [base.items[0]] });
    expect(m.sends).toHaveLength(1);
    expect(m.sends[0].method).toBe('sendPhoto');
    expect(m.sends[0].payload.photo).toBe('https://m.media-amazon.com/images/I/abc.jpg');
    expect(m.sends[0].payload.reply_markup).toBeTruthy();
  });

  it('strips "Opens in a new tab" from titles and skips a loading-spinner image', () => {
    const m = buildTelegramMessage({
      ...base,
      items: [{ title: 'MAREE Batana Oil Opens in a new tab', price: 9.99, image: 'https://m.media-amazon.com/images/G/01/ui/loadIndicators/loading-large.gif' }],
    });
    expect(body(m)).toContain('MAREE Batana Oil');
    expect(body(m)).not.toMatch(/opens in a new tab/i);
    expect(buttonSend(m).method).toBe('sendMessage'); // spinner rejected → no photo
  });

  it('body has the header, total, and item titles, but not the approver name', () => {
    const c = body(buildTelegramMessage({ ...base, guardianName: 'Mom' }));
    expect(c).toContain('A purchase needs your approval.');
    expect(c).not.toContain('Mom');
    expect(c).toContain('47.98');
    expect(c).toContain('Anker USB-C Cable');
    expect(c).toContain('Logitech Mouse');
  });
  it('numbers the items', () => {
    const c = body(buildTelegramMessage(base));
    expect(c).toContain('1. Anker USB-C Cable');
    expect(c).toContain('2. Logitech Mouse');
  });
  it('inline keyboard has approve/reject callbacks and a details url, with plain (no-emoji) labels', () => {
    const kb = buttonSend(buildTelegramMessage(base)).payload.reply_markup.inline_keyboard;
    expect(kb[0][0].callback_data).toBe('a:TOK');
    expect(kb[0][1].callback_data).toBe('r:TOK');
    expect(kb[1][0].url).toBe(base.link);
    expect(kb[0][0].text).toBe('Approve');
    expect(kb[0][1].text).toBe('Reject');
    expect(kb[1][0].text).toBe('See full details');
  });
  it('notifyOnly builds a buttonless heads-up (no Approve/Reject, no See details)', () => {
    const m = buildTelegramMessage({ ...base, notifyOnly: true });
    expect(m.sends.every((s) => !s.payload.reply_markup)).toBe(true); // no buttons on any send
    const text = m.sends.map((s) => s.payload.caption ?? s.payload.text ?? '').join('\n');
    expect(text).toContain('went through');
    expect(text).not.toContain('needs your approval');
  });
  it('falls back to a single sendMessage when no item has an http image', () => {
    const m = buildTelegramMessage({ ...base, items: [{ title: 'No image item', price: 5 }] });
    expect(m.sends).toHaveLength(1);
    expect(m.sends[0].method).toBe('sendMessage');
    expect(m.sends[0].payload.text).toContain('No image item');
  });
  it('omits the total line when total is unknown, with no em dash', () => {
    const c = body(buildTelegramMessage({ ...base, total: null, items: [{ title: 'X' }] }));
    expect(c).not.toContain('Total:');
    expect(c).not.toContain('—');
  });
  it('truncates a long item list and notes the remainder', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ title: 'Item ' + i, price: 1 }));
    expect(body(buildTelegramMessage({ ...base, items: many }))).toContain('+4 more items');
  });
  it('callback_data stays within Telegram 64-byte limit for a real token', () => {
    const realToken = 'a'.repeat(43);
    const kb = buttonSend(buildTelegramMessage({ ...base, token: realToken })).payload.reply_markup.inline_keyboard;
    expect(kb[0][0].callback_data.length).toBeLessThanOrEqual(64);
  });
  it('strips newlines from an item title so it cannot forge a fake total line', () => {
    const c = body(buildTelegramMessage({ ...base, total: 500, items: [{ title: 'Widget\nTotal: $2.00' }] }));
    expect(c).not.toMatch(/\nTotal: \$2\.00/);
    expect(c).toContain('Total: $500.00');
  });
  it('caps the album at 10 photos', () => {
    const items = Array.from({ length: 14 }, (_, i) => ({ title: 'Item ' + i, image: `https://m.media-amazon.com/images/I/p${i}.jpg` }));
    const m = buildTelegramMessage({ ...base, items });
    expect(m.sends[0].method).toBe('sendMediaGroup');
    expect(m.sends[0].payload.media.length).toBeLessThanOrEqual(10);
  });
});

describe('parseCallbackData', () => {
  it('parses approve, reject and undo', () => {
    expect(parseCallbackData('a:TOK')).toEqual({ verdict: 'approved', token: 'TOK' });
    expect(parseCallbackData('r:TOK')).toEqual({ verdict: 'rejected', token: 'TOK' });
    expect(parseCallbackData('u:TOK')).toEqual({ verdict: 'undo', token: 'TOK' });
  });
  it('splits on the first colon only, so a token containing a colon survives', () => {
    expect(parseCallbackData('a:to:ken')).toEqual({ verdict: 'approved', token: 'to:ken' });
  });
  it('rejects junk, missing token, or a bad prefix', () => {
    expect(parseCallbackData('x:TOK')).toBeNull();
    expect(parseCallbackData('a:')).toBeNull();
    expect(parseCallbackData('nope')).toBeNull();
    expect(parseCallbackData('')).toBeNull();
  });
});
