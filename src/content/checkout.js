import { getSettings, resolveTimezone } from '../settings/storage.js';
import { setLang, t } from '../i18n/i18n.js';
import { showApprovalToast } from './approvalToast.js';
import { parseCart, parseCheckoutInfo, parseCheckoutGifts } from '../lib/parseCart.js';
import { productDetailFields } from '../lib/parseProduct.js';
import { shouldRequireApproval } from '../lib/guardianTrigger.js';
import { isApprovedForTotal, recordApproval } from '../lib/approval.js';
import { MockRelay } from '../relay/mockRelay.js';
import { SupabaseRelay } from '../relay/supabaseRelay.js';
import { CONFIG } from '../config.js';
import { shouldUseSupabase, resolveFunctionsBaseUrl } from '../relay/selectRelay.js';
import { RELAY_STATUS } from '../relay/relayClient.js';
import { showOverlay, setOverlayStatus, removeOverlay } from './overlay.js';
import { parseFinalOrderTotal, isPlaceOrderClick, findPlaceOrderControl } from '../lib/placeOrder.js';
import { consumeSuppress } from './interceptGuard.js';
import { createPlacementStore } from '../lib/placementStore.js';
import { buildSnapshot } from '../lib/orderSnapshot.js';
import { runPlacementCompletion } from './placementManager.js';
import { pageKind } from './amazonNav.js';

const APPROVALS_KEY = 'parago_approvals';
const OUTSTANDING_KEY = 'parago_outstanding';
const TOTAL_EPSILON = 0.005;

// Where the shopper is sent after a purchase is held for approval: back to amazon.com
// to keep shopping. The order is NOT placed and is NOT queued to place automatically —
// guardian approval only UNLOCKS the gate so the shopper's own next click goes through.
const SHOP_URL = 'https://www.amazon.com/';
let navigate = (url) => { try { window.location.assign(url); } catch (e) { /* jsdom: no-op */ } };
export function _setNavigateForTest(fn) { navigate = fn; }
// Delay before the unlock-mode redirect, so the "sent for approval" toast is visible
// first. Overridable in tests (set to 0 for a synchronous redirect).
let redirectDelayMs = 1500;
export function _setRedirectDelayForTest(ms) { redirectDelayMs = ms; }

// Relay is swappable. Built from settings in run() (see buildRelay). Tests may
// override via the exported setter.
export let relay = new MockRelay();
export function _setRelayForTest(r) { relay = r; }

// Ask the background worker for an asin's rating/review count. Resolves to a
// {rating, reviewCount} object even on failure; null fields mean "unknown".
function bgProductMeta(asin) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: 'parago_product_meta', asin }, (resp) => {
        if (chrome.runtime && chrome.runtime.lastError) return resolve({ rating: null, reviewCount: null });
        resolve(resp || { rating: null, reviewCount: null });
      });
    } catch (e) { resolve({ rating: null, reviewCount: null }); }
  });
}

// Enrich cart items with rating/reviews just before a relay submit. Fail soft and
// time-bounded: a slow Amazon response must never hang checkout, so each lookup
// races a timer; on timeout/error/no-asin the item passes through unchanged. In
// vitest (no chrome mock) this is a pure pass-through so existing tests still pass.
function loadProductDetailCache() {
  return new Promise((resolve) => {
    try { chrome.storage.local.get({ parago_product_details: {} }, (d) => resolve(d.parago_product_details || {})); }
    catch (e) { resolve({}); }
  });
}

export async function enrichItems(items, { timeoutMs = 2000 } = {}) {
  if (!Array.isArray(items) || !items.length) return items || [];
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) return items;
  const cache = await loadProductDetailCache(); // capture-on-view details (full DOM), keyed by ASIN
  return Promise.all(items.map(async (item) => {
    if (!item || !item.asin) return item;
    // Prefer the detail captured when the shopper VIEWED the product (reliable, full DOM);
    // fall back to the background /dp/ fetch (regex, may hit a robot check) only if absent.
    let meta = cache[item.asin] || null;
    if (!meta) {
      const timeout = new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs));
      meta = await Promise.race([bgProductMeta(item.asin), timeout]);
    }
    if (!meta) return item; // nothing found: leave unchanged
    // Prefer the product page's values, but keep the cart-line rating when the
    // background fetch came back empty (e.g. a robot-check page) rather than nulling it.
    const details = productDetailFields(meta);
    return {
      ...item,
      rating: meta.rating ?? item.rating ?? null,
      reviewCount: meta.reviewCount ?? item.reviewCount ?? null,
      ...(details ? { details } : {}),
    };
  }));
}

