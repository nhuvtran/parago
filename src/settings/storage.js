export const DEFAULTS = {
  minStars: 3.5,        // flag items rated below this
  minRatings: 5,        // flag items with this many ratings or fewer
  mode: 'grey',         // 'grey' | 'hide' | 'off'
  preferredMode: 'grey',// remembers grey-vs-hide so the popup power toggle can restore it after 'off'
  hideSponsored: false,
  flagLowRating: true,
  flagFewRatings: true,
  flagNonPrime: false,  // opt-in: flag items not eligible for Prime
  flagNoReviews: false, // opt-in: flag items with no rating/reviews at all (unvetted listings)
  maxPrice: 0,          // flag items priced above this ($); 0 = off
  hoverReveal: true,
  guardianMode: 'off',  // 'off' | 'always' | 'over_limit'
  autoPlace: false,     // false = unlock-only (shopper clicks Place order after approval); true = Parago places it automatically once approved
  showGift: false,      // show the approver when an item is marked as a gift (only if marked); default off
  fullShipTo: false,    // send the FULL delivery name + address to the approver (default off: only City, ST ZIP)
  notifyUnheld: false,  // Telegram: also send a buttonless heads-up for purchases that did NOT need approval
  appButton: true,      // show the per-item "Open in Amazon app" button on the approval page; default on
  guardianLimit: 50,    // approval required above this total when over_limit
  guardianName: '',     // label for whoever approves
  deliveryMethod: 'telegram', // how the approver is reached: 'email' | 'telegram'. Per-method config below persists independently, so switching never clears the other.
  guardianEmail: '',    // email delivery: where approval emails are sent
  telegramLinkCode: '', // telegram delivery: opaque code this install generated; the guardian binds it by tapping the t.me deep link
  telegramLinked: false,// telegram delivery: true once the guardian completes linking
  telegramName: '',     // display name of the connected Telegram chat (shown in Options), filled at link time
  functionsBaseUrl: '', // Supabase Edge Functions URL for email approval; set in Options (not code). Blank = local popup approval. Not a secret (it is the public project URL).
  githubUsername: '',   // GitHub user hosting approve.html; the approval link becomes https://<user>.github.io/parago/approve.html. Blank = server default. Advanced.
  advancedMode: false,  // Options page detail level: false = Simple (hides advanced/developer controls)
  theme: 'light',       // UI theme: 'light' | 'dark' | 'amoled' (header toggle cycles all three)
  timezone: '',         // IANA zone for timestamps shown to the guardian; '' = the device's zone (auto)
  lang: 'en',           // 'en' | 'vi'
  devMode: false,       // show the on-page Developer test panel (no real purchases)
};

export function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(DEFAULTS, (items) => {
      if (chrome.runtime && chrome.runtime.lastError) {
        resolve({ ...DEFAULTS });
        return;
      }
      resolve({ ...DEFAULTS, ...items });
    });
  });
}

export function setSettings(patch) {
  return new Promise((resolve) => {
    chrome.storage.sync.set(patch, () => {
      void (chrome.runtime && chrome.runtime.lastError);
      resolve();
    });
  });
}

// The IANA time zone to stamp timestamps in: the user's choice, else this device's zone.
export function resolveTimezone(settings) {
  const tz = settings && typeof settings.timezone === 'string' && settings.timezone.trim();
  if (tz) return tz;
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { return 'UTC'; }
}

export function onSettingsChanged(cb) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync') cb(changes);
  });
}
