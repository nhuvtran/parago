// Defensive parsing of one Amazon search-result card.
// Amazon markup varies; prefer aria-labels + regex, fall back to class names.

const STARS_RE = /(?<!\d)([0-5](?:\.[0-9])?)\s+out of\s+5\s+stars/i;
const COUNT_STRICT_RE = /^\s*([\d,]+)\s+(?:ratings?|reviews?)\s*$/i;
const COUNT_INLINE_RE = /([\d,]+)\s+(?:ratings?|reviews?)\b/i;
const NUMERIC_ONLY_RE = /^\s*([\d,]+)\s*$/;

function toInt(s) {
  return parseInt(String(s).replace(/,/g, ''), 10);
}

export function parseStars(card) {
  for (const el of card.querySelectorAll('[aria-label]')) {
    const m = (el.getAttribute('aria-label') || '').match(STARS_RE);
    if (m) return parseFloat(m[1]);
  }
  const alt = card.querySelector('.a-icon-alt');
  if (alt) {
    const m = (alt.textContent || '').match(STARS_RE);
    if (m) return parseFloat(m[1]);
  }
  return null;
}

export function parseRatingsCount(card) {
  // 1) Strict aria-label, e.g. "2,431 ratings".
  for (const el of card.querySelectorAll('[aria-label]')) {
    const m = (el.getAttribute('aria-label') || '').match(COUNT_STRICT_RE);
    if (m) return toInt(m[1]);
  }
  // 2) Inline within a longer aria-label, e.g. "4.6 out of 5 stars, 2,431 ratings".
  for (const el of card.querySelectorAll('[aria-label]')) {
    const m = (el.getAttribute('aria-label') || '').match(COUNT_INLINE_RE);
    if (m) return toInt(m[1]);
  }
  // 3) Last-resort element fallback. Only accept text that is purely a number
  //    (reject prices, decimals, percentages) so we never grab an unrelated figure.
  const countEl = card.querySelector(
    '[data-csa-c-content-id*="ratings-count"], a .s-underline-text, span.s-underline-text'
  );
  if (countEl) {
    const text = countEl.textContent || '';
    if (!/[$£€%.]/.test(text)) {
      const m = text.match(NUMERIC_ONLY_RE);
      if (m) return toInt(m[1]);
    }
  }
  return null;
}

export function parseSponsored(card) {
  if (card.querySelector('[data-component-type="s-sponsored-label-text"], .puis-sponsored-label-text')) {
    return true;
  }
  for (const el of card.querySelectorAll('span, a')) {
    if ((el.textContent || '').trim() === 'Sponsored') return true;
  }
  return false;
}

// Prime eligibility shows as a Prime badge/icon in the card. Detection is best-effort:
// the dedicated Prime icon class first, then any element whose aria-label mentions Prime.
// Absence of a badge means "not Prime" (Amazon omits the badge for non-Prime items), so
// this returns a plain boolean rather than null.
export function parsePrime(card) {
  if (card.querySelector('.a-icon-prime, i.a-icon-prime, .s-prime, [aria-label="Amazon Prime"]')) {
    return true;
  }
  for (const el of card.querySelectorAll('[aria-label]')) {
    if (/\bprime\b/i.test(el.getAttribute('aria-label') || '')) return true;
  }
  return false;
}

// The card's current price. `.a-price .a-offscreen` is Amazon's canonical, stable
// price node (the full "$21.15" string for screen readers); fall back to the price
// color attribute. Returns a positive number, or null when no price is shown.
export function parsePrice(card) {
  const el = card.querySelector('.a-price .a-offscreen, [data-a-color="price"] .a-offscreen');
  if (el) {
    const v = parseFloat((el.textContent || '').replace(/[^0-9.]/g, ''));
    if (Number.isFinite(v) && v > 0) return v;
  }
  return null;
}

export function parseCard(card) {
  if (!card) return { asin: null, stars: null, ratingsCount: null, sponsored: false, prime: false, price: null };
  return {
    asin: card.getAttribute('data-asin') || null,
    stars: parseStars(card),
    ratingsCount: parseRatingsCount(card),
    sponsored: parseSponsored(card),
    prime: parsePrime(card),
    price: parsePrice(card),
  };
}