function itemImageId(u) {
  const m = String(u || '').match(/\/images\/I\/([^./]+)\./);
  return m ? m[1] : null;
}
// Ship-to fields for the request. Partial (City, ST ZIP) + payment always; the FULL name +
// street address ONLY when the shopper opted in (settings.fullShipTo, default off), so the
// approver never gets the full address unless the shopper chose to share it.
function shipFields(ci, settings) {
  const c = ci || {};
  const full = !!(settings && settings.fullShipTo);
  return {
    shipTo: c.shipTo || null,
    payment: c.payment || null,
    shipName: full ? (c.shipName || null) : null,
    shipAddress: full ? (c.shipAddress || null) : null,
  };
}

// Heads-up for a purchase that did NOT need approval (settings.notifyUnheld): a buttonless
// Telegram FYI. Fire-and-forget — must never delay or block the shopper's checkout. Sent
// via the background worker, so it completes even after the page redirects.
let lastNotifyAt = 0;
function maybeNotifyUnheld(total, root) {
  if (!armedSettings || !armedSettings.notifyUnheld) return;
  if ((armedSettings.deliveryMethod || 'email') !== 'telegram') return; // heads-up goes to Telegram
  const now = Date.now();
  if (now - lastNotifyAt < 1500) return; // dedupe the pointerdown+click pair for one press
  lastNotifyAt = now;
  (async () => {
    try {
      const { items } = await bestKnownPurchase(root);
      const enriched = applyGifts(await enrichItems(items), armedSettings, root);
      const ci = parseCheckoutInfo(root) || {};
      await relay.notify({ total, items: enriched, breakdown: parseCart(root).breakdown, ...shipFields(ci, armedSettings) });
    } catch (e) { /* best effort: an FYI must never affect checkout */ }
  })();
}
// Gift visibility is opt-in (settings.showGift, default off). When ON, read which lines the
// shopper marked as a gift on the CHECKOUT page and flag the matching items (by title or
// image id). When OFF, strip any gift flag before the request leaves the device, so the
// approver never sees a gift marking the shopper didn't choose to share.
function applyGifts(items, settings, root) {
  const list = items || [];
  if (!settings || !settings.showGift) {
    return list.map((it) => { if (it && it.gift) { const { gift, ...rest } = it; return rest; } return it; });
  }
  let gifts = { titles: new Set(), imageIds: new Set() };
  try { gifts = parseCheckoutGifts(root); } catch (e) { /* off-checkout / no DOM */ }
  if (!gifts.titles.size && !gifts.imageIds.size) return list;
  return list.map((it) => {
    const gifted = it && ((it.title && gifts.titles.has(String(it.title).toLowerCase())) || gifts.imageIds.has(itemImageId(it.image)));
    return gifted ? { ...it, gift: true } : it;
  });
}

function buildRelay(settings) {
  if (shouldUseSupabase(settings, CONFIG)) {
    return new SupabaseRelay({
      baseUrl: resolveFunctionsBaseUrl(settings, CONFIG),
      guardianEmail: settings.guardianEmail,
      guardianName: settings.guardianName,
      deliveryMethod: settings.deliveryMethod || 'email',
      telegramLinkCode: settings.telegramLinkCode || null,
      githubUsername: settings.githubUsername || null,
      timezone: resolveTimezone(settings),
      theme: settings.theme || null,
      appButton: settings.appButton !== false,
    });
  }
  return new MockRelay();
}

function getApprovals() {
  return new Promise((resolve) => {
    chrome.storage.local.get({ [APPROVALS_KEY]: [] }, (d) => resolve(d[APPROVALS_KEY] || []));
  });
}
function saveApprovals(list) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [APPROVALS_KEY]: list }, () => resolve());
  });
}

