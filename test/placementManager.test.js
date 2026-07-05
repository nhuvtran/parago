// test/placementManager.test.js
import { describe, it, expect, afterEach } from 'vitest';
import { runPlacementCompletion } from '../src/content/placementManager.js';
import { createPlacementStore } from '../src/lib/placementStore.js';
import { buildSnapshot } from '../src/lib/orderSnapshot.js';
import { _resetSuppress } from '../src/content/interceptGuard.js';

function fakeStore(seed = {}) {
  let data = { ...seed };
  return { get: async () => ({ ...data }), set: async (v) => { data = { ...v }; } };
}
function relayWith(statusById) {
  return { getRequest: async (id) => (statusById[id] ? { id, status: statusById[id] } : null) };
}
function liveCheckoutDom(total) {
  document.body.innerHTML =
    `<div id="sc-active-cart"><div class="sc-list-item" data-asin="A1"><div class="sc-product-title">Widget</div></div></div>` +
    `<input id="placeYourOrder" type="submit" value="Place your order">` +
    `<div class="grand-total-price"><span class="a-offscreen">$${total}</span></div>`;
}
const grant = async () => true;
const deny = async () => false;

afterEach(() => { document.body.innerHTML = ''; _resetSuppress(); });

const snap = buildSnapshot({ items: [{ asin: 'A1', title: 'Widget' }], total: 10 }, 1);

