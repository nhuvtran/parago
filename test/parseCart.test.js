import { describe, it, expect, afterEach } from 'vitest';
import { parseCart, parseCartItems, parseCartTotal, parseDeliveryExpiry, parseOrderBreakdown, parseCheckoutInfo, parseItemGift, parseCheckoutGifts } from '../src/lib/parseCart.js';

afterEach(() => { document.body.innerHTML = ''; });

describe('parseCheckoutInfo (partial ship-to + payment)', () => {
  it('captures the card (type + last 4) and city/state/zip only', () => {
    document.body.innerHTML = `
      <span class="break-word">Paying with Visa 1234</span>
      <div id="addressList">Brooklyn, NY 11201</div>`;
    const ci = parseCheckoutInfo(document);
    expect(ci.payment).toBe('Visa ••••1234'); // format: "<Card> <last4>", no "ending in"
    expect(ci.shipTo).toBe('Brooklyn, NY 11201'); // no name, no street
  });
  it('also handles the "ending in" and asterisk card formats', () => {
    document.body.innerHTML = '<div>Paying with Visa ending in 4821</div>';
    expect(parseCheckoutInfo(document).payment).toBe('Visa ••••4821');
  });
  it('returns null when neither is present', () => {
    document.body.innerHTML = '<div>nothing here</div>';
    expect(parseCheckoutInfo(document)).toBeNull();
  });
  it('captures the full recipient name (prefix stripped) + address from the delivery panel', () => {
    // Fake data only. Pinned to the real ids #deliver-to-customer-text / #deliver-to-address-text.
    document.body.innerHTML = `
      <div id="checkout-deliveryAddressPanel">
        <h2 id="deliver-to-customer-text">Delivering to Jordan Fake</h2>
        <p><span id="deliver-to-address-text">123 Example St, Apt 4, Testville, CA 90001</span></p>
      </div>`;
    const ci = parseCheckoutInfo(document);
    expect(ci.shipName).toBe('Jordan Fake'); // "Delivering to " stripped
    expect(ci.shipAddress).toBe('123 Example St, Apt 4, Testville, CA 90001');
  });
});

describe('parseOrderBreakdown', () => {
  const row = (label, amount, bold) => `
    <li><span class="a-list-item ${bold ? 'a-text-bold' : ''}"><div class="order-summary-grid">
      <div class="order-summary-line-term"><span><span class="break-word">${label}</span></span></div>
      <div class="order-summary-line-definition"><span class="aok-nowrap a-nowrap"><span data-shimmer-target="ordertotals-amount">${amount}</span></span></div>
    </div></span></li>`;

  it('captures Items / Shipping / Tax / Order total from the real checkout markup', () => {
    document.body.innerHTML = `<ul id="subtotals-marketplace-table">
      ${row('Items:', '$21.15')}
      ${row('Shipping &amp; handling:', '$0.00')}
      ${row('Estimated tax to be collected:', '$1.88')}
      ${row('Order total:', '$23.63', true)}
    </ul>`;
    expect(parseOrderBreakdown(document)).toEqual([
      { label: 'Items', amount: 21.15, total: false },
      { label: 'Shipping & handling', amount: 0, total: false },
      { label: 'Estimated tax to be collected', amount: 1.88, total: false },
      { label: 'Order total', amount: 23.63, total: true },
    ]);
  });

  it('stores a promotion/discount as a negative amount', () => {
    document.body.innerHTML = `<ul id="subtotals-marketplace-table">
      ${row('Items:', '$50.00')}
      ${row('Promotion applied:', '-$5.00')}
      ${row('Order total:', '$45.00', true)}
    </ul>`;
    const b = parseOrderBreakdown(document);
    expect(b.find((x) => /promotion/i.test(x.label)).amount).toBe(-5);
  });

  it('skips the nested regulatory-fee popover rows and returns null off-checkout', () => {
    document.body.innerHTML = `<ul id="subtotals-marketplace-table">
      ${row('Estimated Regulatory Fees:', '$0.60')}
      <div class="a-popover-preload"><ul>${row('Bottle Deposit Fee', '$0.60')}</ul></div>
      ${row('Order total:', '$0.60', true)}
    </ul>`;
    const b = parseOrderBreakdown(document);
    expect(b.map((x) => x.label)).toEqual(['Estimated Regulatory Fees', 'Order total']); // no "Bottle Deposit Fee"
    document.body.innerHTML = '<div>no summary here</div>';
    expect(parseOrderBreakdown(document)).toBeNull();
  });
});

