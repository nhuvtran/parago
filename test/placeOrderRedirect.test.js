// Press-time hold + redirect-to-shopping model (replaces the proactive page-load block
// and the auto-place flow). On a held "Place your order" press we request approval and
// send the shopper back to amazon.com; nothing is ever placed without a fresh human
// click. Approval only UNLOCKS the total (recorded by reconcileApprovals on return).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  armPlaceOrderIntercept, reconcileApprovals,
  _setRelayForTest, _setNavigateForTest, _resetForTest, _setRedirectDelayForTest,
} from '../src/content/checkout.js';

const SHOP_URL = 'https://www.amazon.com/';
let store;
let navTo;

beforeEach(() => {
  store = {};
  navTo = null;
  // Minimal chrome.storage.local over an in-memory object. No chrome.runtime, so
  // enrichItems is a pass-through.
  global.chrome = {
    storage: {
      local: {
        get(query, cb) {
          const out = {};
          for (const k of Object.keys(query)) out[k] = (k in store) ? store[k] : query[k];
          cb(out);
        },
        set(patch, cb) { Object.assign(store, patch); if (cb) cb(); },
      },
    },
  };
  _setNavigateForTest((u) => { navTo = u; });
  _setRedirectDelayForTest(0); // redirect synchronously in tests (no toast delay)
});

afterEach(() => {
  _resetForTest();
  document.body.innerHTML = '';
  delete global.chrome;
});

function placeOrderDom(total) {
  document.body.innerHTML =
    `<div id="sc-active-cart"><div class="sc-list-item" data-asin="A1"><div class="sc-product-title">Widget</div></div></div>` +
    `<div class="grand-total-price"><span class="a-offscreen">$${total}</span></div>` +
    `<input id="placeYourOrder" type="submit" value="Place your order">`;
  return document.getElementById('placeYourOrder');
}

function pressOn(btn) {
  const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
  btn.dispatchEvent(ev);
  return ev;
}

// A real user press fires pointerdown THEN click on the same control. This is the
// sequence a lone synthetic click misses, where the pointerdown+click double-fire bug lives.
function realPress(btn) {
  const down = new MouseEvent('pointerdown', { bubbles: true, cancelable: true });
  btn.dispatchEvent(down);
  const click = new MouseEvent('click', { bubbles: true, cancelable: true });
  btn.dispatchEvent(click);
  return { down, click };
}

// Let the handler's awaited side effects (storage reads, relay submit) settle.
async function flush() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

