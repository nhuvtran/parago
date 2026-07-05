// Shopper-side relay backed by Supabase Edge Functions. Implements the relay
// contract from relayClient.js EXCEPT decide()/listPending-as-guardian — status
// changes happen server-side via the emailed decision link, never from here.
//
// Injectable deps (mirroring MockRelay): `send` (transport) and `store`
// (a {get,set} over a small id->record map, default chrome.storage.local).
const STORE_KEY = 'parago_supabase_pending';

function chromeStore() {
  return {
    get: () => new Promise((r) => chrome.storage.local.get({ [STORE_KEY]: {} }, (d) => r(d[STORE_KEY] || {}))),
    set: (v) => new Promise((r) => chrome.storage.local.set({ [STORE_KEY]: v }, () => r())),
  };
}

// Default transport: round-trip through the background service worker.
function bgSend(url, options) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'parago_fetch', url, options }, (resp) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!resp || !resp.ok) return reject(new Error('relay_fetch_failed_' + (resp && resp.status)));
      resolve(resp.body);
    });
  });
}

export class SupabaseRelay {
  constructor({ baseUrl, guardianEmail, guardianName = null, deliveryMethod = 'email', telegramLinkCode = null, githubUsername = null, timezone = null, theme = null, appButton = true, send, store, pollMs } = {}) {
    this.baseUrl = String(baseUrl || '').replace(/\/$/, '');
    this.guardianEmail = guardianEmail;
    this.guardianName = guardianName;
    this.deliveryMethod = deliveryMethod;
    this.telegramLinkCode = telegramLinkCode;
    this.githubUsername = githubUsername;
    this.timezone = timezone;
    this.theme = theme;
    this.appButton = appButton;
    this.send = send || bgSend;
    this.store = store || chromeStore();
    this.pollMs = pollMs || 3000;
  }

  async submitRequest({ total, items, breakdown, shipTo, payment, shipName, shipAddress }) {
    const body = await this.send(`${this.baseUrl}/create-request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        total, items: items || [], breakdown: breakdown || null,
        shipTo: shipTo || null, payment: payment || null,
        shipName: shipName || null, shipAddress: shipAddress || null,
        timezone: this.timezone || null,
        theme: this.theme || null,
        appButton: this.appButton !== false,
        deliveryMethod: this.deliveryMethod,
        guardianEmail: this.guardianEmail, guardianName: this.guardianName,
        telegramLinkCode: this.telegramLinkCode,
        githubUsername: this.githubUsername,
      }),
    });
    const id = body && body.id;
    if (!id) throw new Error('create_request_no_id');
    const map = await this.store.get();
    map[id] = { id, total: total == null ? null : total, createdAt: Date.now(), status: 'pending' };
    await this.store.set(map);
    return id;
  }

  // Heads-up for a purchase that did NOT need approval: a buttonless Telegram notification.
  // Fire-and-forget; no id/token comes back. Telegram delivery only.
  async notify({ total, items, breakdown, shipTo, payment, shipName, shipAddress }) {
    await this.send(`${this.baseUrl}/create-request`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        notifyOnly: true, total, items: items || [], breakdown: breakdown || null,
        shipTo: shipTo || null, payment: payment || null, shipName: shipName || null, shipAddress: shipAddress || null,
        timezone: this.timezone || null, deliveryMethod: 'telegram', telegramLinkCode: this.telegramLinkCode,
      }),
    });
  }

  async getRequest(id) {
    const body = await this.send(`${this.baseUrl}/get-status?id=${id}`);
    if (!body || body.error) return null;
    return { id: body.id, status: body.status, total: body.total, decidedAt: body.decidedAt, items: [] };
  }

  // Tell the backend an approved order actually completed, so the guardian gets an
  // "Order placed" ping. Best-effort + idempotent server-side (placed_at).
  async reportPlaced(id) {
    if (!id) return;
    await this.send(`${this.baseUrl}/order-placed`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
    });
  }

  async listPending() {
    const map = await this.store.get();
    const out = [];
    let changed = false;
    for (const id of Object.keys(map)) {
      let fresh;
      try {
        fresh = await this.getRequest(id);
      } catch (e) {
        // Transient failure (offline / 5xx): KEEP the cached entry. Evicting here
        // would make the next engage submit a fresh request → a duplicate email.
        out.push(map[id]);
        continue;
      }
      if (fresh && fresh.status === 'pending') {
        out.push(map[id]);
      } else {
        // Definitive non-pending (approved/rejected/expired) or not_found (null) → forget it.
        delete map[id]; changed = true;
      }
    }
    if (changed) await this.store.set(map);
    return out;
  }

  // Poll EVERY cached pending id (not a single "active" id) and emit the full
  // map, matching MockRelay's contract. This guarantees checkout's
  // map[activeRequestId] lookup resolves regardless of which cached request is
  // the active one (the reuse path never calls submitRequest, so there is no
  // single active id to track). Fires cb only when some status changed.
  onChange(cb) {
    const lastStatus = {}; // id -> last seen status
    const tick = async () => {
      const map = await this.store.get().catch(() => ({}));
      const ids = Object.keys(map);
      if (!ids.length) return;
      const out = {};
      let changed = false;
      for (const id of ids) {
        const rec = await this.getRequest(id).catch(() => null);
        if (!rec) continue;
        out[id] = rec;
        if (rec.status !== lastStatus[id]) { lastStatus[id] = rec.status; changed = true; }
      }
      if (changed) cb(out);
    };
    const handle = setInterval(tick, this.pollMs);
    return () => clearInterval(handle);
  }
}