// Outstanding requests awaiting a guardian decision: [{ id, total, createdAt }]. Stored
// across navigation so that when the shopper returns, reconcileApprovals can look each
// one up and, if approved, unlock that total. This is the notify-only alternative to
// auto-placing: nothing is ever bought without a fresh human click.
function getOutstanding() {
  return new Promise((resolve) => {
    chrome.storage.local.get({ [OUTSTANDING_KEY]: [] }, (d) => resolve(d[OUTSTANDING_KEY] || []));
  });
}
function saveOutstanding(list) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [OUTSTANDING_KEY]: list }, () => resolve());
  });
}

function totalsMatch(a, b) {
  return a != null && b != null && !Number.isNaN(a) && !Number.isNaN(b) && Math.abs(a - b) < TOTAL_EPSILON;
}

// Which already-pending request (if any) should this page reuse instead of creating a new one?
// Matching by total dedupes across the cart and checkout pages and on reload. With an unknown
// total, reuse the most recent pending request rather than spawning duplicates.
export function pickPendingRequest(pendingList, total) {
  const list = Array.isArray(pendingList) ? pendingList : [];
  const byTotal = list.find((r) => totalsMatch(r.total, total));
  if (byTotal) return byTotal;
  if (total == null && list.length) {
    return list.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
  }
  return null;
}

let activeRequestId = null;
let unsubscribe = null;
// Auto-place poll handle, and a no-op nav for runPlacementCompletion: its default
// nav.toCheckout points at the CART page (pageKind 'cart', not 'checkout'), which would
// reload-loop; we only ever run it while already on checkout, so navigation is never needed.
let placementPollTimer = null;
const NOOP_NAV = { toCheckout() { /* stay put: auto-place only runs on the checkout page */ } };

function teardown() {
  if (unsubscribe) { try { unsubscribe(); } catch (e) { /* no-op */ } unsubscribe = null; }
  clearInterval(placementPollTimer); placementPollTimer = null;
  activeRequestId = null;
}

// Test-only: reset module state + overlay + listeners between tests.
export function _resetForTest() {
  teardown();
  removeOverlay();
  armedSettings = null;
  armedApprovals = [];
  pressHandled = false;
  letThroughPress = false;
  clearTimeout(letThroughTimer);
  armedSnapshotTotal = null;
  if (typeof document !== 'undefined') {
    document.removeEventListener('pointerdown', onPlaceOrderPress, true);
    document.removeEventListener('click', onPlaceOrderPress, true);
  }
}

async function onApproved(total) {
  if (total != null) {
    const approvals = await getApprovals();
    if (!isApprovedForTotal(approvals, total)) {
      await saveApprovals(recordApproval(approvals, total, Date.now()));
    }
  }
  setOverlayStatus(RELAY_STATUS.APPROVED);
  teardown();
  setTimeout(removeOverlay, 1200);
}

// The blocking guardian overlay. No longer raised on the checkout pages (a held order
// now redirects the shopper to amazon.com instead); kept for the Developer-mode demo and
// as a fail-closed, tested building block.
export async function engage(settings, parsed) {
  const onCancel = () => { try { history.back(); } catch (e) { /* no-op */ } };

  showOverlay({ items: parsed.items, total: parsed.total, guardianName: settings.guardianName, status: 'pending', onCancel });

  let req = null;
  try {
    const pending = await relay.listPending();
    req = pickPendingRequest(pending, parsed.total);
    if (!req) {
      const enrichedItems = applyGifts(await enrichItems(parsed.items), settings, document);
      const ci = parseCheckoutInfo(document) || {};
      const id = await relay.submitRequest({ total: parsed.total, items: enrichedItems, breakdown: parsed.breakdown, ...shipFields(ci, settings) });
      req = await relay.getRequest(id);
    }
  } catch (e) {
    // Fail closed: keep the page blocked, just surface the error.
    setOverlayStatus('error');
    return;
  }
  if (!req) {
    setOverlayStatus('error');
    return;
  }
  activeRequestId = req.id;

  const effTotal = parsed.total != null ? parsed.total : req.total;
  const items = parsed.items && parsed.items.length ? parsed.items : (req.items || []);

  if (parsed.total == null || !(parsed.items && parsed.items.length)) {
    showOverlay({ items, total: effTotal, guardianName: settings.guardianName, status: req.status, onCancel });
  } else {
    setOverlayStatus(req.status);
  }

  if (req.status === RELAY_STATUS.APPROVED) { await onApproved(effTotal); return; }
  if (req.status === RELAY_STATUS.REJECTED) { setOverlayStatus(RELAY_STATUS.REJECTED); return; }

  unsubscribe = relay.onChange((map) => {
    const rec = map && map[activeRequestId];
    if (!rec) return;
    if (rec.status === RELAY_STATUS.APPROVED) onApproved(effTotal);
    else if (rec.status === RELAY_STATUS.REJECTED) setOverlayStatus(RELAY_STATUS.REJECTED);
  });
}