describe('delivery capture', () => {
  it('captures the delivery window, dropping the "$25 of qualifying items" tail', () => {
    document.body.innerHTML = `
      <div id="sc-active-cart">
        <div class="sc-list-item" data-asin="D1" data-isselected="1">
          <div class="sc-product-title">Fast Item</div>
          <div class="udm-primary-delivery-message">FREE delivery Overnight 4 AM - 8 AM on $25 of qualifying items</div>
        </div>
      </div>`;
    expect(parseCartItems(document)[0].delivery).toBe('FREE delivery Overnight 4 AM - 8 AM');
  });

  it('does not jam the Prime badge against the message, and keeps the date', () => {
    document.body.innerHTML = `
      <div id="sc-active-cart">
        <div class="sc-list-item" data-asin="D2" data-isselected="1">
          <div class="sc-product-title">Item</div>
          <div class="udm-delivery-block">
            <div class="udm-badge-block"><span class="a-icon-text">Overnight</span></div>
            <div class="udm-primary-delivery-message"><div class="a-column">FREE delivery <span class="a-text-bold">Thursday, July 10</span> on $25 of qualifying items</div></div>
          </div>
        </div>
      </div>`;
    // Badge "Overnight" not glued on; "FREE delivery" and the date keep their space.
    expect(parseCartItems(document)[0].delivery).toBe('FREE delivery Thursday, July 10');
  });

  it('parseDeliveryExpiry resolves "Order within Xh Ym" to an absolute cutoff', () => {
    const now = 1_000_000_000;
    expect(parseDeliveryExpiry('Order within 3 hrs 20 mins', now)).toBe(now + (3 * 60 + 20) * 60000);
    expect(parseDeliveryExpiry('Order within 45 mins', now)).toBe(now + 45 * 60000);
    expect(parseDeliveryExpiry('Order within 2 hours', now)).toBe(now + 120 * 60000);
  });

  it('parseDeliveryExpiry returns null when there is no cutoff phrase', () => {
    expect(parseDeliveryExpiry('FREE delivery tomorrow', 1000)).toBeNull();
    expect(parseDeliveryExpiry('', 1000)).toBeNull();
    expect(parseDeliveryExpiry(null, 1000)).toBeNull();
  });
});

describe('parseCartTotal label fallback', () => {
  it('reads the price, not the item count, from a "Subtotal (N items): $X" row', () => {
    // No known TOTAL_CONTAINERS, so the label-anchored fallback runs on the row text.
    // parseCurrency grabs the first digit-run, so the "(3 items)" count must be stripped
    // first or the total comes back as 3 instead of 59.97.
    document.body.innerHTML = '<div><span>Subtotal (3 items): $59.97</span></div>';
    expect(parseCartTotal(document)).toBe(59.97);
  });
});

// Amazon's cart page renders the ACTIVE cart and a "Saved for later" section with
// the SAME .sc-list-item[data-asin] markup. Only the active cart is being purchased,
// so saved items must never leak into the parsed items (they show in the approval
// overlay + email) and must never affect the total.
const CART_HTML = `
  <form id="activeCartViewForm">
    <div id="sc-active-cart">
      <div class="sc-list-item" data-asin="ACTIVE1" data-itemid="i1">
        <div class="sc-product-title">Active Item One</div>
        <span class="a-price"><span class="a-offscreen">$10.00</span></span>
      </div>
      <div class="sc-list-item" data-asin="ACTIVE2" data-itemid="i2">
        <div class="sc-product-title">Active Item Two</div>
      </div>
    </div>
  </form>
  <div id="sc-subtotal-amount-activecart"><span class="a-offscreen">$30.00</span></div>
  <form id="saved-for-later">
    <div id="sc-saved-cart">
      <div class="sc-list-item" data-asin="SAVED1" data-itemid="s1">
        <div class="sc-product-title">Saved Item One</div>
        <span class="a-price"><span class="a-offscreen">$999.00</span></span>
      </div>
      <div class="sc-list-item" data-asin="SAVED2" data-itemid="s2">
        <div class="sc-product-title">Saved Item Two</div>
      </div>
    </div>
  </form>`;

