// Pure builder for a Brevo transactional-email payload (POST /v3/smtp/email).
// No network here — the Edge Function does the actual fetch with this object.
function money(n) {
  return (typeof n === 'number' && Number.isFinite(n)) ? n.toFixed(2) : '—';
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// Strip Amazon's hidden "Opens in a new tab" link text (older captures may still carry
// it) and collapse whitespace, so it never shows in the email.
function cleanTitle(s) {
  return String(s == null ? '' : s)
    .replace(/\s+/g, ' ')
    .replace(/\(?\s*opens?\s+in\s+(?:a\s+)?new\s+(?:tab|window)\s*\)?\.?/ig, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
// Un-stick a delivery line captured before the parser fix and drop a leading badge:
// "OvernightFREE delivery Overnight 4 AM - 8 AM" -> "FREE delivery Overnight 4 AM - 8 AM".
function cleanDelivery(s) {
  s = String(s == null ? '' : s).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').trim();
  const m = s.match(/(?:FREE\s+)?delivery\b.*/i) || s.match(/(?:Arrives|Get it)\b.*/i);
  return (m ? m[0] : s).replace(/\s*(?:on \$[\d.,]+ of qualifying items|FREE Returns|Order within).*$/i, '').trim();
}
// Date/window first, then Free or the price ("Tuesday, July 7 - Free").
function formatDelivery(s) {
  s = cleanDelivery(s);
  if (!s) return '';
  const free = /\bFREE\b/i.test(s);
  const costM = s.match(/\$[\d.,]+/);
  const when = s.replace(/\bFREE\b/ig, '').replace(/\bdelivery\b/ig, '').replace(/\$[\d.,]+/g, '')
    .replace(/\s{2,}/g, ' ').replace(/^[\s.,-]+|[\s.,-]+$/g, '').trim();
  const cost = free ? 'Free' : (costM ? costM[0] : '');
  return cost ? `${when} · ${cost}` : when;
}
// A usable product photo, not a loading spinner/placeholder (Amazon's cart spinner is
// /images/G/…loading-large.gif; the real image is /images/I/…).
function isProductPhoto(u) {
  if (typeof u !== 'string' || !/^https?:\/\//i.test(u)) return false;
  return !/\/images\/G\/|loading|spinner|grey-pixel|transparent|\.gif(?:$|\?)/i.test(u);
}
// Render the star/rating meta line for the HTML email. Returns '' when rating is
// not a finite number; omits the review count when reviewCount is missing.
function renderStars(rating, reviewCount) {
  // null/undefined rating: omit the line entirely per contract. Note Number(null)
  // is 0 (finite), so an explicit nullish gate is required before coercion.
  if (rating == null) return '';
  const r = Number(rating);
  if (!Number.isFinite(r)) return '';
  // Clamp to [0,5]: a finite but out-of-range rating (items come from the request
  // body, validated nowhere) would make full/empty negative and crash '☆'.repeat().
  const cr = Math.max(0, Math.min(5, r));
  const r2 = Math.round(cr * 2) / 2;
  const full = Math.floor(r2);
  const half = (r2 - full) === 0.5;
  const empty = 5 - full - (half ? 1 : 0);
  const stars = '★'.repeat(full) + (half ? '½' : '') + '☆'.repeat(empty);
  const rc = Number(reviewCount);
  // null/undefined count: show the rating without the count.
  const count = (reviewCount != null && Number.isFinite(rc)) ? ` · ${rc.toLocaleString()} ratings` : '';
  return `${stars} ${cr.toFixed(1)}${count}`;
}

export function buildBrevoPayload({ senderEmail, senderName, guardianEmail, guardianName, total, items, link }) {
  const list = Array.isArray(items) ? items : [];
  const to = guardianName ? [{ email: guardianEmail, name: guardianName }] : [{ email: guardianEmail }];
  const totalStr = money(total);

  const itemsHtml = list.map((it) => {
    const o = it || {};
    const title = escapeHtml(cleanTitle(o.title) || 'Item');
    // Only emit an <img> for a real product photo (never a loading spinner).
    const img = isProductPhoto(o.image)
      ? `<img src="${escapeHtml(o.image)}" width="96" height="96" alt="" style="vertical-align:top;border:0;border-radius:8px;object-fit:contain;background:#fff" /> `
      : '';
    // Link the title to the product page only for an http(s) url. escapeHtml
    // neutralises quotes/brackets but NOT a "javascript:" scheme (no special
    // chars), so a crafted url from the request body would yield a clickable
    // javascript: link. Match the image guard: scheme-allowlist before linking.
    const safeUrl = (typeof o.url === 'string' && /^https?:\/\//i.test(o.url)) ? o.url : null;
    const titleHtml = safeUrl
      ? `<a href="${escapeHtml(safeUrl)}">${title}</a>`
      : title;
    const meta = renderStars(o.rating, o.reviewCount);
    const metaHtml = meta ? `<div style="color:#888;font-size:12px">${meta}</div>` : '';
    const delivery = (typeof o.delivery === 'string' && o.delivery) ? formatDelivery(o.delivery) : '';
    const deliveryHtml = delivery ? `<div style="color:#555;font-size:12px">${escapeHtml(delivery)}</div>` : '';
    const price = (typeof o.price === 'number') ? ` · $${money(o.price)}` : '';
    const qtyNum = Number(o.qty);
    const qty = (Number.isFinite(qtyNum) && qtyNum > 1) ? ` × ${qtyNum}` : '';
    return `<li style="margin-bottom:12px">${img}${titleHtml}${price}${qty}${metaHtml}${deliveryHtml}</li>`;
  }).join('');
  const itemsText = list.map((it) => {
    const o = it || {};
    const price = (typeof o.price === 'number') ? ` - $${money(o.price)}` : '';
    const qtyNum = Number(o.qty);
    const qty = (Number.isFinite(qtyNum) && qtyNum > 1) ? ` x${qtyNum}` : '';
    const r = Number(o.rating);
    let rating = '';
    if (o.rating != null && Number.isFinite(r)) {
      const rc = Number(o.reviewCount);
      rating = (o.reviewCount != null && Number.isFinite(rc))
        ? ` ${r.toFixed(1)} (${rc.toLocaleString()} ratings)`
        : ` ${r.toFixed(1)}`;
    }
    return `- ${cleanTitle(o.title) || 'Item'}${price}${qty}${rating}`;
  }).join('\n');

  // Name the first item (and a "+N more" count) in the subject, so a guardian with
  // several pending requests can tell them apart at a glance instead of "a purchase".
  const firstTitle = cleanTitle(list[0] && list[0].title).slice(0, 60);
  const moreCount = list.length > 1 ? ` (+${list.length - 1} more)` : '';
  const subject = firstTitle ? `Approve $${totalStr}: ${firstTitle}${moreCount}` : `Approve a purchase: $${totalStr}`;
  const htmlContent =
    `<p>A purchase needs your approval.</p>` +
    `<p><strong>Total: $${totalStr}</strong></p>` +
    `<ul>${itemsHtml}</ul>` +
    `<p><a href="${link}">Review and approve or reject</a></p>` +
    `<p style="color:#888;font-size:12px">This link expires in 24 hours.</p>`;
  const textContent =
    `A purchase needs your approval.\nTotal: $${totalStr}\n${itemsText}\n\nReview: ${link}\n\nThis link expires in 24 hours.`;

  return { sender: { email: senderEmail, name: senderName }, to, subject, htmlContent, textContent };
}