// Decide, at place-order time, whether this purchase needs a hold. Uses the FINAL
// order total on the checkout page (includes shipping + tax) and falls back to the
// cart parse. Fail-closed via shouldRequireApproval for unknown totals in over_limit.
export function evaluatePlaceOrder(settings, root = document) {
  const finalTotal = parseFinalOrderTotal(root);
  const parsed = parseCart(root);
  const total = finalTotal != null ? finalTotal : parsed.total;
  return { hold: shouldRequireApproval(settings, total), total, items: parsed.items };
}

function pathname() {
  return (typeof location !== 'undefined' && location.pathname) || '';
}
function isCartUrl() {
  const p = pathname();
  return /\/gp\/cart\//.test(p) || /\/cart\b/.test(p) || /\/checkout\/entry\/cart/.test(p);
}

const CART_SNAPSHOT_KEY = 'parago_cart_snapshot';
const SNAPSHOT_MAX_AGE_MS = 30 * 60 * 1000; // older carts aren't trusted for the email

function loadCartSnapshot() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get({ [CART_SNAPSHOT_KEY]: null }, (d) => resolve(d[CART_SNAPSHOT_KEY] || null));
    } catch (e) { resolve(null); }
  });
}
// Cart items/total don't parse on the SPC place-order page (different DOM), so the
// guardian email would otherwise be empty. Stash the cart while on the cart page and
// reuse it at request time so the email shows what is actually being bought.
function stashCart(root = document) {
  try {
    if (typeof chrome === 'undefined' || !chrome.storage) return;
    const parsed = parseCart(root);
    if (parsed.items && parsed.items.length) {
      chrome.storage.local.set({ [CART_SNAPSHOT_KEY]: { total: parsed.total, items: parsed.items, at: Date.now() } });
    }
  } catch (e) { /* no-op */ }
}

// stashCart runs once on load, but the shopper can check/uncheck cart items AFTER that,
// and the Options "Send a test" reads the STORED snapshot (it can't see the live cart
// DOM from another page). So re-capture, debounced, whenever a line's selection flips
// (Amazon updates data-isselected) or the item set changes — the snapshot then always
// reflects the CURRENTLY selected items, for both the test send and a real checkout.
function watchCartForSelection(root = document) {
  try {
    let timer = null;
    const restash = () => { clearTimeout(timer); timer = setTimeout(() => stashCart(root), 350); };
    // 1) Fire the instant Amazon flips a line's selection attribute. Observe a STABLE
    //    ancestor (body), not #sc-active-cart, since Amazon re-renders the cart subtree
    //    on toggle and an observer bound to the replaced node would go deaf.
    const target = root.body || root.documentElement;
    if (typeof MutationObserver !== 'undefined' && target) {
      new MutationObserver(restash).observe(target, { subtree: true, attributes: true, attributeFilter: ['data-isselected'] });
    }
    // 2) Backup for cart variants that don't toggle data-isselected in place: re-capture
    //    shortly after a click on a checkbox/label (Amazon updates after an AJAX round-trip).
    const clickHost = (root.addEventListener ? root : (root.body || null));
    if (clickHost && clickHost.addEventListener) {
      clickHost.addEventListener('click', (e) => {
        const t = e.target;
        if (t && t.closest && t.closest('input[type="checkbox"], label, [class*="checkbox" i]')) setTimeout(restash, 700);
      }, true);
    }
    // 3) Safety net: while the cart tab is visible, re-capture every few seconds, so the
    //    stored snapshot the Options "Send a test" reads can never lag the live selection,
    //    however Amazon updates the DOM. parseCart is a cheap DOM read.
    if (typeof setInterval !== 'undefined') {
      setInterval(() => { if (typeof document === 'undefined' || document.visibilityState !== 'hidden') restash(); }, 3000);
    }
  } catch (e) { /* no-op */ }
}
async function bestKnownPurchase(root = document) {
  const finalTotal = parseFinalOrderTotal(root);
  const parsed = parseCart(root);
  let total = finalTotal != null ? finalTotal : parsed.total;
  let items = (parsed.items && parsed.items.length) ? parsed.items : [];
  if (!items.length || total == null) {
    const snap = await loadCartSnapshot();
    if (snap && (Date.now() - (snap.at || 0) < SNAPSHOT_MAX_AGE_MS)) {
      if (!items.length) items = snap.items || [];
      if (total == null && snap.total != null) total = snap.total;
    }
  }
  return { total, items };
}