describe('parseCart excludes Saved for later', () => {
  it('parseCartItems returns only active-cart items', () => {
    document.body.innerHTML = CART_HTML;
    const titles = parseCartItems(document).map((i) => i.title);
    expect(titles).toEqual(['Active Item One', 'Active Item Two']);
  });

  it('parseCartTotal reads the active-cart subtotal, not saved items', () => {
    document.body.innerHTML = CART_HTML;
    expect(parseCartTotal(document)).toBe(30);
  });

  it('parseCart agrees', () => {
    document.body.innerHTML = CART_HTML;
    const { total, items } = parseCart(document);
    expect(total).toBe(30);
    expect(items.map((i) => i.asin)).toEqual(['ACTIVE1', 'ACTIVE2']);
  });

  // Fallback: no #sc-active-cart wrapper (DOM variant). Loose items still parse,
  // but anything inside the saved section is still dropped.
  it('drops saved items even without an active-cart container', () => {
    document.body.innerHTML = `
      <div class="sc-list-item" data-asin="A1"><div class="sc-product-title">Loose Active</div></div>
      <div id="sc-saved-cart">
        <div class="sc-list-item" data-asin="A2"><div class="sc-product-title">Saved</div></div>
      </div>`;
    expect(parseCartItems(document).map((i) => i.title)).toEqual(['Loose Active']);
  });
});

describe('parseCartItems enriches items with EASY fields', () => {
  it('parses price, qty, image, and url from item markup', () => {
    document.body.innerHTML = `
      <div id="sc-active-cart">
        <div class="sc-list-item" data-asin="B0EASY1" data-quantity="2">
          <div class="sc-product-title">Enriched Item</div>
          <span class="a-price"><span class="a-offscreen">$12.34</span></span>
          <img class="sc-product-image" src="https://m.media-amazon.com/images/I/easy.jpg">
        </div>
      </div>`;
    const [item] = parseCartItems(document);
    expect(item.price).toBe(12.34);
    expect(item.qty).toBe(2);
    expect(item.image).toBe('https://m.media-amazon.com/images/I/easy.jpg');
    expect(item.url).toBe('https://www.amazon.com/dp/B0EASY1');
    expect(item.title).toBe('Enriched Item');
    expect(item.asin).toBe('B0EASY1');
  });

  it('reads qty from a quantity input when data-quantity is absent', () => {
    document.body.innerHTML = `
      <div id="sc-active-cart">
        <div class="sc-list-item" data-asin="B0QTYIN">
          <div class="sc-product-title">Qty Input Item</div>
          <input class="sc-quantity-textfield" name="quantity" value="3">
        </div>
      </div>`;
    expect(parseCartItems(document)[0].qty).toBe(3);
  });

  it('defaults qty to 1 when there is no quantity markup', () => {
    document.body.innerHTML = `
      <div id="sc-active-cart">
        <div class="sc-list-item" data-asin="B0NOQTY">
          <div class="sc-product-title">No Qty Item</div>
        </div>
      </div>`;
    expect(parseCartItems(document)[0].qty).toBe(1);
  });

  it('null price/image and null url when markup and asin are absent', () => {
    // Empty data-asin still matches [data-name][data-asin] but yields a null asin,
    // so url must be null (no /dp/ link without an asin).
    document.body.innerHTML = `
      <div id="sc-active-cart">
        <div class="sc-list-item" data-asin="" data-name="No Asin Item">
          <div class="sc-product-title">No Asin Item</div>
        </div>
      </div>`;
    const [item] = parseCartItems(document);
    expect(item.asin).toBeNull();
    expect(item.url).toBeNull();
    expect(item.price).toBeNull();
    expect(item.image).toBeNull();
    expect(item.qty).toBe(1);
  });
});