describe('place-order press → request approval + redirect to shopping', () => {
  it('holds the order, requests approval, and redirects to amazon.com', async () => {
    const relay = { submitRequest: vi.fn(async () => 'id1'), getRequest: vi.fn() };
    _setRelayForTest(relay);
    const btn = placeOrderDom('80.00');
    armPlaceOrderIntercept({ guardianMode: 'always', guardianLimit: 50 }, []);

    const ev = pressOn(btn);
    expect(ev.defaultPrevented).toBe(true); // order blocked synchronously

    await flush();
    expect(relay.submitRequest).toHaveBeenCalledTimes(1);
    expect(relay.submitRequest.mock.calls[0][0].total).toBe(80);
    expect(store.parago_outstanding).toEqual([
      expect.objectContaining({ id: 'id1', total: 80 }),
    ]);
    expect(navTo).toBe(SHOP_URL);
  });

  it('lets the press through (no block) once the total is already approved', async () => {
    const relay = { submitRequest: vi.fn(), getRequest: vi.fn() };
    _setRelayForTest(relay);
    const btn = placeOrderDom('80.00');
    armPlaceOrderIntercept({ guardianMode: 'always', guardianLimit: 50 }, [{ total: 80 }]);

    const ev = pressOn(btn);
    await flush();
    expect(ev.defaultPrevented).toBe(false); // guardian permitted → Amazon places it
    expect(relay.submitRequest).not.toHaveBeenCalled();
    expect(navTo).toBe(null);
  });

  it('consumes the approval: a second press for the same total is blocked again', async () => {
    const relay = { submitRequest: vi.fn(async () => 'id9'), getRequest: vi.fn() };
    _setRelayForTest(relay);
    store.parago_approvals = [{ total: 80 }];
    const btn = placeOrderDom('80.00');
    armPlaceOrderIntercept({ guardianMode: 'always', guardianLimit: 50 }, [{ total: 80 }]);

    const ev1 = pressOn(btn);
    expect(ev1.defaultPrevented).toBe(false); // approved → let through, no request
    await flush();
    expect(relay.submitRequest).not.toHaveBeenCalled();

    // The single-use approval is now spent; the next same-total press must re-request.
    const ev2 = pressOn(btn);
    expect(ev2.defaultPrevented).toBe(true);
    await flush();
    expect(relay.submitRequest).toHaveBeenCalledTimes(1);
  });

  it('approved press: pointerdown AND the trailing click both pass through (not re-blocked)', async () => {
    // Regression: onPlaceOrderPress binds both pointerdown and click. A real press fires
    // both; the pointerdown consumed the approval and the click must NOT then re-block +
    // duplicate-submit + redirect (which left the approved order unplaced on click-activated
    // controls). See the bug-hunt HIGH finding.
    const relay = { submitRequest: vi.fn(async () => 'idX'), getRequest: vi.fn() };
    _setRelayForTest(relay);
    const btn = placeOrderDom('80.00');
    armPlaceOrderIntercept({ guardianMode: 'always', guardianLimit: 50 }, [{ total: 80 }]);

    const { down, click } = realPress(btn);
    await flush();
    expect(down.defaultPrevented).toBe(false);
    expect(click.defaultPrevented).toBe(false); // the trailing click is let through, not blocked
    expect(relay.submitRequest).not.toHaveBeenCalled(); // no duplicate approval request
    expect(navTo).toBe(null); // not bounced back to shopping
  });

  it('approved real press is still single-use: a second full press re-requests', async () => {
    const relay = { submitRequest: vi.fn(async () => 'idY'), getRequest: vi.fn() };
    _setRelayForTest(relay);
    store.parago_approvals = [{ total: 80 }];
    const btn = placeOrderDom('80.00');
    armPlaceOrderIntercept({ guardianMode: 'always', guardianLimit: 50 }, [{ total: 80 }]);

    const p1 = realPress(btn);
    await flush();
    expect(p1.click.defaultPrevented).toBe(false); // approved → placed
    expect(relay.submitRequest).not.toHaveBeenCalled();

    const p2 = realPress(btn);
    expect(p2.down.defaultPrevented).toBe(true); // approval spent → re-blocked
    await flush();
    expect(relay.submitRequest).toHaveBeenCalledTimes(1);
  });

  it('does not block when the total is under the limit', async () => {
    const relay = { submitRequest: vi.fn(), getRequest: vi.fn() };
    _setRelayForTest(relay);
    const btn = placeOrderDom('10.00');
    armPlaceOrderIntercept({ guardianMode: 'over_limit', guardianLimit: 50 }, []);

    const ev = pressOn(btn);
    await flush();
    expect(ev.defaultPrevented).toBe(false);
    expect(relay.submitRequest).not.toHaveBeenCalled();
    expect(navTo).toBe(null);
  });

  it('blocks repeat presses during the request window and submits only once', async () => {
    const relay = { submitRequest: vi.fn(async () => 'id1'), getRequest: vi.fn() };
    _setRelayForTest(relay);
    const btn = placeOrderDom('80.00');
    armPlaceOrderIntercept({ guardianMode: 'always', guardianLimit: 50 }, []);

    const ev1 = pressOn(btn);
    const ev2 = pressOn(btn);
    expect(ev1.defaultPrevented).toBe(true);
    expect(ev2.defaultPrevented).toBe(true); // second tap is re-prevented, not let through

    await flush();
    expect(relay.submitRequest).toHaveBeenCalledTimes(1);
  });

  it('fails closed: a relay error still leaves the order unplaced (it was prevented)', async () => {
    const relay = { submitRequest: vi.fn(async () => { throw new Error('offline'); }), getRequest: vi.fn() };
    _setRelayForTest(relay);
    const btn = placeOrderDom('80.00');
    armPlaceOrderIntercept({ guardianMode: 'always', guardianLimit: 50 }, []);

    const ev = pressOn(btn);
    expect(ev.defaultPrevented).toBe(true); // blocked regardless of the later throw
    await flush();
    expect(navTo).toBe(SHOP_URL); // still sent back to shopping; nothing was bought
  });
});

describe('reconcileApprovals (notify-only completion, never places)', () => {
  it('records an approval for an approved outstanding request and drops it', async () => {
    store.parago_outstanding = [{ id: 'r1', total: 80 }];
    store.parago_approvals = [];
    _setRelayForTest({ getRequest: async (id) => ({ id, status: 'approved', total: 80 }) });

    await reconcileApprovals();

    expect(store.parago_approvals).toEqual([expect.objectContaining({ total: 80 })]);
    expect(store.parago_outstanding).toEqual([]);
  });

  it('drops a rejected request without recording an approval', async () => {
    store.parago_outstanding = [{ id: 'r2', total: 5 }];
    store.parago_approvals = [];
    _setRelayForTest({ getRequest: async (id) => ({ id, status: 'rejected', total: 5 }) });

    await reconcileApprovals();

    expect(store.parago_approvals).toEqual([]);
    expect(store.parago_outstanding).toEqual([]);
  });

  it('drops an expired request so it never deadlocks new requests for that total', async () => {
    // Regression: 'expired' is a terminal status get-status returns at HTTP 200. If kept in
    // outstanding, onPlaceOrderPress dedupes against it forever and never re-notifies.
    store.parago_outstanding = [{ id: 'x1', total: 75 }];
    store.parago_approvals = [];
    _setRelayForTest({ getRequest: async (id) => ({ id, status: 'expired', total: 75 }) });

    await reconcileApprovals();

    expect(store.parago_approvals).toEqual([]);
    expect(store.parago_outstanding).toEqual([]); // dropped, so a retry sends a fresh request
  });

  it('keeps a still-pending request and one that errored (transient)', async () => {
    store.parago_outstanding = [{ id: 'p1', total: 5 }, { id: 'e1', total: 9 }];
    store.parago_approvals = [];
    _setRelayForTest({
      getRequest: async (id) => {
        if (id === 'e1') throw new Error('5xx');
        return { id, status: 'pending', total: 5 };
      },
    });

    await reconcileApprovals();

    expect(store.parago_approvals).toEqual([]);
    expect(store.parago_outstanding).toEqual([
      { id: 'p1', total: 5 },
      { id: 'e1', total: 9 },
    ]);
  });
});
