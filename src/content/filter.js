import { getSettings, onSettingsChanged } from '../settings/storage.js';
import { setLang } from '../i18n/i18n.js';
import { parseCard } from '../lib/parseCard.js';
import { decide } from '../lib/decide.js';
import { applyCard, removeApplied } from '../lib/applyCard.js';

const CARD_SELECTOR = 'div[data-component-type="s-search-result"][data-asin]';

let settings = null;
let scheduled = false;

function processAll() {
  if (!settings) return;
  setLang(settings.lang);
  // Toggle hover-reveal globally via a class on <html>; CSS handles the visual reveal.
  document.documentElement.classList.toggle('parago-hover-on', !!settings.hoverReveal);

  const parsedList = [];
  let anyPrime = false;
  let anyRated = false;
  for (const card of document.querySelectorAll(CARD_SELECTOR)) {
    const parsed = parseCard(card);
    if (parsed.prime) anyPrime = true;
    if (parsed.stars != null || parsed.ratingsCount != null) anyRated = true;
    parsedList.push([card, parsed]);
  }
  // Fail-safe for the non-Prime rule: only apply it when a Prime badge is actually
  // detectable somewhere on the page. Logged-out pages (and any Prime markup we don't
  // recognize) render no Prime badge at all, which would otherwise flag EVERY item as
  // non-Prime. When nothing reads as Prime, suppress the rule rather than grey the whole
  // page — consistent with treating unknowns as "don't flag".
  // Same fail-safe for No-reviews: if we couldn't read a rating on ANY card, we're likely
  // on a layout we don't parse, so don't flag every item as unreviewed.
  let eff = settings;
  if (settings.flagNonPrime && !anyPrime) eff = { ...eff, flagNonPrime: false };
  if (settings.flagNoReviews && !anyRated) eff = { ...eff, flagNoReviews: false };
  for (const [card, parsed] of parsedList) {
    applyCard(card, decide(parsed, eff), settings.mode);
  }
}

// Debounce bursts of DOM mutations into one pass per animation frame.
function schedule() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => { scheduled = false; processAll(); });
}

function reset() {
  for (const card of document.querySelectorAll(CARD_SELECTOR)) removeApplied(card);
  processAll();
}

async function init() {
  settings = await getSettings();
  processAll();

  const root = document.querySelector('.s-main-slot') || document.body;
  // applyCard adds a badge <div> to flagged cards, which the observer sees as a childList
  // change. Loop quiescence depends on that badge being IGNORED by parseCard: it is a
  // <div> with no aria-label / no .a-icon-alt and its text is never exactly "Sponsored",
  // so the decision (and stamp) stays stable on the next pass and applyCard early-returns.
  // Do not change the badge element to a span/a or give it an aria-label.
  new MutationObserver(schedule).observe(root, { childList: true, subtree: true });

  // Badge offsets are measured against the image's on-screen box, so a responsive reflow
  // (window resize) makes them stale. Re-measure on a debounced resize by re-applying.
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(reset, 200);
  });

  onSettingsChanged(async () => { settings = await getSettings(); reset(); });
}

init().catch((err) => console.error('[parago] init failed:', err));
