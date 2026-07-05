// src/content/placementOverlay.js
// Every placement state renders as a small, non-blocking corner toast (below
// Amazon's nav), not a full-page block. The shipped flow redirects instead of
// auto-placing, so there is no live "Place your order" button to cover.
import { t } from '../i18n/i18n.js';

const TOAST_ID = 'parago-placement-toast';

export function isPlacementOverlayShown() {
  return !!document.getElementById(TOAST_ID);
}

export function removePlacementOverlay() {
  const el = document.getElementById(TOAST_ID);
  if (el) el.remove();
}

// One corner toast with an optional body line and one action button. Replaces any
// prior placement toast so states swap in place.
function toast({ title, body, button, onButton }) {
  removePlacementOverlay();
  const el = document.createElement('div');
  el.id = TOAST_ID;

  const h = document.createElement('div');
  h.className = 'parago-pl-toast-title';
  h.textContent = title;
  el.appendChild(h);

  if (body) {
    const p = document.createElement('div');
    p.className = 'parago-pl-toast-body';
    p.textContent = body;
    el.appendChild(p);
  }

  if (button && onButton) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'parago-pl-toast-btn';
    b.textContent = button;
    b.addEventListener('click', onButton);
    el.appendChild(b);
  }

  document.body.appendChild(el);
  return el;
}

export function showProcessing() {
  return toast({ title: t('placement_processing_title'), body: t('placement_processing_body') });
}
export function showFinishing() {
  return toast({ title: t('placement_finishing') });
}
export function showConfirmed() {
  return toast({ title: t('placement_confirmed') });
}
export function showCouldNotComplete() {
  return toast({ title: t('placement_failed') });
}
export function showManualFallback(onPlace) {
  return toast({ title: t('placement_manual_title'), body: t('placement_manual_body'),
    button: t('placement_manual_button'), onButton: onPlace });
}
export function showOrderChanged(onReview) {
  return toast({ title: t('placement_changed_title'), body: t('placement_changed_body'),
    button: t('placement_changed_button'), onButton: onReview });
}