// ── Place-order interception ────────────────────────────────────────────────────
// The order is held only when the shopper actually presses "Place your order" — there
// is no proactive page-load block. We bind on BOTH pointerdown and click (capture)
// because Amazon's SPC checkout submits the order on pointerdown and navigates before a
// click ever fires; catching the press at pointerdown is what lets us preventDefault in
// time. On a held press we request approval and send the shopper back to amazon.com.
let armedSettings = null;
let armedApprovals = [];
let pressHandled = false;
// A real press fires pointerdown THEN click on the same control. When we let an
// approved press through we consume the single-use approval on the FIRST event; this
// one-shot flag lets the paired second event pass too, so the trailing click is not
// re-evaluated (approval now gone) and wrongly blocked + resubmitted. Cleared by the
// paired event, with a timer backstop if the press is cancelled and no click comes.
let letThroughPress = false;
let letThroughTimer = null;
// Best-known cart total, preloaded from the snapshot at arm time, so the SYNC approval
// gate has a stable total to match even on a page where the live total does not parse
// (else a null total can never match an approval and the press re-holds forever).
let armedSnapshotTotal = null;

// One approval authorizes exactly one placement. Remove the first matching approval from
// the in-memory armed list synchronously (so a repeat press in this same visit needs fresh
// approval) and from storage (fire-and-forget: the let-through must proceed without an
// await here). Matching tolerates the same epsilon as isApprovedForTotal.
function consumeApproval(total) {
  const matches = (a) => Math.abs(a.total - total) < TOTAL_EPSILON;
  const i = armedApprovals.findIndex(matches);
  if (i < 0) return;
  armedApprovals = armedApprovals.slice(0, i).concat(armedApprovals.slice(i + 1));
  getApprovals().then((list) => {
    const j = list.findIndex(matches);
    if (j >= 0) { list.splice(j, 1); return saveApprovals(list); }
  }).catch(() => { /* fire-and-forget */ });
}

