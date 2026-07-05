// test/proactiveBlock.test.js
// The proactive page-load block was removed: orders are now held only when the shopper
// actually presses "Place your order" (see placeOrderRedirect.test.js). What remains
// worth pinning here is hasPlaceOrderIntent — the wide "is there a place-order
// affordance" signal used to recognize a checkout's buy control even when Amazon's
// button isn't in our clickable selector set.
import { describe, it, expect, afterEach } from 'vitest';
import { hasPlaceOrderIntent } from '../src/lib/placeOrder.js';

afterEach(() => { document.body.innerHTML = ''; });

describe('hasPlaceOrderIntent', () => {
  it('true when a recognized place-order input exists', () => {
    document.body.innerHTML = '<input name="placeYourOrder1" type="submit" value="Place your order">';
    expect(hasPlaceOrderIntent(document)).toBe(true);
  });

  it('true when only the "Place your order" TEXT exists (button not in our selector list)', () => {
    // The real SPC case: Amazon delivers the click to an <a class="a-button-text">.
    document.body.innerHTML = '<a class="a-button-text">Place your order</a>';
    expect(hasPlaceOrderIntent(document)).toBe(true);
  });

  it('false on a page with no place-order affordance', () => {
    document.body.innerHTML = '<button>Continue shopping</button>';
    expect(hasPlaceOrderIntent(document)).toBe(false);
  });
});
