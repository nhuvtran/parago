// Auto-place mode (opt-in). A held press must, in ADDITION to the unlock-mode behavior,
// record an order snapshot keyed by the request id (so runPlacementCompletion can later
// claim + place it), and must NOT redirect the shopper away — it stays on checkout so the
// poll can complete the order in place. Unlock mode (default) must be byte-for-byte the
// same as before: redirect to shopping, no placement record.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { armPlaceOrderIntercept, reconcileApprovals, _setRelayForTest, _setNavigateForTest, _resetForTest, _setRedirectDelayForTest } from '../src/content/checkout.js';

const SHOP_URL = 'https://www.amazon.com/';
let store, navTo;

beforeEach(() => {
  store = {};
  navTo = null;
  global.chrome = {
    storage: {
      local: {
        get(query, cb) { const out = {}; for (const k of Object.keys(query)) out[k] = (k in store) ? store[k] : query[k]; cb(out); },
        set(patch, cb) { Object.assign(store, patch); if (cb) cb(); },
      },
    },
  };
  _setNavigateForTest((u) => { navTo = u; });
  _setRedirectDelayForTest(0);
});
afterEach(() => { _resetForTest(); document.body.innerHTML = ''; delete global.chrome; });

function placeOrderDom(total) {
  document.body.innerHTML =
    `<div id="sc-active-cart"><div class="sc-list-item" data-asin="A1"><div class="sc-product-title">Widget</div></div></div>` +
    `<div class="grand-total-price"><span class="a-offscreen">$${total}</span></div>` +
    `<input id="placeYourOrder" type="submit" value="Place your order">`;
  return document.getElementById('placeYourOrder');
}
function press(btn) { const ev = new MouseEvent('click', { bubbles: true, cancelable: true }); btn.dispatchEvent(ev); return ev; }
async function flush() { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); }

describe('auto-place mode: hold press records a placement snapshot and stays on checkout', () => {
  it('writes a parago_placements record keyed by the request id and does NOT navigate away', async () => {
    _setRelayForTest({ submitRequest: vi.fn(async () => 'idAP'), getRequest: vi.fn() });
    const btn = placeOrderDom('80.00');
    armPlaceOrderIntercept({ guardianMode: 'always', guardianLimit: 50, autoPlace: true }, []);

    const ev = press(btn);
    expect(ev.defaultPrevented).toBe(true); // order still blocked synchronously (safety kept)

    await flush();
    // Outstanding marker still written (dedupe), same as unlock mode.
    expect(store.parago_outstanding).toEqual([expect.objectContaining({ id: 'idAP', total: 80 })]);
    // NEW: a placement record keyed by the same id, with a snapshot of the order.
    const rec = store.parago_placements && store.parago_placements.idAP;
    expect(rec).toBeTruthy();
    expect(rec.status).toBe('pending');
    expect(rec.snapshot.total).toBe(80);
    expect(rec.snapshot.items.map((i) => i.asin)).toEqual(['A1']);
    // Auto-place stays on the page (no redirect) so the poll can complete it.
    expect(navTo).toBe(null);
  });
});

describe('no double-place across a mode switch (auto-placed order is not re-minted as a manual approval)', () => {
  it('does NOT record a manual-unlock approval when the placement record shows it was placed', async () => {
    // Auto-place already placed REQ1; the request is still "approved" relay-side. Switching
    // to unlock mode must not turn that into a by-total approval that unlocks a 2nd buy.
    store.parago_outstanding = [{ id: 'REQ1', total: 60 }];
    store.parago_approvals = [];
    store.parago_placements = { REQ1: { status: 'placed', snapshot: {}, createdAt: 1 } };
    _setRelayForTest({ getRequest: async (id) => ({ id, status: 'approved', total: 60 }) });

    await reconcileApprovals();

    expect(store.parago_approvals).toEqual([]);       // NOT minted → no manual re-buy
    expect(store.parago_outstanding).toEqual([]);     // dropped
  });

  it('still records an approval when there is no terminal placement record (unlock can complete it)', async () => {
    store.parago_outstanding = [{ id: 'REQ2', total: 60 }];
    store.parago_approvals = [];
    store.parago_placements = { REQ2: { status: 'pending', snapshot: {}, createdAt: 1 } };
    _setRelayForTest({ getRequest: async (id) => ({ id, status: 'approved', total: 60 }) });

    await reconcileApprovals();

    expect(store.parago_approvals).toEqual([expect.objectContaining({ total: 60 })]);
  });
});

describe('unlock mode (default) is unchanged: redirect, no placement record', () => {
  it('navigates to shopping and writes NO parago_placements record', async () => {
    _setRelayForTest({ submitRequest: vi.fn(async () => 'idUL'), getRequest: vi.fn() });
    const btn = placeOrderDom('80.00');
    armPlaceOrderIntercept({ guardianMode: 'always', guardianLimit: 50, autoPlace: false }, []);

    press(btn);
    await flush();
    expect(navTo).toBe(SHOP_URL);
    expect(store.parago_placements).toBeUndefined();
  });
});
