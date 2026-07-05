import { RELAY_STATUS } from './relayClient.js';

const KEY = 'parago_requests';

function readAll() {
  return new Promise((resolve) => {
    chrome.storage.local.get({ [KEY]: {} }, (data) => resolve(data[KEY] || {}));
  });
}

function writeAll(map) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [KEY]: map }, () => resolve());
  });
}

// A local stand-in for a real relay. State lives in chrome.storage.local, so requests
// survive a service-worker restart or page reload. The "guardian" approves via the popup.
// idGen/now are injectable for deterministic tests; production uses Date.now/Math.random.
export class MockRelay {
  constructor(opts = {}) {
    this.idGen = opts.idGen
      || (() => 'req_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8));
    this.now = opts.now || (() => Date.now());
  }

  async submitRequest({ total, items }) {
    const id = this.idGen();
    const map = await readAll();
    map[id] = {
      id,
      total: total == null ? null : total,
      items: items || [],
      status: RELAY_STATUS.PENDING,
      createdAt: this.now(),
    };
    await writeAll(map);
    return id;
  }

  async getRequest(id) {
    const map = await readAll();
    return map[id] || null;
  }

  async listPending() {
    const map = await readAll();
    return Object.values(map).filter((r) => r.status === RELAY_STATUS.PENDING);
  }

  // No backend in the mock; the "Order placed" ping is a Supabase-only concern.
  async reportPlaced() { /* no-op */ }
  // Heads-up notification is a Supabase/Telegram-only concern.
  async notify() { /* no-op */ }

  async decide(id, verdict) {
    const map = await readAll();
    if (map[id]) {
      map[id].status = verdict;
      map[id].decidedAt = this.now();
      await writeAll(map);
    }
  }

  onChange(cb) {
    const listener = (changes, area) => {
      if (area === 'local' && changes[KEY]) cb(changes[KEY].newValue || {});
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }
}
