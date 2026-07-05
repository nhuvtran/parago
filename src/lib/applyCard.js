import { t, getLang } from '../i18n/i18n.js';

const GREY_CLASS = 'parago-greyed';
const BADGE_CLASS = 'parago-badge';

// Defensive, priority-ordered selectors for the box that visually bounds the product
// image inside an Amazon search-result card. Most specific/stable first, ending in a bare
// <img>. Used only to MEASURE where the image is — the badge is never reparented into it.
const IMG_TARGET_SELECTOR =
  '.s-product-image-container, [data-cy="image-container"], .s-image-fixed-height, img.s-image, img';

// Position the badge over the product image's top-left corner WITHOUT moving the image and
// WITHOUT reparenting the badge. The badge stays a direct child of the card, so:
//   - it is exempt from the dim rule (`.parago-greyed > *:not(.parago-badge)`) and renders
//     crisp — reparenting it under a dimmed wrapper would composite it into the group and
//     grey it out (opacity/filter create a stacking/compositing group on every descendant);
//   - its explainer popover is not clipped by the image container's overflow:hidden.
// We shift the badge's absolute offsets using getBoundingClientRect DELTAS relative to the
// card. Deltas are correct no matter how deeply Amazon nests the image or what is
// positioned in between (unlike offsetTop, which depends on the offsetParent). If no image
// is found or layout is not ready (zero-size rect, e.g. jsdom), the badge keeps its CSS
// default top:8px/left:8px (the card's own corner).
function positionBadge(card, badge) {
  const target = card.querySelector(IMG_TARGET_SELECTOR);
  if (!target || typeof target.getBoundingClientRect !== 'function') return;
  const cardRect = card.getBoundingClientRect();
  const imgRect = target.getBoundingClientRect();
  if (imgRect.width === 0 && imgRect.height === 0) return; // not laid out yet
  badge.style.top = (imgRect.top - cardRect.top + 8) + 'px';
  badge.style.left = (imgRect.left - cardRect.left + 8) + 'px';
}

const REASON_KEYS = {
  sponsored: 'badge_sponsored',
  low_rating: 'badge_low_rating',
  few_ratings: 'badge_few_ratings',
  no_reviews: 'badge_no_reviews',
  not_prime: 'badge_not_prime',
  over_price: 'badge_over_price',
};

// Short explanations shown in the hover/focus popover, per reason.
const WHY_KEYS = {
  sponsored: 'why_sponsored',
  low_rating: 'why_low_rating',
  few_ratings: 'why_few_ratings',
  no_reviews: 'why_no_reviews',
  not_prime: 'why_not_prime',
  over_price: 'why_over_price',
};

// Canonical display order for badge text and popover lines.
const REASON_ORDER = ['sponsored', 'low_rating', 'few_ratings', 'no_reviews', 'not_prime', 'over_price'];

export function badgeText(reasons) {
  return REASON_ORDER
    .filter((r) => reasons.includes(r))
    .map((r) => t(REASON_KEYS[r]))
    .join(' · ');
}

export function removeApplied(card) {
  card.classList.remove(GREY_CLASS);
  card.style.display = '';
  // Remove every badge. The badge is a direct child of the card, but we scan the whole
  // subtree defensively; it is a uniquely-classed, parago-owned element, so this only ever
  // matches our own nodes.
  for (const b of card.querySelectorAll('.' + BADGE_CLASS)) b.remove();
  delete card.dataset.paragoApplied;
}

export function applyCard(card, decision, mode) {
  // Stamp includes language so a language switch forces re-localization.
  const stamp = getLang() + ':' + mode + ':' + decision.reasons.slice().sort().join(',');
  if (card.dataset.paragoApplied === stamp) return; // idempotent
  removeApplied(card);

  const shouldFlag = decision.flagged && decision.reasons.length > 0 && mode !== 'off';
  if (shouldFlag) {
    if (mode === 'hide') {
      card.style.display = 'none';
    } else {
      card.classList.add(GREY_CLASS);
      const badge = document.createElement('div');
      badge.className = BADGE_CLASS;
      badge.setAttribute('role', 'note');
      const label = document.createElement('span');
      label.textContent = badgeText(decision.reasons);
      badge.appendChild(label);
      const SVGNS = 'http://www.w3.org/2000/svg';
      const icon = document.createElementNS(SVGNS, 'svg');
      icon.setAttribute('class', 'parago-badge-icon');
      icon.setAttribute('viewBox', '0 0 16 16');
      icon.setAttribute('width', '13');
      icon.setAttribute('height', '13');
      icon.setAttribute('fill', 'none');
      icon.setAttribute('aria-hidden', 'true');
      const ring = document.createElementNS(SVGNS, 'circle');
      ring.setAttribute('cx', '8');
      ring.setAttribute('cy', '8');
      ring.setAttribute('r', '6.85');
      ring.setAttribute('stroke', 'currentColor');
      ring.setAttribute('stroke-width', '1.2');
      const stem = document.createElementNS(SVGNS, 'line');
      stem.setAttribute('x1', '8');
      stem.setAttribute('y1', '7.1');
      stem.setAttribute('x2', '8');
      stem.setAttribute('y2', '11.4');
      stem.setAttribute('stroke', 'currentColor');
      stem.setAttribute('stroke-width', '1.4');
      stem.setAttribute('stroke-linecap', 'round');
      const dot = document.createElementNS(SVGNS, 'circle');
      dot.setAttribute('cx', '8');
      dot.setAttribute('cy', '4.7');
      dot.setAttribute('r', '0.55');
      dot.setAttribute('fill', 'currentColor');
      icon.appendChild(ring);
      icon.appendChild(stem);
      icon.appendChild(dot);
      badge.appendChild(icon);

      // Hover/focus popover that explains why this item was flagged.
      badge.setAttribute('tabindex', '0');
      const pop = document.createElement('div');
      pop.className = 'parago-pop';
      const popTitle = document.createElement('div');
      popTitle.className = 'parago-pop-title';
      popTitle.textContent = t('why_title');
      pop.appendChild(popTitle);
      const reasonList = document.createElement('ul');
      for (const r of REASON_ORDER) {
        if (decision.reasons.includes(r)) {
          const li = document.createElement('li');
          li.textContent = t(WHY_KEYS[r]);
          reasonList.appendChild(li);
        }
      }
      pop.appendChild(reasonList);
      badge.appendChild(pop);

      // Badge is a direct child of the card (so it is exempt from dimming and its popover
      // is never clipped). It stays an inert <div> (no aria-label), so parseCard keeps
      // ignoring it and the observer loop stays quiescent. positionBadge then shifts its
      // absolute offsets to sit on the product image's corner.
      card.prepend(badge);
      positionBadge(card, badge);
    }
  }
  // Always stamp (including clean/off cards) so rescans skip already-correct cards.
  card.dataset.paragoApplied = stamp;
}
