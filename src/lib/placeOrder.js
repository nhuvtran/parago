// src/lib/placeOrder.js
// All DOM coupling to Amazon's checkout lives here. Selectors are defensive and
// expected to need updates when Amazon changes pages. Everything fails closed:
// "not found" returns null/false, never a guess.
import { parseCurrency } from './parseCart.js';

const PLACE_ORDER_SELECTORS = [
  '#placeYourOrder input',
  'input[name="placeYourOrder1"]',
  '#submitOrderButtonId input',
  '#bottomSubmitOrderButtonId input',
  '[data-testid="bottom-submit-button"] button',
  '[data-testid="place-order-button"]',
  '#placeYourOrder',
];
const PLACE_ORDER_TEXT_RE = /place\s+(your\s+)?order/i;

export function findPlaceOrderControl(root = document) {
  for (const sel of PLACE_ORDER_SELECTORS) {
    const el = root.querySelector(sel);
    if (el) return el;
  }
  for (const el of root.querySelectorAll('input[type="submit"], button, a[role="button"], span.a-button-text')) {
    const label = el.value || el.textContent || el.getAttribute('aria-label') || '';
    if (PLACE_ORDER_TEXT_RE.test(label)) return el.closest('button, input, a, [role="button"]') || el;
  }
  return null;
}

export function clickPlaceOrder(control) {
  if (!control) return false;
  // ponytail: dry-run hook for testing Stage 3 without spending money. Run
  // localStorage.__paragoDryRun = '1' once in the amazon.com console; it survives
  // navigation and is readable here, so the whole drive (nav, snapshot match,
  // control detection) runs but the final click is logged instead of fired.
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem('__paragoDryRun')) {
      console.log('[parago dry-run] would place order via', control);
      return true;
    }
  } catch (e) { /* storage blocked: fall through to a real click */ }
  control.click();
  return true;
}

export function isPlaceOrderClick(ev, root = document) {
  const control = findPlaceOrderControl(root);
  if (!control) return false;
  const path = typeof ev.composedPath === 'function' ? ev.composedPath() : [];
  if (path.includes(control)) return true;
  let n = ev.target;
  while (n) { if (n === control) return true; n = n.parentElement; }
  return !!(ev.target && control.contains(ev.target));
}

// Is there a "place your order" affordance on this page at all? Deliberately wider
// than findPlaceOrderControl: it also returns true when only the LABEL is present
// (an element whose text/value/aria-label matches), so it still fires when Amazon's
// button isn't in our clickable selector set. Used as the place-order INTENT signal
// for the proactive block, which must not depend on recognizing a clickable control.
export function hasPlaceOrderIntent(root = document) {
  if (findPlaceOrderControl(root)) return true;
  for (const el of root.querySelectorAll('input[type="submit"], button, a, [role="button"], span.a-button-text, [aria-label]')) {
    const label = el.value || el.textContent || el.getAttribute('aria-label') || '';
    if (PLACE_ORDER_TEXT_RE.test(label)) return true;
  }
  return false;
}

export const CONFIRM_SELECTORS = [
  '#widget-purchaseConfirmationStatus',
  '[data-testid="order-confirmation"]',
  '.a-box.osc-thank-you',
];
const CONFIRM_TEXT_RE = /(order placed|thank you|order confirmed|your order has been placed)/i;

export function detectOrderConfirmation(root = document) {
  for (const sel of CONFIRM_SELECTORS) if (root.querySelector(sel)) return true;
  for (const h of root.querySelectorAll('h1, h2, h4')) {
    if (CONFIRM_TEXT_RE.test(h.textContent || '')) return true;
  }
  return false;
}

const FINAL_TOTAL_SELECTORS = [
  '#subtotals-marketplace-table .grand-total-price',
  '.grand-total-price',
  '[data-testid="order-summary-grand-total"]',
];

export function parseFinalOrderTotal(root = document) {
  for (const sel of FINAL_TOTAL_SELECTORS) {
    const el = root.querySelector(sel);
    if (el) {
      const off = el.querySelector('.a-offscreen');
      const val = parseCurrency(off ? off.textContent : el.textContent);
      if (val != null) return val;
    }
  }
  return null;
}