async function onPlaceOrderPress(ev) {
  if (!armedSettings) return;
  if (!isPlaceOrderClick(ev, document)) return;
  if (consumeSuppress()) return; // a programmatic place click (if any) passes through
  // Once we've taken a press this visit, block every later place-order press too, so a
  // second tap during the request/redirect window can't reach Amazon unreviewed.
  if (pressHandled) { ev.preventDefault(); ev.stopImmediatePropagation(); return; }
  // Paired event of a press we already approved-through: let it pass without re-deciding.
  if (letThroughPress) { letThroughPress = false; clearTimeout(letThroughTimer); return; }

  const finalTotal = parseFinalOrderTotal(document);
  const parsed = parseCart(document);
  const total = finalTotal != null ? finalTotal : (parsed.total != null ? parsed.total : armedSnapshotTotal);

  if (!shouldRequireApproval(armedSettings, total)) { maybeNotifyUnheld(total, document); return; } // under limit → let Amazon place, optionally FYI

  // Guardian already approved this exact total (recorded by reconcileApprovals on a
  // prior visit): the gate is unlocked for ONE placement, so consume it and let the
  // shopper's own click through. Single-use is the point — without consuming, an approved
  // total would permanently unlock every future cart of that price (silent spend).
  if (isApprovedForTotal(armedApprovals, total)) {
    consumeApproval(total);
    // A pointerdown is followed by a paired click on the same control; arm a one-shot
    // so that click passes too, instead of being re-evaluated (approval now consumed)
    // and wrongly blocked. A lone click IS the whole gesture, so nothing is armed and
    // single-use still holds for the next separate press. Timer backstop for a
    // cancelled press whose click never arrives.
    if (ev.type === 'pointerdown') {
      letThroughPress = true;
      clearTimeout(letThroughTimer);
      letThroughTimer = setTimeout(() => { letThroughPress = false; }, 1500);
    }
    return;
  }

  // Approval required and not yet granted. Block this submit (synchronously, before any
  // await, so Amazon's own handler can't place it), request approval, then send the
  // shopper back to shopping. The order is NOT placed and NOT auto-queued.
  pressHandled = true;
  ev.preventDefault();
  ev.stopImmediatePropagation();
  try {
    const { items } = await bestKnownPurchase(document);
    const outstanding = await getOutstanding();
    if (!outstanding.some((o) => totalsMatch(o.total, total))) {
      const enriched = applyGifts(await enrichItems(items), armedSettings, document);
      const ci = parseCheckoutInfo(document) || {};
      const now = Date.now();
      const id = await relay.submitRequest({ total, items: enriched, breakdown: parsed.breakdown, ...shipFields(ci, armedSettings) });
      await saveOutstanding([...outstanding, { id, total, createdAt: now }]);
      // Auto-place mode: record an order snapshot keyed by the SAME request id, so a later
      // runPlacementCompletion pass (see run) can claim, re-verify against the live order,
      // and click Place order once the guardian approves. Off by default (unlock-only).
      if (armedSettings.autoPlace) {
        try {
          await createPlacementStore().put(id, { snapshot: buildSnapshot({ items: enriched, total, address: ci.shipTo, payment: ci.payment }, now), status: 'pending', createdAt: now });
        } catch (e) { /* non-fatal: this order just won't auto-place */ }
      }
    }
  } catch (e) {
    // Fail closed: we preventDefault'd, so the order was NOT placed. The request may not
    // have been sent (offline); the shopper can retry. Nothing buys without approval.
    console.error('[parago] approval request failed:', e);
  }
  // Unlock-only: show the shopper the on-page "sent for approval" notification (below the
  // Amazon logo), then send them back to shopping (their OWN next click completes it once
  // approved). Auto-place stays on the checkout page so the poll can complete it.
  if (!armedSettings.autoPlace) {
    try { showApprovalToast({ title: t('toast_sent_title'), body: t('toast_sent_body') }); } catch (e) { /* toast is best-effort */ }
    setTimeout(() => navigate(SHOP_URL), redirectDelayMs);
  }
}

export function armPlaceOrderIntercept(settings, approvals = []) {
  armedSettings = settings;
  armedApprovals = Array.isArray(approvals) ? approvals : [];
  pressHandled = false;
  letThroughPress = false;
  clearTimeout(letThroughTimer);
  // Capture phase so we run before Amazon's own submit handler.
  document.addEventListener('pointerdown', onPlaceOrderPress, true);
  document.addEventListener('click', onPlaceOrderPress, true);
}

// Fail closed: are we on a final place-order page that needs approval but whose
// place-order control we cannot recognize? If the button is unrecognized, an
// un-intercepted press would place the order with no approval.
export function needsHardBlockFallback(settings, root = document) {
  if (parseFinalOrderTotal(root) == null) return false;   // not the final order page
  const { hold } = evaluatePlaceOrder(settings, root);
  if (!hold) return false;                                 // no approval needed
  return findPlaceOrderControl(root) == null;              // recognized -> interceptor handles it
}

