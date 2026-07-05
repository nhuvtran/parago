import { describe, it, expect, afterEach } from 'vitest';
import { decide } from '../src/lib/decide.js';
import { parseCard, parsePrice } from '../src/lib/parseCard.js';

afterEach(() => { document.body.innerHTML = ''; });

// Only the two new rules; other keys default to "off" so they never interfere.
const base = {
  hideSponsored: false, flagLowRating: false, flagFewRatings: false, flagNonPrime: false,
  flagNoReviews: false, maxPrice: 0, minStars: 3.5, minRatings: 5,
};

describe('decide: no-reviews flag', () => {
  it('flags an item with neither stars nor a ratings count when enabled', () => {
    const d = decide({ stars: null, ratingsCount: null, price: 10 }, { ...base, flagNoReviews: true });
    expect(d.flagged).toBe(true);
    expect(d.reasons).toContain('no_reviews');
  });
  it('does NOT flag an item that has a rating', () => {
    const d = decide({ stars: 4.5, ratingsCount: null, price: 10 }, { ...base, flagNoReviews: true });
    expect(d.reasons).not.toContain('no_reviews');
  });
  it('does nothing when the flag is off', () => {
    const d = decide({ stars: null, ratingsCount: null, price: 10 }, base);
    expect(d.flagged).toBe(false);
  });
});

describe('decide: over-price flag', () => {
  it('flags a price above the ceiling', () => {
    const d = decide({ stars: 4, ratingsCount: 100, price: 60 }, { ...base, maxPrice: 50 });
    expect(d.reasons).toContain('over_price');
  });
  it('does not flag a price at/below the ceiling', () => {
    const d = decide({ stars: 4, ratingsCount: 100, price: 50 }, { ...base, maxPrice: 50 });
    expect(d.reasons).not.toContain('over_price');
  });
  it('maxPrice 0 means off, and unknown price is never flagged', () => {
    expect(decide({ price: 999 }, { ...base, maxPrice: 0 }).flagged).toBe(false);
    expect(decide({ price: null }, { ...base, maxPrice: 50 }).flagged).toBe(false);
  });
});

describe('parsePrice', () => {
  it('reads the canonical .a-price .a-offscreen node', () => {
    document.body.innerHTML = `<div class="card"><span class="a-price"><span class="a-offscreen">$21.15</span></span></div>`;
    expect(parsePrice(document.querySelector('.card'))).toBe(21.15);
  });
  it('returns null when no price is shown', () => {
    document.body.innerHTML = `<div class="card"></div>`;
    expect(parsePrice(document.querySelector('.card'))).toBe(null);
  });
  it('parseCard exposes the price field', () => {
    document.body.innerHTML = `<div data-asin="X"><span class="a-price"><span class="a-offscreen">$9.99</span></span></div>`;
    expect(parseCard(document.querySelector('[data-asin]')).price).toBe(9.99);
  });
});
