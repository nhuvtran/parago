// src/lib/orderSnapshot.js
// A snapshot is what the guardian approved. Before placing later we compare it to
// the live order; on any mismatch we re-approve rather than buy something unseen.
const DEFAULT_TOTAL_EPSILON = 0.005;

function normItem(it) {
  return {
    asin: it.asin || null,
    qty: Number.isFinite(it.qty) ? it.qty : 1,
    title: (it.title || '').replace(/\s+/g, ' ').trim(),
  };
}

export function buildSnapshot({ items = [], total = null, address = null, payment = null } = {}, createdAt = 0) {
  return {
    items: (items || []).map(normItem),
    total: total == null ? null : Number(total),
    addressHint: address ? String(address).trim() : null,
    payment: payment ? String(payment).trim() : null,
    createdAt,
  };
}

function totalsMatch(x, y, eps) {
  if (x == null || y == null || Number.isNaN(x) || Number.isNaN(y)) return false;
  return Math.abs(x - y) < eps;
}

function keyCounts(items) {
  const m = {};
  for (const it of (items || [])) {
    const key = it.asin || ('title:' + (it.title || ''));
    m[key] = (m[key] || 0) + (Number.isFinite(it.qty) ? it.qty : 1);
  }
  return m;
}

export function snapshotsMatch(a, b, { totalEpsilon = DEFAULT_TOTAL_EPSILON } = {}) {
  if (!a || !b) return false;
  if (!totalsMatch(a.total, b.total, totalEpsilon)) return false;
  // Item integrity is the whole point of the snapshot: refuse to match when EITHER side
  // has no items (a page we couldn't parse), so a total-only match can never auto-place
  // and an item swap that preserves the total is never placed unverified.
  if (!a.items || !a.items.length || !b.items || !b.items.length) return false;
  const ka = keyCounts(a.items), kb = keyCounts(b.items);
  const keys = new Set([...Object.keys(ka), ...Object.keys(kb)]);
  for (const k of keys) if ((ka[k] || 0) !== (kb[k] || 0)) return false;
  // Destination + payment the guardian saw must not have changed since approval. Tolerant
  // of nulls: a page that doesn't expose one skips that check rather than blocking every
  // order, but when both sides carry a value they must be equal.
  if (a.addressHint != null && b.addressHint != null && a.addressHint !== b.addressHint) return false;
  if (a.payment != null && b.payment != null && a.payment !== b.payment) return false;
  return true;
}