// Faithful to a real amazon.com cart line (2026-07): data-isselected drives
// selection (the fancy checkbox does not track .checked), the title is nested twice
// (a-truncate-full + a-truncate-cut) plus a hidden "Opens in a new tab", the product
// image sits next to a display:none loading spinner under /images/G/, and each line
// also carries Subscribe & Save + "This is a gift" checkboxes.
describe('parseCart against real Amazon cart markup', () => {
  const line = (asin, isselected, titleFull) => `
    <div class="a-row sc-list-item" data-asin="${asin}" data-isselected="${isselected}" data-quantity="1">
      <div class="sc-list-item-spinner" style="display:none">
        <img src="https://m.media-amazon.com/images/G/01/ui/loadIndicators/loading-large._CB485945288_.gif">
      </div>
      <div class="a-checkbox a-checkbox-fancy sc-item-check-checkbox-selector sc-list-item-checkbox">
        <label><input type="checkbox" name="" value="" aria-label="Select ${titleFull} for checkout"><i class="a-icon a-icon-checkbox"></i></label>
      </div>
      <a aria-hidden="true" class="a-link-normal sc-product-link" tabindex="-1" href="/gp/product/${asin}/">
        <img src="https://m.media-amazon.com/images/I/81KyWvpx2cL._AC_AA180_.jpg" class="sc-product-image"
             srcset="https://m.media-amazon.com/images/I/81KyWvpx2cL._AC_AA180_.jpg 1x, https://m.media-amazon.com/images/I/81KyWvpx2cL._AC_AA360_.jpg 2x">
      </a>
      <a class="a-link-normal sc-product-link sc-product-title aok-block" href="/gp/product/${asin}/">
        <span class="a-size-base-plus a-color-base sc-product-title">
          <h3 class="a-text-normal"><span class="a-truncate">
            <span class="a-truncate-full a-offscreen">${titleFull}</span>
            <span class="a-truncate-cut" aria-hidden="true">${titleFull.slice(0, 12)}…</span>
          </span></h3>
        </span>
        <span class="aok-hidden">Opens in a new tab</span>
      </a>
      <span class="a-price"><span class="a-offscreen">$9.99</span></span>
      <input type="checkbox" aria-label="Subscribe &amp; Save ${titleFull}" class="a-switch-input" name="sns-item-cart-desktop">
      <label><input type="checkbox" name="" value=""><span class="a-label a-checkbox-label">This is a gift</span></label>
    </div>`;

  it('includes only data-isselected="1" lines and reads the clean single title', () => {
    document.body.innerHTML = `<div id="sc-active-cart">
      ${line('DESELECTED', '0', 'MAREE Batana Oil for Hair Growth 100 Percent Natural')}
      ${line('KEPT', '1', 'Selected Product Full Title Here')}
    </div>`;
    const items = parseCartItems(document);
    expect(items.map((i) => i.asin)).toEqual(['KEPT']);              // deselected line dropped
    expect(items[0].title).toBe('Selected Product Full Title Here'); // clean: not doubled, no "Opens in a new tab"
    expect(items[0].image).toBe('https://m.media-amazon.com/images/I/81KyWvpx2cL._SL500_.jpg'); // real photo, upsized from the 180px thumb, not the /images/G/ spinner
  });

  it('the gift and Subscribe & Save checkboxes never cause a selected line to drop', () => {
    document.body.innerHTML = `<div id="sc-active-cart">${line('KEPT', '1', 'Kept Item')}</div>`;
    expect(parseCartItems(document).map((i) => i.title)).toEqual(['Kept Item']);
  });
});

describe('parseCartItems captures rating + review count for the guardian', () => {
  it('reads the star rating and rating count from the cart line', () => {
    document.body.innerHTML = `
      <div id="sc-active-cart">
        <div class="sc-list-item" data-asin="RATED">
          <div class="sc-product-title">Rated Item</div>
          <i class="a-icon a-icon-star-small"><span class="a-icon-alt">4.6 out of 5 stars</span></i>
          <a href="/product-reviews/RATED/">18,432 ratings</a>
        </div>
      </div>`;
    const [it] = parseCartItems(document);
    expect(it.rating).toBe(4.6);
    expect(it.reviewCount).toBe(18432);
  });

  it('leaves rating/reviewCount null when the cart line has no stars', () => {
    document.body.innerHTML = `
      <div id="sc-active-cart">
        <div class="sc-list-item" data-asin="NORATE"><div class="sc-product-title">No Rating</div></div>
      </div>`;
    const [it] = parseCartItems(document);
    expect(it.rating).toBeNull();
    expect(it.reviewCount).toBeNull();
  });
});

