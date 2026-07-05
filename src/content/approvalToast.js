// Parago's on-page notification toast: the banner a shopper sees near the top of the
// Amazon page (below the logo/nav) when a purchase is held and sent to the approver.
// Pure DOM, no imports — callers pass already-localized strings. Styled by devPanel.css
// (loaded on every Amazon page), so it's available wherever a content script shows it.
export function showApprovalToast({ title, body, duration = 5000 } = {}) {
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  let host = document.getElementById('parago-approval-toast');
  if (!host) {
    host = el('div');
    host.id = 'parago-approval-toast';
    (document.body || document.documentElement).appendChild(host);
  }
  host.textContent = '';
  const card = el('div', 'parago-at-card');
  const txt = el('div', 'parago-at-text');
  txt.appendChild(el('div', 'parago-at-title', title || 'Sent for approval'));
  if (body) txt.appendChild(el('div', 'parago-at-body', body));
  card.appendChild(txt);
  host.appendChild(card);
  // Force reflow so the .show transition runs even on a freshly-created node.
  void host.offsetWidth;
  host.classList.add('show');
  clearTimeout(showApprovalToast._t);
  showApprovalToast._t = setTimeout(() => host.classList.remove('show'), duration);
}
