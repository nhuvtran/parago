import { parseProductMeta } from './lib/parseProduct.js';
import { getSettings } from './settings/storage.js';
import { CONFIG } from './config.js';
import { resolveFunctionsBaseUrl, isAllowedFetchOrigin } from './relay/selectRelay.js';

// MV3 background service worker. Content scripts can't make host-permission'd
// cross-origin fetches in MV3, so the relay sends a message here and we fetch.
async function doFetch({ url, options }) {
  const res = await fetch(url, options || {});
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { ok: res.ok, status: res.status, body };
}

// parago_fetch is a credential-capable proxy (the worker holds the amazon.com and
// supabase host permissions), so constrain it to the one origin it legitimately
// targets: the configured Supabase Edge Functions base. Derived from settings so a
// custom/self-hosted functions URL still works, while an arbitrary caller-supplied
// URL (SSRF, cross-origin cookie replay) is rejected. Pairs with the sender.id gate
// below; today nothing external can reach this handler, this keeps it that way if a
// future change ever adds externally_connectable or a page bridge.
async function fetchOriginAllowed(url) {
  return isAllowedFetchOrigin(url, resolveFunctionsBaseUrl(await getSettings(), CONFIG));
}

// Fetch a product page and extract rating/reviewCount for enrichment. A programmatic
// /dp/ fetch may return a robot-check page instead of the product page; parseProductMeta
// fail-softs to nulls in that case, and the email/page simply omit the rating.
// credentials:'include' sends the user's amazon.com cookies (background holds the
// *://*.amazon.com/* host permission) to better get the real page.
async function productMeta(asin) {
  try {
    const res = await fetch('https://www.amazon.com/dp/' + encodeURIComponent(asin), { credentials: 'include' });
    if (!res.ok) return { rating: null, reviewCount: null };
    const html = await res.text();
    return parseProductMeta(html);
  } catch { return { rating: null, reviewCount: null }; }
}

// Exactly-once placement lock. Content scripts run per-tab and chrome.storage has
// no atomic compare-and-set, so two checkout tabs loading at once could both decide
// to place the same approved order. The service worker is a SINGLE instance with a
// serialized event loop, so a check-and-set here is atomic: the first tab to claim
// an order id wins, every later claim for that id is denied. The claim is held for
// the worker's lifetime (never released): a placed/failed order is terminal and is
// never re-claimed, and a brand-new checkout uses a fresh id.
const placementClaims = new Set();

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // Only this extension's own isolated-world scripts may drive these privileged
  // handlers. No externally_connectable is declared and there is no page->content
  // bridge, so a sender.id that isn't ours means a future misconfig, not a real
  // caller. Reject rather than trust. (Legit internal messages always carry our id.)
  if (!_sender || _sender.id !== chrome.runtime.id) return false;
  if (msg && msg.type === 'parago_fetch') {
    (async () => {
      if (!(await fetchOriginAllowed(msg.url))) {
        return sendResponse({ ok: false, status: 0, body: null, error: 'blocked_origin' });
      }
      try { sendResponse(await doFetch(msg)); }
      catch (e) { sendResponse({ ok: false, status: 0, body: null, error: String(e) }); }
    })();
    return true; // keep the channel open for the async response
  }
  if (msg && msg.type === 'parago_claim_placement' && msg.id) {
    const granted = !placementClaims.has(msg.id);
    if (granted) placementClaims.add(msg.id);
    sendResponse({ granted });
    return true;
  }
  if (msg && msg.type === 'parago_product_meta' && msg.asin) {
    productMeta(msg.asin).then(sendResponse).catch(() => sendResponse({ rating: null, reviewCount: null }));
    return true; // async response
  }
  return false;
});

// No toolbar badge. Protection on/off is shown only in the popup power toggle, so the
// toolbar icon stays plain (the persistent green badge was removed by request).

// Supabase keepalive. The free tier pauses a project after ~7 days of no activity,
// which silently breaks email approval. A periodic ping (a clean DB read via
// get-status with a valid but nonexistent uuid) keeps it warm. This fires only
// while the browser is running; the scheduled GitHub Action in
// .github/workflows/keepalive.yml is the 24/7 backstop for when it is closed.
const KEEPALIVE_ALARM = 'parago_keepalive';
const KEEPALIVE_PERIOD_MIN = 6 * 60; // every 6h while the browser is open
const KEEPALIVE_UUID = '00000000-0000-0000-0000-000000000000'; // valid uuid, no row: clean 404 (the SELECT still runs)

async function keepalivePing() {
  try {
    const base = resolveFunctionsBaseUrl(await getSettings(), CONFIG);
    if (!/^https?:\/\//i.test(base) || base.includes('<PROJECT_REF>')) return; // backend not configured
    await fetch(`${base}/get-status?id=${KEEPALIVE_UUID}`).catch(() => {});
  } catch (e) { /* no-op: keepalive is best-effort */ }
}

if (typeof chrome !== 'undefined' && chrome.alarms) {
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_PERIOD_MIN, delayInMinutes: 1 });
  chrome.alarms.onAlarm.addListener((a) => { if (a && a.name === KEEPALIVE_ALARM) keepalivePing(); });
}
