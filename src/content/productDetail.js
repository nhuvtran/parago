// Runs on Amazon product (/dp/, /gp/product/) pages. When the shopper views a product,
// capture its detail (bullets, brand, Date First Available, rank, rating) from the FULL
// rendered DOM — reliable, no background robot-check — and cache it keyed by ASIN, capped.
// The cart/checkout flow (enrichItems) merges this into the item shown to the guardian,
// so the approval page's Details are populated from what the shopper actually browsed.
import { extractProductDetail, productPageAsin } from '../lib/parseProduct.js';

const KEY = 'parago_product_details';
const MAX = 40; // keep the cache small; evict oldest

function run() {
  try {
    if (typeof chrome === 'undefined' || !chrome.storage) return;
    const asin = productPageAsin(document);
    if (!asin) return;
    const d = extractProductDetail(document);
    const useful = (d.bullets && d.bullets.length) || d.dateFirstAvailable || d.rank || d.brand || d.rating != null;
    if (!useful) return;
    chrome.storage.local.get({ [KEY]: {} }, (store) => {
      const map = store[KEY] || {};
      map[asin] = { ...d, ts: Date.now() };
      const entries = Object.entries(map);
      if (entries.length > MAX) {
        entries.sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0));
        for (const [k] of entries.slice(0, entries.length - MAX)) delete map[k];
      }
      chrome.storage.local.set({ [KEY]: map });
    });
  } catch (e) { /* no-op */ }
}
run();
