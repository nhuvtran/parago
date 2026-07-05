// Pure builders for the Telegram Bot API. No network here; the Edge Function does
// the fetch with the returned object. Plain text only (no parse_mode), so there is
// no markup injection. But the caption is newline-joined, so untrusted strings
// (item titles, guardianName, all attacker-influenceable via the public endpoint)
// are stripped of newlines and control/bidi chars first: without that, a title
// like "Widget\nTotal: $2.00" would forge a second total line and mislead the
// guardian's approval decision.

function fmtMoney(n) {
  return (typeof n === 'number' && Number.isFinite(n)) ? '$' + n.toFixed(2) : '';
}

// Replace newlines and control/bidi-override chars with a space so untrusted text
// cannot inject or reorder lines in the plain-text approval message. Stripped:
// C0 controls (incl. \n, \r), DEL, line/paragraph separators, and bidi overrides.
function clean(s) {
  let out = '';
  for (const ch of String(s == null ? '' : s)) {
    const c = ch.codePointAt(0);
    const bad = c < 0x20 || c === 0x7f || c === 0x2028 || c === 0x2029 || (c >= 0x202a && c <= 0x202e);
    out += bad ? ' ' : ch;
  }
  // Also strip Amazon's hidden "Opens in a new tab" link text that older captures may
  // still carry, and collapse whitespace, so it never shows in the approval message.
  return out
    .replace(/\s+/g, ' ')
    .replace(/\(?\s*opens?\s+in\s+(?:a\s+)?new\s+(?:tab|window)\s*\)?\.?/ig, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Un-stick a delivery line and drop a leading badge word: "OvernightFREE delivery
// Overnight 4 AM - 8 AM" -> "FREE delivery Overnight 4 AM - 8 AM".
function cleanDelivery(s) {
  s = clean(s).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').trim();
  const m = s.match(/(?:FREE\s+)?delivery\b.*/i) || s.match(/(?:Arrives|Get it)\b.*/i);
  return (m ? m[0] : s).replace(/\s*(?:on \$[\d.,]+ of qualifying items|FREE Returns|Order within).*$/i, '').trim();
}

// Lead with the date/window, THEN Free or the price: "Tuesday, July 7 · Free" or
// "Overnight 4 AM - 8 AM · $6.99" (not "FREE delivery ...").
function formatDelivery(s) {
  s = cleanDelivery(s);
  if (!s) return '';
  const free = /\bFREE\b/i.test(s);
  const costM = s.match(/\$[\d.,]+/);
  const when = s.replace(/\bFREE\b/ig, '').replace(/\bdelivery\b/ig, '').replace(/\$[\d.,]+/g, '')
    .replace(/\s{2,}/g, ' ').replace(/^[\s.,-]+|[\s.,-]+$/g, '').trim();
  const cost = free ? 'Free' : (costM ? costM[0] : '');
  return cost ? `${when} · ${cost}` : when;
}

// A usable product photo (not a loading spinner / placeholder). Amazon serves the
// real image under /images/I/ and its cart spinner under /images/G/…loading-large.gif;
// reject the latter (and data: / .gif) so a stale capture never leads with a spinner.
function isProductPhoto(u) {
  if (typeof u !== 'string' || !/^https?:\/\//i.test(u)) return false;
  return !/\/images\/G\/|loading|spinner|grey-pixel|transparent|\.gif(?:$|\?)/i.test(u);
}

// Star/rating line, mirroring the email + approve.html rendering. Empty when the
// rating is not a finite number; omits the count when reviewCount is missing.
function stars(rating, reviewCount) {
  if (rating == null) return '';
  const r = Number(rating);
  if (!Number.isFinite(r)) return '';
  const cr = Math.max(0, Math.min(5, r)); // clamp: request-body ratings are unvalidated
  const r2 = Math.round(cr * 2) / 2;
  const full = Math.floor(r2);
  const half = (r2 - full) === 0.5;
  const empty = 5 - full - (half ? 1 : 0);
  const s = '★'.repeat(full) + (half ? '½' : '') + '☆'.repeat(empty);
  const rc = Number(reviewCount);
  const count = (reviewCount != null && Number.isFinite(rc)) ? ` (${rc.toLocaleString()})` : '';
  return `${s} ${cr.toFixed(1)}${count}`;
}

const MAX_ITEMS_IN_CAPTION = 8;
const CAPTION_LIMIT = 1024; // Telegram sendPhoto caption hard limit

// Build the sendPhoto (or sendMessage) call for one approval request. Leads with a
// product photo when an item has an http(s) image; the "See full details" button
// opens approve.html for the full, rich, tap-through-to-Amazon view. Approve/Reject
// are inline callback buttons carrying the single-use token.
// notifyOnly = true builds a buttonless heads-up ("a purchase went through") for orders
// that did NOT need approval — no Approve/Reject, no "See full details", no token.
export function buildTelegramMessage({ chatId, total, items, link, token, notifyOnly = false }) {
  const list = Array.isArray(items) ? items : [];
  const totalStr = fmtMoney(total);

  // No approver name, no "tap the buttons" line (the buttons are right there). Items
  // are numbered, one per block, with an indented price/qty/rating line, so a large
  // cart stays readable. The "See full details" button carries images + full info.
  const shown = list.slice(0, MAX_ITEMS_IN_CAPTION);
  const parts = [notifyOnly ? 'A purchase went through (no approval needed).' : 'A purchase needs your approval.'];
  if (totalStr) parts.push('', `Total: ${totalStr}`);
  parts.push('');
  shown.forEach((it, i) => {
    const o = it || {};
    const title = clean(o.title) || 'Item';
    const qtyNum = Number(o.qty);
    const qty = (Number.isFinite(qtyNum) && qtyNum > 1) ? qtyNum : 1;
    const price = (typeof o.price === 'number') ? fmtMoney(o.price) : '';
    const meta = stars(o.rating, o.reviewCount);
    parts.push(`${i + 1}. ${title}`);
    const detail = [price && (qty > 1 ? `${price} ×${qty}` : price), meta].filter(Boolean).join('    ');
    if (detail) parts.push(`    ${detail}`);
    if (typeof o.delivery === 'string' && o.delivery) { const dv = formatDelivery(o.delivery); if (dv) parts.push(`    ${dv}`); }
  });
  const extra = list.length - shown.length;
  if (extra > 0) parts.push('', `+${extra} more item${extra > 1 ? 's' : ''}`);

  let text = parts.join('\n');
  if (text.length > CAPTION_LIMIT) text = text.slice(0, CAPTION_LIMIT - 3) + '...';

  // Buttonless in notify-only mode; otherwise Approve/Reject + See full details.
  const reply_markup = notifyOnly ? null : {
    inline_keyboard: [
      [{ text: 'Approve', callback_data: 'a:' + token }, { text: 'Reject', callback_data: 'r:' + token }],
      [{ text: 'See full details', url: link }],
    ],
  };
  const withMarkup = (payload) => (reply_markup ? { ...payload, reply_markup } : payload);

  // One photo per item that has a usable product image (Telegram media group: 2..10).
  const photos = shown.map((it) => it && it.image).filter(isProductPhoto).slice(0, 10);

  // Returns an ordered list of Bot API calls the Edge Function sends in sequence.
  // A media group cannot carry inline buttons, so for 2+ photos we send the album
  // first and then a separate text message that holds the details (+ buttons if any).
  if (photos.length >= 2) {
    return {
      sends: [
        { method: 'sendMediaGroup', payload: { chat_id: chatId, media: photos.map((url) => ({ type: 'photo', media: url })) } },
        { method: 'sendMessage', payload: withMarkup({ chat_id: chatId, text, disable_web_page_preview: true }) },
      ],
    };
  }
  if (photos.length === 1) {
    return { sends: [{ method: 'sendPhoto', payload: withMarkup({ chat_id: chatId, photo: photos[0], caption: text }) }] };
  }
  return { sends: [{ method: 'sendMessage', payload: withMarkup({ chat_id: chatId, text, disable_web_page_preview: true }) }] };
}

// Inline-button callback_data is 'a:<token>' (approve) or 'r:<token>' (reject).
// Returns { verdict, token } or null. Kept short to stay under Telegram's 64-byte
// callback_data limit.
export function parseCallbackData(data) {
  const s = String(data || '');
  const i = s.indexOf(':');
  if (i < 0) return null;
  const prefix = s.slice(0, i);
  const token = s.slice(i + 1);
  if (!token) return null;
  if (prefix === 'a') return { verdict: 'approved', token };
  if (prefix === 'r') return { verdict: 'rejected', token };
  if (prefix === 'u') return { verdict: 'undo', token };
  return null;
}
