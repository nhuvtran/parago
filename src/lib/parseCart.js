// Defensive parsing of an Amazon cart / checkout page: order total + line items.
// Prefer Amazon's accessible price node (.a-offscreen, e.g. "$1,234.56") and known total
// containers; fall back to a label-anchored search. Return null total when unsure (fail closed).

export function parseCurrency(text) {
  if (!text) return null;
  const m = String(text).match(/(\d[\d,]*(?:\.\d{1,2})?)/);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

const TOTAL_CONTAINERS = [
  '#sc-subtotal-amount-activecart',
  '#sc-subtotal-amount-buybox',
  '.grand-total-price',
];

const TOTAL_LABEL_RE = /^\s*(order total|grand total|subtotal)\b/i;

// Amazon's total labels read "Subtotal (3 items): $59.97". Strip the "(N items)"
// count so parseCurrency (which grabs the first digit-run) returns the price, not the
// item count, when reading a whole label row that has no .a-offscreen price node.
function stripItemCount(text) {
  return String(text || '').replace(/\(\s*\d[\d,]*\s*items?\s*\)/ig, ' ');
}

export function parseCartTotal(root = document) {
  // 1) Known total containers; read the accessible price inside if present.
  for (const sel of TOTAL_CONTAINERS) {
    const el = root.querySelector(sel);
    if (el) {
      const off = el.querySelector('.a-offscreen');
      const val = parseCurrency(off ? off.textContent : el.textContent);
      if (val != null) return val;
    }
  }
  // 2) Label-anchored fallback: an element whose text starts with a total label;
  //    read the price from its row.
  for (const el of root.querySelectorAll('span, div, td, th, h2, h4')) {
    if (el.closest(NON_PURCHASE_CONTAINERS)) continue; // ignore "Saved for later" subtotals
    if (TOTAL_LABEL_RE.test(el.textContent || '')) {
      const row = el.closest('tr, li, div') || el.parentElement;
      if (row) {
        const off = row.querySelector('.a-offscreen');
        const val = parseCurrency(off ? off.textContent : stripItemCount(row.textContent));
        if (val != null) return val;
      }
    }
  }
  return null; // fail closed: unknown total
}

const ITEM_SELECTORS = '.sc-list-item[data-asin], [data-asin].sc-list-item, [data-name][data-asin]';
// Title source priority. .a-truncate-full is the single clean, complete title; the
// .sc-product-title anchor wraps it TWICE (a-truncate-full + a-truncate-cut) plus a
// hidden "Opens in a new tab", and a separate image-only .sc-product-link anchor has
// no text at all. A single querySelector with a grouped selector returns whichever
// matches FIRST IN DOCUMENT ORDER (the empty image link), not the first selector — so
// extractTitle() tries these in order and skips any that yield no text.
const TITLE_SELECTOR_ORDER = ['.a-truncate-full', '.sc-product-title', '.a-truncate-cut', 'a.sc-product-link', '.sc-product-link'];
const ITEM_PRICE_SELECTORS = '.sc-product-price, .a-price .a-offscreen';

// A real Amazon product photo. Everything the cart serves for a product lives under
// .../images/I/; spinners, sprites and badges (loading gif, Prime logo, 1px pixels)
// do not, so requiring that path rejects them. Also reject inline data: placeholders.
function isProductImageUrl(u) {
  if (!u || /^data:/i.test(u)) return false;
  return /^https?:\/\//i.test(u) && /(?:media-amazon|images-amazon|ssl-images-amazon)\.com\/images\/I\//i.test(u);
}

// Amazon encodes the requested size in the filename (e.g. ..._AC_AA180_.jpg = 180px).
// The cart only renders a small thumb, so swap the size modifier for a larger square
// (500px) — the guardian gets a crisp photo instead of a blurry 180px thumbnail. A URL
// with no size modifier (already full-size) is left unchanged.
function biggerAmazonImage(u) {
  return u.replace(/\._[^./]*_\.(jpg|jpeg|png|webp)(\?.*)?$/i, '._SL500_.$1');
}

// Candidate URLs for one <img>, most-reliable first. At parse time (document_idle)
// a lazy-loaded img's `src` is often still a spinner/placeholder, while Amazon puts
// the real URL eagerly in data-a-dynamic-image (a JSON map of url->[w,h]) and
// data-old-hires. Read those before src; srcset last.
function imageCandidates(img) {
  const out = [];
  const dyn = img.getAttribute('data-a-dynamic-image');
  if (dyn) { try { for (const k of Object.keys(JSON.parse(dyn))) out.push(k); } catch { /* not JSON */ } }
  const hires = img.getAttribute('data-old-hires'); if (hires) out.push(hires);
  const src = img.getAttribute('src'); if (src) out.push(src);
  const srcset = img.getAttribute('srcset');
  if (srcset) { const last = srcset.split(',').map((s) => s.trim().split(/\s+/)[0]).filter(Boolean).pop(); if (last) out.push(last); }
  return out;
}

// The product photo for a cart line. Try the known product-image element first, then
// any img, and within each take the first candidate that is a real product URL.
function pickImageUrl(node) {
  const imgs = [node.querySelector('img.sc-product-image'), ...node.querySelectorAll('img')].filter(Boolean);
  for (const img of imgs) {
    for (const u of imageCandidates(img)) if (isProductImageUrl(u)) return biggerAmazonImage(u);
  }
  return node.getAttribute('data-image') || null;
}

// Deterministic per-item quantity (feeds snapshot matching; flaky qty causes
// spurious re-approvals). Read explicit markup first, displayed text last; any
// non-positive-integer result falls back to 1.
function parseItemQty(node) {
  const raw =
    node.getAttribute('data-quantity') ||
    node.querySelector('input.sc-quantity-textfield, select[name="quantity"], [name="quantity"]')?.value ||
    node.querySelector('.a-dropdown-prompt')?.textContent ||
    '';
  const m = String(raw).match(/\d+/);
  const n = m ? parseInt(m[0], 10) : NaN;
  return Number.isInteger(n) && n > 0 ? n : 1;
}

// Star rating shown on the cart line, from Amazon's accessible "4.5 out of 5 stars"
// text (a stable, locale-ish phrasing on the star widget). Captured at cart time so
// the guardian sees the review summary on the approval page WITHOUT visiting Amazon
// (which would force a login on their browser). null when absent.
function parseItemRating(node) {
  for (const el of node.querySelectorAll('.a-icon-alt, [aria-label]')) {
    const t = el.getAttribute('aria-label') || el.textContent || '';
    const m = t.match(/([0-5](?:\.\d+)?)\s*out of\s*5\s*stars/i);
    if (m) { const n = parseFloat(m[1]); if (n >= 0 && n <= 5) return n; }
  }
  return null;
}

// Number of ratings, taken only from a product-reviews link's text/label (the most
// reliable source; a bare number could be anything). null when absent.
function parseItemReviewCount(node) {
  const link = node.querySelector('a[href*="product-reviews" i], a[href*="customerreviews" i]');
  if (link) {
    const m = (link.getAttribute('aria-label') || link.textContent || '').replace(/,/g, '').match(/\d{1,7}/);
    if (m) return parseInt(m[0], 10);
  }
  return null;
}

// The delivery line Amazon shows for a cart item ("FREE delivery Thursday, July 10"
// or "FREE delivery Overnight 4 AM - 8 AM"). Select ONLY the single primary-message
// element: broader containers concatenate the Prime badge + returns text with no
// spaces ("OvernightFREE deliveryFREE Returns..."). Whitespace between text nodes is
// forced so adjacent runs never stick together; the "$25 of qualifying items" tail and
// any "FREE Returns"/"Order within" trailer are dropped. null when absent.
function parseDelivery(node) {
  const el = node.querySelector('.udm-primary-delivery-message')
    || node.querySelector('[data-cy="delivery-block"] .udm-primary-delivery-message')
    || node.querySelector('.a-color-success.sc-product-availability + * .udm-primary-delivery-message');
  if (!el) return null;
  // textContent can jam an inline element's text against its neighbour when Amazon omits
  // whitespace; join child text nodes with spaces instead, then normalise.
  let t = '';
  const walk = (n) => {
    for (const c of n.childNodes) {
      if (c.nodeType === 3) t += ' ' + (c.textContent || '');
      else if (c.nodeType === 1) walk(c);
    }
  };
  walk(el);
  t = t.replace(/\s+/g, ' ')
    .replace(/\s*on \$[\d.,]+ of qualifying items.*$/i, '')
    .replace(/\s*FREE Returns.*$/i, '')
    .replace(/\s*Order within.*$/i, '')
    .trim();
  return t ? t.slice(0, 120) : null;
}

// Some delivery promises carry a cutoff ("Order within 3 hrs 20 mins"). Resolve it to
// an ABSOLUTE expiry (now + remaining) so the approval page can count it down and mark
// the slot Expired once it passes. Exported for testing. null when there is no cutoff.
export function parseDeliveryExpiry(text, nowMs) {
  const m = String(text || '').match(/order within\s+(?:(\d+)\s*(?:hours?|hrs?))?\s*(?:(\d+)\s*(?:minutes?|mins?))?/i);
  if (!m || (!m[1] && !m[2])) return null;
  const durMs = ((parseInt(m[1] || '0', 10) * 60) + parseInt(m[2] || '0', 10)) * 60000;
  return durMs > 0 ? nowMs + durMs : null;
}

// The active cart (what's actually being purchased). Amazon's "Saved for later"
// list uses the SAME .sc-list-item[data-asin] markup, so without scoping it would
// count as being in the cart. Prefer parsing inside one of these; fall back to the
// whole doc but still drop anything inside a non-purchase section.
const ACTIVE_CART_CONTAINERS = ['#sc-active-cart', '#activeCartViewForm', '#sc-active-cart-content'];
const NON_PURCHASE_CONTAINERS = '#sc-saved-cart, #saved-for-later';

// Amazon's per-line selection checkbox. A DEselected line stays in the cart and out
// of the subtotal but is NOT being purchased, so only checked lines reach the
// guardian. Amazon's wording/markup for this control varies by cart version, so
// identify it a few ways; a denylist keeps gift/subscribe/delete checkboxes from ever
// being read as the selection control (which would wrongly hide a purchased item).
const SELECTION_LABEL_RE = /for checkout|select\b.*\bitem|select\b.*\bfor\b/i;
const NON_SELECTION_LABEL_RE = /gift|subscribe|save for later|delete|remove|compare|coupon|clip|quantity/i;

// Accessible name of a checkbox: aria-label, aria-labelledby targets, or a wrapping
// <label>. Lowercased for matching.
function checkboxLabel(box) {
  let text = box.getAttribute('aria-label') || '';
  const by = box.getAttribute('aria-labelledby');
  if (by) for (const id of by.split(/\s+/)) { const e = box.ownerDocument.getElementById(id); if (e) text += ' ' + e.textContent; }
  const lbl = box.closest('label'); if (lbl) text += ' ' + lbl.textContent;
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

// The selection control for a line, or null. Amazon's markup for it varies wildly by
// cart version — native <input type=checkbox>, an ARIA checkbox widget, labelled or
// not — so we cast wide: take every checkbox-like control on the line that is NOT a
// denylisted control (gift/subscribe/quantity/delete), then
//   1. prefer one whose label/wrapper clearly marks it as the selector, else
//   2. if the line has exactly ONE such control, treat it as the selector.
// The denylist is the safety net: it stops a non-selection checkbox from ever being
// read as the selector, which would wrongly hide a purchased item.
function selectionCheckbox(node) {
  const boxes = [...node.querySelectorAll('input[type="checkbox"], [role="checkbox"]')]
    .filter((b) => !NON_SELECTION_LABEL_RE.test(checkboxLabel(b)));
  if (!boxes.length) return null;
  for (const b of boxes) {
    if (SELECTION_LABEL_RE.test(checkboxLabel(b)) ||
        b.closest('[class*="sc-list-item-checkbox" i], [class*="item-select" i], [class*="itemselect" i]')) return b;
  }
  return boxes.length === 1 ? boxes[0] : null;
}

// Is this cart LINE positively deselected for checkout? Amazon marks the
// authoritative per-line state on the item node itself (data-isselected="0"/"1"),
// which is reliable across cart versions; its fancy checkbox does NOT track state in
// the native `.checked` property, so trust the attribute first. Only when the
// attribute is absent do we fall back to the selection checkbox (native .checked or
// an ARIA widget's aria-checked). Anything ambiguous counts as selected, so an
// unknown state never hides a purchased item.
function isDeselected(node) {
  if (!node || !node.getAttribute) return false;
  const flag = node.getAttribute('data-isselected');
  if (flag === '1' || flag === 'true') return false;
  if (flag === '0' || flag === 'false') return true;
  const box = selectionCheckbox(node);
  if (!box) return false;
  if (box.tagName === 'INPUT') return box.checked === false;
  return box.getAttribute('aria-checked') === 'false';
}

// The active-cart subtree to parse within (falls back to the whole root).
function activeScope(root) {
  for (const sel of ACTIVE_CART_CONTAINERS) {
    const el = root.querySelector(sel);
    if (el) return el;
  }
  return root;
}

// Amazon wraps product links with visually-hidden screen-reader text such as
// "Opens in a new tab"; textContent picks it up, so it leaks into the title the
// guardian sees (Telegram/email/approve page). Strip it and collapse whitespace.
function cleanTitle(raw) {
  return String(raw || '')
    .replace(/\s+/g, ' ')
    .replace(/\(?\s*opens?\s+in\s+(?:a\s+)?new\s+(?:tab|window)\s*\)?\.?/ig, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// First non-empty cleaned title in priority order (see TITLE_SELECTOR_ORDER), then
// data-name. Skipping empties is what stops the text-less product-image link from
// winning and blanking the title.
function extractTitle(node) {
  for (const sel of TITLE_SELECTOR_ORDER) {
    for (const el of node.querySelectorAll(sel)) {
      const t = cleanTitle(el.textContent);
      if (t) return t;
    }
  }
  return cleanTitle(node.getAttribute('data-name'));
}

// Best-effort: did the shopper mark this line as a gift? True only on a clear signal (a
// checked gift checkbox or explicit "this is/will be a gift" text), so it never
// false-positives into showing "Gift" on a normal item. Selectors are unverified against
// a real gifted cart yet, so keep them conservative.
export function parseItemGift(node) {
  if (!node) return false;
  if (node.querySelector('input[type="checkbox"][name*="gift" i]:checked, input[type="checkbox"][id*="gift" i]:checked, [data-gift="true"], [data-is-gift="true"]')) return true;
  return /\bthis (?:will be|is) a gift\b/i.test(node.textContent || '');
}

// Gifts are set on the CHECKOUT (SPC) page, not the cart, so read them there and match
// back to the cart-snapshot items. Each line item is a container whose gift-options link
// text flips from "Add gift options" to "Change/Edit gift options" once a gift is set.
// Returns the gifted lines keyed by normalized title AND image id (either can match an
// item). Verified against a real gifted checkout (2026-07). Empty off-checkout.
export function parseCheckoutGifts(root = document) {
  const titles = new Set(), imageIds = new Set();
  for (const link of root.querySelectorAll('a[id*="gift-options-link" i]')) {
    if (!/\b(?:change|edit)\b[^<]*gift option/i.test(link.textContent || '')) continue; // "Add..." = not gifted
    const block = link.closest('.lineitem-container, [class*="lineitem" i], .a-box');
    if (!block) continue;
    const titleEl = block.querySelector('[id*="item-primary-title" i], .lineitem-title-text, [class*="title" i]');
    const t = titleEl && titleEl.textContent.replace(/\s+/g, ' ').trim();
    if (t) titles.add(t.toLowerCase());
    const img = block.querySelector('img[src*="/images/I/"]');
    const id = img && ((img.getAttribute('src') || '').match(/\/images\/I\/([^./]+)\./) || [])[1];
    if (id) imageIds.add(id);
  }
  return { titles, imageIds };
}

export function parseCartItems(root = document) {
  const searchRoot = activeScope(root);

  const items = [];
  const seen = new Set();
  for (const node of searchRoot.querySelectorAll(ITEM_SELECTORS)) {
    // Drop "Saved for later" (and similar) even when scoped: defensive if a future
    // layout nests them, and the only guard on the whole-doc fallback path.
    if (node.closest(NON_PURCHASE_CONTAINERS)) continue;
    // Send only what's actually checked out: skip a line ONLY when its selection
    // checkbox is positively unchecked. No checkbox / unknown markup → keep it, so we
    // never hide a real purchase from the guardian.
    if (isDeselected(node)) continue;
    const asin = node.getAttribute('data-asin') || null;
    if (asin && seen.has(asin)) continue;
    if (asin) seen.add(asin);
    const title = extractTitle(node);
    if (!title) continue;

    // Per-item unit price (NOT the cart grand total); null when absent.
    const priceEl = node.querySelector(ITEM_PRICE_SELECTORS);
    const price = priceEl ? parseCurrency(priceEl.textContent) : null;
    const qty = parseItemQty(node);
    const image = pickImageUrl(node);
    const url = asin ? ('https://www.amazon.com/dp/' + asin) : null;
    const rating = parseItemRating(node);
    const reviewCount = parseItemReviewCount(node);
    const delivery = parseDelivery(node);
    const deliveryExpiry = parseDeliveryExpiry(node.textContent, Date.now());
    const gift = parseItemGift(node);
    items.push({ asin, title, price, qty, image, url, rating, reviewCount, delivery, deliveryExpiry, ...(gift ? { gift: true } : {}) });
  }
  return items;
}

// Is any active-cart line explicitly DEselected for checkout? (Its selection
// checkbox is present and unchecked.)
function hasDeselectedLine(root) {
  const scope = activeScope(root);
  for (const node of scope.querySelectorAll(ITEM_SELECTORS)) {
    if (node.closest(NON_PURCHASE_CONTAINERS)) continue;
    if (isDeselected(node)) return true;
  }
  return false;
}

// Sum of unit price × qty over items; null if ANY item lacks a finite price, so the
// caller can keep the page subtotal rather than send a partial (wrong) number.
function sumItemPrices(items) {
  let sum = 0;
  for (const it of items) {
    if (typeof it.price !== 'number' || !Number.isFinite(it.price)) return null;
    const qty = Number.isFinite(it.qty) && it.qty > 0 ? it.qty : 1;
    sum += it.price * qty;
  }
  return Math.round(sum * 100) / 100; // guard against float drift (7.26, not 7.2600001)
}

// The order-summary breakdown from the CHECKOUT page (#subtotals-marketplace-table):
// Items subtotal, Shipping, Tax, fees, promotions/discounts, and Order total — so the
// guardian sees the REAL cost, not just the item subtotal. Each line is a grid of a
// .order-summary-line-term label + a .order-summary-line-definition amount
// ([data-shimmer-target="ordertotals-amount"]). Skips the nested regulatory-fee popover.
// Discounts/promotions (shown with a leading "-") are stored negative. null on the cart
// page (the summary only exists at checkout) or when absent. Exported for testing.
export function parseOrderBreakdown(root = document) {
  const table = root.querySelector('#subtotals-marketplace-table, #subtotals');
  if (!table) return null;
  const out = [];
  const seen = new Set();
  for (const grid of table.querySelectorAll('.order-summary-grid')) {
    if (grid.closest('.a-popover-preload')) continue; // hidden fee-detail popover, not a real line
    const termEl = grid.querySelector('.order-summary-line-term');
    const defEl = grid.querySelector('.order-summary-line-definition');
    if (!termEl || !defEl) continue;
    const labelEl = termEl.querySelector('.break-word') || termEl.querySelector('a') || termEl;
    const label = (labelEl.textContent || '').replace(/\s+/g, ' ').replace(/:\s*$/, '').trim();
    const amtEl = defEl.querySelector('[data-shimmer-target="ordertotals-amount"], .a-offscreen') || defEl;
    const amtText = amtEl.textContent || '';
    let amount = parseCurrency(amtText);
    if (amount == null || !label || label.length > 48) continue;
    if (/-\s*\$?\s*\d/.test(amtText) || /promotion|discount|saving|coupon/i.test(label)) amount = -Math.abs(amount);
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label, amount, total: /order total|grand total/i.test(label) });
    if (out.length >= 12) break;
  }
  return out.length ? out : null;
}

// Partial ship-to + payment from the checkout page, so the guardian sees WHERE it ships
// and WHICH card — never full/sensitive detail. Ship-to is only the "City, ST ZIP" line
// (no street/name); payment is only "CardType ****1234". Best-effort across cart
// variants; null when not found. (Selectors are unverified against a live checkout DOM.)
export function parseCheckoutInfo(root = document) {
  const collapse = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  let payment = null, shipTo = null, shipName = null, shipAddress = null;

  // Amazon renders it as "Paying with <Card> <last4>" (e.g. "Visa 1234") in a
  // .break-word span, sometimes "<Card> ending in 1234" or "<Card> **** 1234". Match a
  // card name, an optional "ending in"/"in"/asterisks, then the last 4.
  const pm = collapse(root.body ? root.body.textContent : root.textContent)
    .match(/\b(Visa|Mastercard|MasterCard|American Express|Amex|Discover|Diners Club|JCB|UnionPay)\b(?:\s+(?:ending(?:\s+in)?|in))?[\s*•·]*(\d{4})\b/i);
  if (pm) payment = collapse(pm[1]).replace(/mastercard/i, 'Mastercard') + ' ••••' + pm[2];

  const addrScope = root.querySelector('#addressList, #shipToInsertionNode, [data-testid*="address" i], [class*="address" i]') || root.body || root;
  const cs = collapse(addrScope.textContent).match(/([A-Z][A-Za-z.\-' ]{1,28}),\s*([A-Z]{2})\s+(\d{5})(?:-\d{4})?\b/);
  if (cs) shipTo = `${cs[1].trim()}, ${cs[2]} ${cs[3]}`;

  // Full recipient + delivery address from the checkout delivery panel. shipName is the
  // "Delivering to <name>" heading (prefix stripped); shipAddress is the address line.
  // Pinned to real /gp/buy/ ids (2026-07). The CALLER only sends these when the shopper
  // opts in (settings.fullShipTo); by themselves they never leave the device.
  const nameEl = root.querySelector('#deliver-to-customer-text');
  if (nameEl) { const n = collapse(nameEl.textContent).replace(/^(?:deliver(?:ing)?\s+to|ship(?:ping)?\s+to)\s*:?\s*/i, ''); if (n) shipName = n.slice(0, 60); }
  const addrEl = root.querySelector('#deliver-to-address-text');
  if (addrEl) { const a = collapse(addrEl.textContent); if (a) shipAddress = a.slice(0, 140); }

  return (payment || shipTo || shipName || shipAddress) ? { shipTo, payment, shipName, shipAddress } : null;
}

export function parseCart(root = document) {
  const items = parseCartItems(root);
  let total = parseCartTotal(root);
  // Amazon's active-cart subtotal reflects the WHOLE cart, not the checkbox
  // selection. When lines are deselected, send the SELECTED subtotal so the total
  // matches the items the guardian sees — but only when every selected item has a
  // parseable price (else keep the page subtotal, the best available number).
  if (hasDeselectedLine(root)) {
    const selectedSum = sumItemPrices(items);
    if (selectedSum != null) total = selectedSum;
  }
  const breakdown = parseOrderBreakdown(root);
  return { total, items, breakdown };
}