describe('parseCartItems cleans the title', () => {
  it('strips Amazon\'s "Opens in a new tab" screen-reader text', () => {
    document.body.innerHTML = `
      <div id="sc-active-cart">
        <div class="sc-list-item" data-asin="A11Y">
          <a class="sc-product-link">Wireless Earbuds<span>Opens in a new tab</span></a>
        </div>
      </div>`;
    expect(parseCartItems(document)[0].title).toBe('Wireless Earbuds');
  });

  it('strips label variants: "opens in new tab", parenthesised, trailing period', () => {
    const t = (raw) => {
      document.body.innerHTML = `<div id="sc-active-cart"><div class="sc-list-item" data-asin="V">
        <div class="sc-product-title">${raw}</div></div></div>`;
      return parseCartItems(document)[0].title;
    };
    expect(t('Cable Opens in new tab')).toBe('Cable');
    expect(t('Cable (opens in a new window)')).toBe('Cable');
    expect(t('Cable Opens in a new tab.')).toBe('Cable');
  });
});

describe('parseCartItems picks the real product image, not a spinner', () => {
  it('reads data-a-dynamic-image when src is a loading spinner', () => {
    document.body.innerHTML = `
      <div id="sc-active-cart">
        <div class="sc-list-item" data-asin="SPIN">
          <div class="sc-product-title">Lazy Image Item</div>
          <img class="sc-product-image"
               src="https://images-na.ssl-images-amazon.com/images/G/01/x-locale/common/spinner.gif"
               data-a-dynamic-image='{"https://m.media-amazon.com/images/I/71real.jpg":[500,500]}'>
        </div>
      </div>`;
    expect(parseCartItems(document)[0].image).toBe('https://m.media-amazon.com/images/I/71real.jpg');
  });

  it('rejects a data: URI placeholder and falls back to data-old-hires', () => {
    document.body.innerHTML = `
      <div id="sc-active-cart">
        <div class="sc-list-item" data-asin="DATAURI">
          <div class="sc-product-title">Placeholder Item</div>
          <img class="sc-product-image" src="data:image/gif;base64,R0lGODlh"
               data-old-hires="https://m.media-amazon.com/images/I/81hires.jpg">
        </div>
      </div>`;
    expect(parseCartItems(document)[0].image).toBe('https://m.media-amazon.com/images/I/81hires.jpg');
  });

  it('skips a non-product img (e.g. a Prime badge sprite) and returns null', () => {
    document.body.innerHTML = `
      <div id="sc-active-cart">
        <div class="sc-list-item" data-asin="BADGE">
          <div class="sc-product-title">Badge Only</div>
          <img src="https://m.media-amazon.com/images/G/01/prime/badge.png">
        </div>
      </div>`;
    expect(parseCartItems(document)[0].image).toBeNull();
  });
});

describe('parseCartItems identifies the selection checkbox across cart variants', () => {
  it('excludes an unchecked box found by its select-column wrapper class (no "for checkout" label)', () => {
    document.body.innerHTML = `
      <div id="sc-active-cart">
        <div class="sc-list-item" data-asin="WRAP1">
          <span class="a-checkbox sc-list-item-checkbox"><label><input type="checkbox" checked=""></label></span>
          <div class="sc-product-title">Kept</div>
        </div>
        <div class="sc-list-item" data-asin="WRAP2">
          <span class="a-checkbox sc-list-item-checkbox"><label><input type="checkbox"></label></span>
          <div class="sc-product-title">Dropped</div>
        </div>
      </div>`;
    expect(parseCartItems(document).map((i) => i.title)).toEqual(['Kept']);
  });

  it('reads an aria-labelledby name to recognize the selection control', () => {
    document.body.innerHTML = `
      <div id="sc-active-cart">
        <div class="sc-list-item" data-asin="LBLBY">
          <span id="lbl1">Select this item for checkout</span>
          <input type="checkbox" aria-labelledby="lbl1">
          <div class="sc-product-title">By Labelledby</div>
        </div>
      </div>`;
    expect(parseCartItems(document).map((i) => i.title)).toEqual([]);
  });

  it('never treats a quantity/gift checkbox in the item as the selection control', () => {
    document.body.innerHTML = `
      <div id="sc-active-cart">
        <div class="sc-list-item" data-asin="QTYBOX">
          <input type="checkbox" aria-label="Update quantity">
          <div class="sc-product-title">Still Purchased</div>
        </div>
      </div>`;
    expect(parseCartItems(document).map((i) => i.title)).toEqual(['Still Purchased']);
  });

  it('excludes a single UNLABELLED checkbox that is unchecked (fallback when nothing marks it)', () => {
    document.body.innerHTML = `
      <div id="sc-active-cart">
        <div class="sc-list-item" data-asin="BARE1">
          <input type="checkbox" checked=""><div class="sc-product-title">Kept</div>
        </div>
        <div class="sc-list-item" data-asin="BARE2">
          <input type="checkbox"><div class="sc-product-title">Dropped</div>
        </div>
      </div>`;
    expect(parseCartItems(document).map((i) => i.title)).toEqual(['Kept']);
  });

  it('reads an ARIA checkbox widget (role=checkbox, aria-checked) not a native input', () => {
    document.body.innerHTML = `
      <div id="sc-active-cart">
        <div class="sc-list-item" data-asin="ARIA1">
          <span role="checkbox" aria-checked="true" aria-label="Select for checkout"></span>
          <div class="sc-product-title">Kept</div>
        </div>
        <div class="sc-list-item" data-asin="ARIA2">
          <span role="checkbox" aria-checked="false" aria-label="Select for checkout"></span>
          <div class="sc-product-title">Dropped</div>
        </div>
      </div>`;
    expect(parseCartItems(document).map((i) => i.title)).toEqual(['Kept']);
  });

  it('does NOT filter when the line has two ambiguous unlabelled checkboxes (never hide on doubt)', () => {
    document.body.innerHTML = `
      <div id="sc-active-cart">
        <div class="sc-list-item" data-asin="AMB">
          <input type="checkbox"><input type="checkbox" checked="">
          <div class="sc-product-title">Kept On Doubt</div>
        </div>
      </div>`;
    expect(parseCartItems(document).map((i) => i.title)).toEqual(['Kept On Doubt']);
  });
});

