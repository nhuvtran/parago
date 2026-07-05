// src/content/placementManager.js
// Stage 3: on each Amazon page load, try to finish orders the guardian approved.
// Fail-closed throughout: never place unless the live order matches the approved
// snapshot AND we hold an exclusive claim AND we can confirm placement.
import { createPlacementStore } from '../lib/placementStore.js';
import { buildSnapshot, snapshotsMatch } from '../lib/orderSnapshot.js';
import { parseCart, parseCheckoutInfo } from '../lib/parseCart.js';
import {
  findPlaceOrderControl, clickPlaceOrder, detectOrderConfirmation, parseFinalOrderTotal,
} from '../lib/placeOrder.js';
import { pageKind as defaultPageKind, defaultNav } from './amazonNav.js';
import {
  showFinishing, showConfirmed, showCouldNotComplete, showManualFallback, showOrderChanged,
} from './placementOverlay.js';
import { suppressNextPlace } from './interceptGuard.js';

// Give up waiting for a confirmation page after this long in 'placing'. Prevents an
// order from being stranded in 'placing' forever if the click never produced a
// recognizable confirmation.
const PLACING_TIMEOUT_MS = 90_000;
// Stop retrying a never-resolved record after this. The guardian's approval link
// expires in 24h, so anything older is dead.
const PLACEMENT_MAX_AGE_MS = 48 * 60 * 60 * 1000;

function liveSnapshot(createdAt) {
  const parsed = parseCart(document);
  const total = parseFinalOrderTotal(document);
  const ci = parseCheckoutInfo(document) || {};
  // Include ship-to + payment so snapshotsMatch can refuse to place if the shopper changed
  // the destination or card after the guardian approved (see orderSnapshot.snapshotsMatch).
  return buildSnapshot({ items: parsed.items, total: total != null ? total : parsed.total, address: ci.shipTo, payment: ci.payment }, createdAt);
}

// Ask the single background worker for an exclusive claim on this order id. Returns
// false (do not place) if another tab holds it or the worker is unreachable.
function bgClaim(id) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: 'parago_claim_placement', id }, (resp) => {
        if (chrome.runtime && chrome.runtime.lastError) return resolve(false);
        resolve(!!(resp && resp.granted));
      });
    } catch (e) { resolve(false); }
  });
}

// Claim, lock, and place. Shared by the auto path and the manual-fallback button so
// both record 'placing' (so the confirmation page can finalize to 'placed').
async function claimAndPlace({ id, control, store, claim, now }) {
  if (!(await claim(id))) return false;
  await store.patch(id, { status: 'placing', placingAt: now() });
  showFinishing();
  suppressNextPlace(); // let our own click through the interceptor
  clickPlaceOrder(control);
  return true;
}

export async function runPlacementCompletion({
  relay, store = createPlacementStore(), nav = defaultNav,
  pageKind = defaultPageKind, claim = bgClaim, now = () => Date.now(),
} = {}) {
  const all = await store.all();
  for (const id of Object.keys(all)) {
    const rec = all[id];
    if (rec.status === 'placed' || rec.status === 'failed') continue;

    // Resume a locked placement: a prior load clicked and navigated here. Confirm,
    // or fail closed after a bounded wait.
    if (rec.status === 'placing') {
      if (detectOrderConfirmation(document)) {
        await store.patch(id, { status: 'placed', placedAt: now() });
        try { await relay.reportPlaced?.(id); } catch (e) { /* best effort: guardian ping */ }
        showConfirmed();
      } else if (rec.placingAt && (now() - rec.placingAt) > PLACING_TIMEOUT_MS) {
        await store.patch(id, { status: 'failed', lastError: 'no_confirmation' });
        showCouldNotComplete();
      }
      continue;
    }

    // Age out a record that never resolved.
    if (rec.createdAt && (now() - rec.createdAt) > PLACEMENT_MAX_AGE_MS) {
      await store.remove(id);
      continue;
    }

    let status;
    try { const r = await relay.getRequest(id); status = r && r.status; }
    catch (e) { continue; } // transient network error: retry on a later load

    if (status === 'pending') continue;
    if (status === 'rejected' || status === 'expired') {
      await store.remove(id);
      showCouldNotComplete();
      continue;
    }
    // null / unknown (e.g. a transient {error} body or a 5xx surfaced as null) is NOT
    // a definitive decision. Leave the record and retry on a later load rather than
    // discarding a possibly-approved order.
    if (status !== 'approved') continue;

    // Approved. Place only on the checkout page, against a matching live order.
    if (pageKind() !== 'checkout') {
      showFinishing();
      nav.toCheckout();
      continue;
    }
    const live = liveSnapshot(rec.snapshot.createdAt);
    if (!snapshotsMatch(rec.snapshot, live)) {
      // Order changed since approval. Fail closed: drop the stale hold (so it does
      // not loop forever) and ask the shopper to redo checkout, which starts a fresh
      // hold + approval against the new order.
      await store.remove(id);
      showOrderChanged(() => nav.toCheckout());
      continue;
    }
    const control = findPlaceOrderControl(document);
    if (!control) {
      // Matches and approved, but the place-order button is unrecognized, so we
      // cannot auto-click. Fail closed: leave it pending and let the shopper place
      // it. The button claims, locks, and places when a control is available, and
      // surfaces a clear message if it cannot (rather than dead-ending silently).
      let manualBusy = false; // debounce: ignore extra taps while one is in flight
      showManualFallback(async () => {
        if (manualBusy) return;
        manualBusy = true;
        try {
          const c = findPlaceOrderControl(document);
          if (!c || !(await claimAndPlace({ id, control: c, store, claim, now }))) {
            showCouldNotComplete();
            manualBusy = false;
          }
          // On success claimAndPlace shows 'finishing' and the page navigates away.
        } catch (e) {
          showCouldNotComplete();
          manualBusy = false;
        }
      });
      continue;
    }
    await claimAndPlace({ id, control, store, claim, now });
  }
}
