// Enrichment for a cart item: pull rating/review count AND the richer detail that
// only exists on a product (/dp/) page (feature bullets, brand, "Date First
// Available", Best Sellers Rank) off the page's HTML. This runs inside the MV3
// background service worker, which has NO document and NO DOMParser, so we cannot
// build a DOM — we parse the raw HTML STRING with regular expressions only. Fully
// fail-soft: bad/empty/unmatched input yields nulls/empties and never throws.

function stripTags(s) { return String(s || '').replace(/<[^>]*>/g, ' '); }
function decode(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;|&rsquo;/g, "'")
    .replace(/&nbsp;|&#160;/g, ' ').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}
function clean(s) { return decode(stripTags(s)).replace(/\s+/g, ' ').trim(); }

// Upsize an Amazon image URL: the size is encoded in the filename token
// (e.g. ._AC_US40_. on a thumbnail); swap it for a large render.
function biggerProductImage(u) {
  return String(u || '').replace(/\._[^./]*_\.(jpg|jpeg|png|webp)(\?.*)?$/i, '._AC_SL1200_.$1');
}

// Product-video URLs live in the page's ImageBlock state as raw
// ".../<id>.mp4/productVideoOptimized.mp4" strings, each paired with a
// ".../<id>.mp4/r/THUMBNAIL_...JPG" poster frame. Works on any HTML string (regex),
// so it serves both the background fetch and the content-script (innerHTML) paths.
function extractVideos(html) {
  const s = String(html || '');
  const mp4s = [...s.matchAll(/(https:\/\/[^"'\s]+?\/productVideoOptimized\.mp4)/g)].map((m) => m[1]);
  const posters = [...s.matchAll(/(https:\/\/[^"'\s]+?\/THUMBNAIL[^"'\s]*\.(?:JPG|jpg))/g)].map((m) => m[1]);
  const out = [], seen = new Set();
  for (const url of mp4s) {
    const base = url.replace(/\/productVideoOptimized\.mp4$/, ''); // ".../<id>.mp4"
    if (seen.has(base)) continue;
    seen.add(base);
    out.push({ url, poster: posters.find((p) => p.indexOf(base) === 0) || null });
    if (out.length >= 3) break;
  }
  return out;
}

// Ordered gallery image URLs from the /dp/ thumbnail strip (#altImages), upsized. Only
// li.imageThumbnail (not video thumbnails) so we never treat a video poster as a photo.
function galleryFromDom(root) {
  const urls = [], seen = new Set();
  for (const img of root.querySelectorAll('#altImages li.imageThumbnail img')) {
    const src = img.getAttribute('src') || '';
    if (!/\/images\/I\//.test(src)) continue;
    const big = biggerProductImage(src);
    const id = (big.match(/\/images\/I\/([^./]+)\./) || [])[1];
    if (id && !seen.has(id)) { seen.add(id); urls.push(big); }
    if (urls.length >= 8) break;
  }
  if (!urls.length) { // fallback: the single main image at hi-res
    const main = root.querySelector('#landingImage, #imgTagWrapperId img, #main-image-container img');
    const hi = main && (main.getAttribute('data-old-hires') || main.getAttribute('src'));
    if (hi && /\/images\/I\//.test(hi)) urls.push(hi);
  }
  return urls;
}

export function parseProductMeta(html) {
  const out = { rating: null, reviewCount: null, bullets: [], dateFirstAvailable: null, rank: null, brand: null, gallery: [], videos: [] };
  if (typeof html !== 'string' || !html) return out;

  // rating: "4.7 out of 5" (Amazon's a-icon-alt text). Clamp to 0..5.
  const rm = html.match(/([0-5](?:\.\d{1,2})?)\s+out of\s+5/i);
  if (rm) { const r = parseFloat(rm[1]); if (Number.isFinite(r) && r >= 0 && r <= 5) out.rating = r; }

  // reviewCount: prefer Amazon's ratings element, else any "N ratings" phrase.
  // Live markup renders the count parenthesised, e.g. >(1,039,135)< , so allow any
  // non-digit prefix ([^\d<]*) between the tag close and the number rather than
  // requiring digits immediately. Verified against a live /dp/ page (2026-06).
  let cm = html.match(/id="acrCustomerReviewText"[^>]*>[^\d<]*([\d,]+)/i);
  if (!cm) cm = html.match(/([\d,]+)\s+(?:global\s+)?ratings?\b/i);
  if (cm) { const c = parseInt(cm[1].replace(/,/g, ''), 10); if (Number.isFinite(c)) out.reviewCount = c; }

  // Feature bullets ("About this item"): the a-list-item spans inside #feature-bullets.
  const fb = html.match(/id="feature-bullets"([\s\S]*?)(?:<\/ul>|<div id="|<hr\b)/i);
  if (fb) {
    const re = /class="a-list-item[^"]*"[^>]*>([\s\S]*?)<\/span>/gi;
    const seen = new Set();
    let m;
    while ((m = re.exec(fb[1])) && out.bullets.length < 6) {
      const t = clean(m[1]);
      if (t.length < 3 || t.length > 240) continue;
      if (/make sure this fits by entering|see more product details/i.test(t)) continue;
      if (seen.has(t)) continue;
      seen.add(t); out.bullets.push(t);
    }
  }

  out.dateFirstAvailable = labelValue(html, 'Date First Available');
  out.rank = rankValue(html);
  out.brand = brandValue(html);
  // Gallery: the full-res images baked into the ImageBlock state ("hiRes":"...SL1500...").
  out.gallery = [...new Set((html.match(/"hiRes":"(https:[^"]+?\.(?:jpg|jpeg|png|webp))"/gi) || [])
    .map((m) => (m.match(/"(https:[^"]+)"/) || [])[1]).filter(Boolean))].slice(0, 8);
  out.videos = extractVideos(html);
  return out;
}

// A labelled value from a detail bullet (<span>Label</span> <span>Value</span>) or a
// product-details table (<th>Label</th><td>Value</td>).
function labelValue(html, label) {
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let m = html.match(new RegExp(esc + '\\s*<\\/span>\\s*<span[^>]*>\\s*([^<]+?)\\s*<', 'i'));
  if (m) { const v = clean(m[1]); if (v) return v; }
  m = html.match(new RegExp('<th[^>]*>\\s*' + esc + '\\s*<\\/th>\\s*<td[^>]*>([\\s\\S]*?)<\\/td>', 'i'));
  if (m) { const v = clean(m[1]); if (v) return v; }
  return null;
}

// Best Sellers Rank: keep the first "#1,234 in Category" clause (the full string is a
// long nested list of category ranks).
function rankValue(html) {
  const m = html.match(/Best Sellers Rank[\s\S]{0,400}?#([\d,]+\s+in\s+[^<(#]+)/i);
  if (m) { const v = clean('#' + m[1]).slice(0, 70); if (v.length > 3) return v; }
  return null;
}

function brandValue(html) {
  const m = html.match(/id="bylineInfo"[^>]*>\s*([^<]+?)\s*</i);
  if (m) { const v = clean(m[1]); if (v && v.length <= 80) return v; }
  return null;
}

// The extra detail worth carrying on a cart item (what the cart line lacks). Returns
// null when there is nothing useful, so callers can skip attaching an empty object.
export function productDetailFields(meta) {
  if (!meta) return null;
  const out = {};
  if (Array.isArray(meta.bullets) && meta.bullets.length) out.bullets = meta.bullets.slice(0, 6);
  if (meta.dateFirstAvailable) out.dateFirstAvailable = meta.dateFirstAvailable;
  if (meta.rank) out.rank = meta.rank;
  if (meta.brand) out.brand = meta.brand;
  if (Array.isArray(meta.gallery) && meta.gallery.length) out.gallery = meta.gallery.slice(0, 6);
  if (Array.isArray(meta.videos) && meta.videos.length) out.videos = meta.videos.slice(0, 2);
  return Object.keys(out).length ? out : null;
}

// DOM-based extractor for a product (/dp/) page — used by the productDetail content
// script, which runs IN the page and so has the full rendered DOM. This is far more
// reliable than the regex path (real elements, no robot-check on a background fetch),
// and Amazon's element IDs here (#feature-bullets, #acrCustomerReviewText,
// #detailBullets_feature_div, product-details tables) have been stable for years.
// Returns the same shape as parseProductMeta. Fully fail-soft.
export function extractProductDetail(root = document) {
  const txt = (el) => ((el && el.textContent) || '').replace(/\s+/g, ' ').trim();
  const out = { rating: null, reviewCount: null, bullets: [], dateFirstAvailable: null, rank: null, brand: null, gallery: [], videos: [] };

  for (const el of root.querySelectorAll('#acrPopover, #averageCustomerReviews .a-icon-alt, .a-icon-star .a-icon-alt, .a-icon-alt')) {
    const t = (el.getAttribute && (el.getAttribute('title') || el.getAttribute('aria-label'))) || txt(el);
    const m = String(t).match(/([0-5](?:\.\d+)?)\s*out of\s*5/i);
    if (m) { const n = parseFloat(m[1]); if (n >= 0 && n <= 5) { out.rating = n; break; } }
  }

  const rc = root.querySelector('#acrCustomerReviewText, [data-hook="total-review-count"]');
  if (rc) { const m = txt(rc).replace(/,/g, '').match(/\d{1,8}/); if (m) out.reviewCount = parseInt(m[0], 10); }

  const seen = new Set();
  for (const li of root.querySelectorAll('#feature-bullets .a-list-item, #feature-bullets li')) {
    if (li.closest('.aok-hidden, [hidden]')) continue;
    const t = txt(li);
    if (t.length < 3 || t.length > 240 || /make sure this fits by entering|see more product details/i.test(t) || seen.has(t)) continue;
    seen.add(t); out.bullets.push(t);
    if (out.bullets.length >= 6) break;
  }

  const findLabel = (re) => {
    // Detail bullets put the label + value in one <li> with no reliable colon between
    // them, so strip the matched label and leading separators to get the value.
    for (const li of root.querySelectorAll('#detailBullets_feature_div li, #detailBulletsWrapper_feature_div li')) {
      const t = txt(li);
      if (re.test(t)) { const v = t.replace(re, '').replace(/^[\s:：‎‏]+/, '').trim(); if (v) return v; }
    }
    for (const tr of root.querySelectorAll('#productDetails_detailBullets_sections1 tr, #productDetails_techSpec_section_1 tr, table.prodDetTable tr')) {
      const th = tr.querySelector('th'), td = tr.querySelector('td');
      if (th && td && re.test(txt(th))) { const v = txt(td); if (v) return v; }
    }
    return null;
  };
  out.dateFirstAvailable = findLabel(/date first available/i);
  const rawRank = findLabel(/best sellers?\s*rank/i);
  if (rawRank) { const m = rawRank.match(/#[\d,]+\s+in\s+[^#(]+/); out.rank = (m ? m[0] : rawRank).replace(/\s+/g, ' ').trim().slice(0, 70) || null; }

  const bl = root.querySelector('#bylineInfo');
  if (bl) { const t = txt(bl); if (t && t.length <= 80) out.brand = t; }

  // Gallery images (from the thumbnail strip) + product videos (from the page state).
  out.gallery = galleryFromDom(root);
  try { out.videos = extractVideos((root.documentElement && root.documentElement.innerHTML) || ''); } catch (e) { out.videos = []; }
  return out;
}

// ASIN for a product page: URL first, then a hidden input, then any [data-asin].
export function productPageAsin(root = document) {
  try {
    const path = (root.location && root.location.pathname) || (typeof location !== 'undefined' ? location.pathname : '') || '';
    const m = path.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})/i);
    if (m) return m[1].toUpperCase();
  } catch (e) { /* no location */ }
  const input = root.querySelector('#ASIN, input[name="ASIN"]');
  if (input && /^[A-Z0-9]{10}$/i.test(input.value || '')) return input.value.toUpperCase();
  const el = root.querySelector('[data-asin]');
  const a = el && el.getAttribute('data-asin');
  return a && /^[A-Z0-9]{10}$/i.test(a) ? a.toUpperCase() : null;
}