describe('runPlacementCompletion', () => {
  it('places an approved order that matches, on the checkout page', async () => {
    liveCheckoutDom('10.00');
    let clicked = false;
    document.getElementById('placeYourOrder').addEventListener('click', () => { clicked = true; });
    const store = createPlacementStore(fakeStore({ id1: { snapshot: snap, status: 'pending', createdAt: 1 } }));
    await runPlacementCompletion({
      relay: relayWith({ id1: 'approved' }), store,
      nav: { toCheckout() {} }, pageKind: () => 'checkout', claim: grant, now: () => 1000,
    });
    expect(clicked).toBe(true);
    const r = await store.get('id1');
    expect(r.status).toBe('placing');
    expect(r.placingAt).toBe(1000);
  });

  it('does NOT place when another tab holds the claim', async () => {
    liveCheckoutDom('10.00');
    let clicked = false;
    document.getElementById('placeYourOrder').addEventListener('click', () => { clicked = true; });
    const store = createPlacementStore(fakeStore({ id1: { snapshot: snap, status: 'pending', createdAt: 1 } }));
    await runPlacementCompletion({
      relay: relayWith({ id1: 'approved' }), store,
      nav: { toCheckout() {} }, pageKind: () => 'checkout', claim: deny, now: () => 1000,
    });
    expect(clicked).toBe(false);
    expect((await store.get('id1')).status).toBe('pending'); // stays claimable for a retry
  });

  it('drops the stale hold and surfaces "order changed" when the live total drifted', async () => {
    liveCheckoutDom('999.00');
    let clicked = false;
    document.getElementById('placeYourOrder').addEventListener('click', () => { clicked = true; });
    const store = createPlacementStore(fakeStore({ id1: { snapshot: snap, status: 'pending', createdAt: 1 } }));
    await runPlacementCompletion({
      relay: relayWith({ id1: 'approved' }), store,
      nav: { toCheckout() {} }, pageKind: () => 'checkout', claim: grant, now: () => 1000,
    });
    expect(clicked).toBe(false);
    expect(await store.get('id1')).toBeNull();
  });

  it('navigates to checkout when approved but not on the checkout page', async () => {
    const store = createPlacementStore(fakeStore({ id1: { snapshot: snap, status: 'pending', createdAt: 1 } }));
    let navigated = false;
    await runPlacementCompletion({
      relay: relayWith({ id1: 'approved' }), store,
      nav: { toCheckout() { navigated = true; } }, pageKind: () => 'other', claim: grant, now: () => 1000,
    });
    expect(navigated).toBe(true);
  });

  it('finalizes to placed on the confirmation page when locked as placing', async () => {
    document.body.innerHTML = `<div id="widget-purchaseConfirmationStatus">ok</div>`;
    const store = createPlacementStore(fakeStore({ id1: { snapshot: snap, status: 'placing', placingAt: 1, createdAt: 1 } }));
    await runPlacementCompletion({
      relay: relayWith({ id1: 'approved' }), store,
      nav: { toCheckout() {} }, pageKind: () => 'checkout', claim: grant, now: () => 1000,
    });
    expect((await store.get('id1')).status).toBe('placed');
  });

  it('reports the placement to the backend (guardian "Order placed" ping) on finalize', async () => {
    document.body.innerHTML = `<div id="widget-purchaseConfirmationStatus">ok</div>`;
    const store = createPlacementStore(fakeStore({ id1: { snapshot: snap, status: 'placing', placingAt: 1, createdAt: 1 } }));
    const placed = [];
    const relay = { getRequest: async (id) => ({ id, status: 'approved' }), reportPlaced: async (id) => placed.push(id) };
    await runPlacementCompletion({ relay, store, nav: { toCheckout() {} }, pageKind: () => 'checkout', claim: grant, now: () => 1000 });
    expect(placed).toEqual(['id1']); // exactly the placed id, once
  });

  it('fails a placing order that never confirms within the bounded wait', async () => {
    document.body.innerHTML = `<div>no confirmation here</div>`;
    const store = createPlacementStore(fakeStore({ id1: { snapshot: snap, status: 'placing', placingAt: 1, createdAt: 1 } }));
    await runPlacementCompletion({
      relay: relayWith({ id1: 'approved' }), store,
      nav: { toCheckout() {} }, pageKind: () => 'checkout', claim: grant, now: () => 10_000_000,
    });
    expect((await store.get('id1')).status).toBe('failed');
  });

  it('clears and surfaces failure when rejected', async () => {
    const store = createPlacementStore(fakeStore({ id1: { snapshot: snap, status: 'pending', createdAt: 1 } }));
    await runPlacementCompletion({
      relay: relayWith({ id1: 'rejected' }), store,
      nav: { toCheckout() {} }, pageKind: () => 'other', claim: grant, now: () => 1000,
    });
    expect(await store.get('id1')).toBeNull();
  });

  it('keeps the record on a transient null status (does not discard an approval)', async () => {
    const store = createPlacementStore(fakeStore({ id1: { snapshot: snap, status: 'pending', createdAt: 1 } }));
    await runPlacementCompletion({
      relay: relayWith({}), store, // getRequest -> null (transient/error)
      nav: { toCheckout() {} }, pageKind: () => 'checkout', claim: grant, now: () => 1000,
    });
    const r = await store.get('id1');
    expect(r).not.toBeNull();
    expect(r.status).toBe('pending');
  });

  it('ignores still-pending orders', async () => {
    const store = createPlacementStore(fakeStore({ id1: { snapshot: snap, status: 'pending', createdAt: 1 } }));
    await runPlacementCompletion({
      relay: relayWith({ id1: 'pending' }), store,
      nav: { toCheckout() {} }, pageKind: () => 'checkout', claim: grant, now: () => 1000,
    });
    expect((await store.get('id1')).status).toBe('pending');
  });

  it('manual fallback surfaces feedback instead of dead-ending when it cannot place', async () => {
    // Approved + matching total, but NO recognizable place-order button -> manual fallback.
    document.body.innerHTML =
      `<div id="sc-active-cart"><div class="sc-list-item" data-asin="A1"><div class="sc-product-title">Widget</div></div></div>` +
      `<div class="grand-total-price"><span class="a-offscreen">$10.00</span></div>`;
    const store = createPlacementStore(fakeStore({ id1: { snapshot: snap, status: 'pending', createdAt: 1 } }));
    await runPlacementCompletion({
      relay: relayWith({ id1: 'approved' }), store,
      nav: { toCheckout() {} }, pageKind: () => 'checkout', claim: deny, now: () => 1000,
    });
    const btn = document.querySelector('.parago-pl-toast-btn');
    expect(btn).not.toBeNull();
    btn.click();
    await Promise.resolve(); await Promise.resolve();
    expect(document.body.textContent).toContain("couldn't be completed");
  });

  it('ages out a record that never resolved', async () => {
    const store = createPlacementStore(fakeStore({ id1: { snapshot: snap, status: 'pending', createdAt: 1 } }));
    await runPlacementCompletion({
      relay: relayWith({ id1: 'pending' }), store,
      nav: { toCheckout() {} }, pageKind: () => 'checkout', claim: grant,
      now: () => 1 + 49 * 60 * 60 * 1000, // 49h later
    });
    expect(await store.get('id1')).toBeNull();
  });
});