// Amazon marks each active-cart line with a "Select <product> for checkout"
// checkbox. A DEselected item stays in the cart (and out of the subtotal) but is
// NOT being purchased, so it must not reach the guardian. Only what's checked out
// should be sent.
describe('parseCartItems excludes items deselected for checkout', () => {
  it('drops an item whose "Select … for checkout" checkbox is unchecked', () => {
    document.body.innerHTML = `
      <div id="sc-active-cart">
        <div class="sc-list-item" data-asin="SEL1">
          <input type="checkbox" aria-label="Select Meditations (Penguin Classics) for checkout" checked="">
          <div class="sc-product-title">Meditations</div>
        </div>
        <div class="sc-list-item" data-asin="SEL2">
          <input type="checkbox" aria-label="Select Deselected Book for checkout">
          <div class="sc-product-title">Deselected Book</div>
        </div>
      </div>`;
    expect(parseCartItems(document).map((i) => i.title)).toEqual(['Meditations']);
  });

  it('keeps an item that has no selection checkbox (filter only on a confident deselect)', () => {
    document.body.innerHTML = `
      <div id="sc-active-cart">
        <div class="sc-list-item" data-asin="NOCB">
          <div class="sc-product-title">No Checkbox Item</div>
        </div>
      </div>`;
    expect(parseCartItems(document).map((i) => i.title)).toEqual(['No Checkbox Item']);
  });

  it('ignores a non-selection checkbox (e.g. gift options) when deciding inclusion', () => {
    // An unchecked checkbox that is NOT the "for checkout" selection control must
    // not cause exclusion — otherwise a stray checkbox would hide a purchased item.
    document.body.innerHTML = `
      <div id="sc-active-cart">
        <div class="sc-list-item" data-asin="GIFT">
          <input type="checkbox" aria-label="This will be a gift">
          <div class="sc-product-title">Gift Item</div>
        </div>
      </div>`;
    expect(parseCartItems(document).map((i) => i.title)).toEqual(['Gift Item']);
  });
});

