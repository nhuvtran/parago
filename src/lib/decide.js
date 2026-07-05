// Pure decision: given parsed card data + settings, should we flag it and why?
// Each rule can be toggled off independently. Unknown (null) stars/count are treated
// as "unknown" and NOT flagged, to avoid hiding good items when parsing fails.
export function decide(parsed, settings) {
  const reasons = [];
  if (settings.hideSponsored && parsed.sponsored) reasons.push('sponsored');
  if (settings.flagLowRating && parsed.stars != null && parsed.stars < settings.minStars) {
    reasons.push('low_rating');
  }
  if (settings.flagFewRatings && parsed.ratingsCount != null && parsed.ratingsCount <= settings.minRatings) {
    reasons.push('few_ratings');
  }
  // Non-Prime: Amazon shows a Prime badge only on Prime-eligible items, so absence of the
  // badge (parsed.prime === false) is the signal. Opt-in (default off).
  if (settings.flagNonPrime && !parsed.prime) reasons.push('not_prime');
  // No reviews at all: neither a star rating nor a ratings count → an unvetted listing.
  // Opt-in. filter.js suppresses this rule when NO card on the page has any rating (a
  // parse miss / logged-out layout), so it can't grey a whole page it just failed to read.
  if (settings.flagNoReviews && parsed.stars == null && parsed.ratingsCount == null) reasons.push('no_reviews');
  // Over the shopper's price ceiling (0 = off). Unknown price is never flagged.
  if (settings.maxPrice > 0 && parsed.price != null && parsed.price > settings.maxPrice) reasons.push('over_price');
  return { flagged: reasons.length > 0, reasons };
}