// On return to a checkout/cart page, learn the outcome of any outstanding request and,
// for approved ones, record the approval locally so the shopper's next "Place your order"
// click goes through. Never places an order itself.
export async function reconcileApprovals() {
  const outstanding = await getOutstanding();
  if (!outstanding.length) return;
  let approvals = await getApprovals();
  const placements = createPlacementStore();
  const stillPending = [];
  let approvalsChanged = false;
  for (const o of outstanding) {
    let rec;
    try {
      rec = await relay.getRequest(o.id);
    } catch (e) {
      stillPending.push(o); // transient failure (offline/5xx): keep for next visit
      continue;
    }
    if (!rec) continue; // not_found → drop
    if (rec.status === RELAY_STATUS.APPROVED) {
      // If auto-place already claimed or placed this exact request (its placement record
      // is 'placing'/'placed'), do NOT also mint a manual-unlock approval for its total:
      // that would let the shopper place the SAME approved order a second time after
      // switching auto-place off. Just drop the outstanding marker.
      let placed = false;
      try { const pl = await placements.get(o.id); placed = !!(pl && (pl.status === 'placing' || pl.status === 'placed')); } catch (e) { /* treat as not placed */ }
      // Record the approval, but only for a real total (a null total can never be
      // matched by isApprovedForTotal, so recording it just accumulates junk).
      if (!placed && o.total != null && !isApprovedForTotal(approvals, o.total)) {
        approvals = recordApproval(approvals, o.total, Date.now());
        approvalsChanged = true;
      }
      // drop from outstanding: approval is now recorded locally (or owned by auto-place)
    } else if (rec.status === RELAY_STATUS.PENDING) {
      stillPending.push(o); // genuinely still waiting → keep watching
    }
    // else (rejected, EXPIRED, or any other terminal/unknown status) → drop. Keeping
    // an expired hold would make onPlaceOrderPress dedupe against it forever and never
    // send a fresh request for that total (permanent silent deadlock). A retry starts
    // a new request.
  }
  if (approvalsChanged) await saveApprovals(approvals);
  await saveOutstanding(stillPending);
}

export async function run() {
  const settings = await getSettings();
  setLang(settings.lang);
  relay = buildRelay(settings);

  if (isCartUrl()) {
    stashCart(document);            // capture the cart for the guardian before checkout
    watchCartForSelection(document); // ...and re-capture when the shopper toggles item selection
  }

  if (settings.guardianMode !== 'off') {
    // Arm the interceptor FIRST, so there is never a live-but-unarmed window where a
    // place-order press could slip through unreviewed. In auto-place mode arm with NO
    // approvals: that mode never records a click-unlock approval (the extension places
    // programmatically via suppressNextPlace), so arming with none keeps the interceptor
    // holding every manual press and removes any manual-unlock double-place path.
    armPlaceOrderIntercept(settings, settings.autoPlace ? [] : await getApprovals());
    // Preload the best-known total from the cart snapshot, so the sync approval gate has
    // a stable total to match on a page where the live total does not parse.
    try {
      const snap = await loadCartSnapshot();
      if (snap && snap.total != null && (Date.now() - (snap.at || 0) < SNAPSHOT_MAX_AGE_MS)) {
        armedSnapshotTotal = snap.total;
      }
    } catch (e) { /* no-op: fall back to a null total (fail closed) */ }
    if (settings.autoPlace) {
      // Auto-place: finish any approved order by claiming + clicking Place order. Every
      // fail-closed guard (snapshot match, exclusive claim, recognized control,
      // confirm-or-timeout) lives in runPlacementCompletion. Run ONLY while on the checkout
      // page (off-checkout it must not run: its built-in nav would reload-loop, so we pass a
      // no-op nav and never invoke it there). Poll so an order held on THIS page completes
      // without a reload; returning to checkout later re-runs it via this same path.
      if (pageKind() === 'checkout') {
        const tick = () => runPlacementCompletion({ relay, nav: NOOP_NAV }).catch((e) => console.error('[parago] placement failed:', e));
        await tick();
        clearInterval(placementPollTimer);
        placementPollTimer = setInterval(tick, 4000);
      }
    } else {
      // Unlock-only: learn the outcome of any prior request and refresh the armed
      // approvals, so an approved total is recognized and the shopper's next click passes.
      try {
        await reconcileApprovals();
      } catch (e) {
        console.error('[parago] reconcileApprovals failed:', e);
      }
      armedApprovals = await getApprovals();
    }
  }
}