// Amazon's active-cart subtotal (#sc-subtotal-amount-activecart) reflects the WHOLE
// active cart, not the checkbox selection. When some lines are deselected, the total
// the guardian sees must match the items shown — i.e. the SELECTED subtotal.
describe('parseCart total tracks the selected items', () => {
  const cart = (extra) => `
    <div id="sc-active-cart">
      <div class="sc-list-item" data-asin="KEEP" ${extra || ''}>
        <input type="checkbox" aria-label="Select Meditations for checkout" checked="">
        <div class="sc-product-title">Meditations</div>
        <span class="a-price"><span class="a-offscreen">$7.26</span></span>
      </div>
      <div class="sc-list-item" data-asin="DROP">
        <input type="checkbox" aria-label="Select Expensive Thing for checkout">
        <div class="sc-product-title">Expensive Thing</div>
        <span class="a-price"><span class="a-offscreen">$229.99</span></span>
      </div>
    </div>
    <div id="sc-subtotal-amount-activecart"><span class="a-offscreen">$237.25</span></div>`;

  it('totals only the selected items, not the whole-cart subtotal', () => {
    document.body.innerHTML = cart();
    const { total, items } = parseCart(document);
    expect(items.map((i) => i.title)).toEqual(['Meditations']);
    expect(total).toBe(7.26); // NOT 237.25
  });

  it('multiplies unit price by quantity in the selected total', () => {
    document.body.innerHTML = cart('data-quantity="3"');
    expect(parseCart(document).total).toBe(21.78); // 7.26 × 3
  });

  it('keeps the page subtotal when a selected item has no parseable price', () => {
    // Can't trust a partial sum, so fall back to the page subtotal rather than
    // send a fabricated number.
    document.body.innerHTML = `
      <div id="sc-active-cart">
        <div class="sc-list-item" data-asin="KEEP">
          <input type="checkbox" aria-label="Select NoPrice for checkout" checked="">
          <div class="sc-product-title">NoPrice</div>
        </div>
        <div class="sc-list-item" data-asin="DROP">
          <input type="checkbox" aria-label="Select Other for checkout">
          <div class="sc-product-title">Other</div>
        </div>
      </div>
      <div id="sc-subtotal-amount-activecart"><span class="a-offscreen">$99.00</span></div>`;
    expect(parseCart(document).total).toBe(99);
  });

  it('leaves the total unchanged when nothing is deselected', () => {
    document.body.innerHTML = `
      <div id="sc-active-cart">
        <div class="sc-list-item" data-asin="A">
          <input type="checkbox" aria-label="Select A for checkout" checked="">
          <div class="sc-product-title">A</div>
          <span class="a-price"><span class="a-offscreen">$5.00</span></span>
        </div>
      </div>
      <div id="sc-subtotal-amount-activecart"><span class="a-offscreen">$5.00</span></div>`;
    expect(parseCart(document).total).toBe(5);
  });
});

describe('parseItemGift (best-effort gift marking)', () => {
  it('is true for a checked gift checkbox and for explicit gift text', () => {
    document.body.innerHTML = `<div id="a"><input type="checkbox" name="giftFlag" checked></div>`;
    expect(parseItemGift(document.getElementById('a'))).toBe(true);
    document.body.innerHTML = `<div id="b">Qty 1 · This will be a gift</div>`;
    expect(parseItemGift(document.getElementById('b'))).toBe(true);
  });
  it('is false for a normal line (unchecked box, no gift text)', () => {
    document.body.innerHTML = `<div id="c"><input type="checkbox" name="giftFlag"> Add gift options</div>`;
    expect(parseItemGift(document.getElementById('c'))).toBe(false);
  });
});

describe('parseCheckoutGifts (marked gifts on the SPC checkout page)', () => {
  it('collects title + image id for lines whose gift link says "Change/Edit gift options"', () => {
    document.body.innerHTML = `
      <div class="lineitem-container">
        <img src="https://m.media-amazon.com/images/I/81rRSIKm2TL._AC_AA135_.jpg">
        <span id="checkout-item-block-item-primary-title-XYZ" class="lineitem-title-text">C4 Energy Drink 12 Pack</span>
        <a id="checkout-item-block-gift-options-link-XYZ">Change gift options</a>
      </div>
      <div class="lineitem-container">
        <img src="https://m.media-amazon.com/images/I/71PLAINxxxL._AC_AA135_.jpg">
        <span class="lineitem-title-text">Not A Gift Item</span>
        <a id="checkout-item-block-gift-options-link-ABC">Add gift options</a>
      </div>`;
    const g = parseCheckoutGifts(document);
    expect([...g.titles]).toEqual(['c4 energy drink 12 pack']); // only the "Change..." line
    expect([...g.imageIds]).toEqual(['81rRSIKm2TL']);
  });
  it('is empty off-checkout (no gift links)', () => {
    document.body.innerHTML = '<div>nothing</div>';
    const g = parseCheckoutGifts(document);
    expect(g.titles.size).toBe(0);
    expect(g.imageIds.size).toBe(0);
  });
});
