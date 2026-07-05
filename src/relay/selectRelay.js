// Resolve the Supabase Edge Functions base URL. The in-extension Options field
// (settings.functionsBaseUrl) wins, so a machine is pointed at a project from the
// UI without editing code or rebuilding; the baked config.js value is only the
// fallback default. Trailing slashes are trimmed so callers append '/create-request'.
export function resolveFunctionsBaseUrl(settings, config) {
  const fromSettings = settings && typeof settings.functionsBaseUrl === 'string' && settings.functionsBaseUrl.trim();
  const fromConfig = config && config.functionsBaseUrl;
  let base = String(fromSettings || fromConfig || '').replace(/\/+$/, '');
  // Accept the project URL and normalize it. Users routinely paste the Project
  // Settings > API URL (https://<ref>.supabase.co) instead of the Edge Functions
  // URL (https://<ref>.functions.supabase.co); calling the former CORS-fails and
  // hits no function. Rewrite <ref>.supabase.co -> <ref>.functions.supabase.co.
  // An already-correct .functions.supabase.co URL does not match and is left as-is.
  base = base.replace(/^(https?:\/\/[a-z0-9-]+)\.supabase\.co/i, '$1.functions.supabase.co');
  return base;
}

// Guard for the background parago_fetch proxy: a target is allowed only if it is an
// absolute https URL on the EXACT same origin as the resolved functions base. Exact
// origin (not a host suffix) so a lookalike like <ref>.functions.supabase.co.evil.com
// cannot pass. Any parse failure / relative URL / non-https fails closed to false.
export function isAllowedFetchOrigin(url, baseUrl) {
  try {
    const target = new URL(url);
    if (target.protocol !== 'https:') return false;
    return target.origin === new URL(baseUrl).origin;
  } catch { return false; }
}

// Use the remote (email) relay only when we can actually send: a usable https
// functions base URL is configured AND the user provided a guardian email.
// Otherwise fall back to MockRelay (local popup approval) so the feature degrades
// gracefully. A malformed URL (e.g. a typo pasted into Options) also fails safe
// here rather than reaching fetch, keeping the checkout gate fail-closed.
export function shouldUseSupabase(settings, config) {
  const base = resolveFunctionsBaseUrl(settings, config);
  if (!/^https?:\/\//i.test(base) || base.includes('<PROJECT_REF>')) return false;
  // Each delivery method needs its own target configured before we route to the
  // remote relay; otherwise fall back to local popup approval (MockRelay), keeping
  // the checkout gate fail-closed.
  const method = (settings && settings.deliveryMethod) || 'email';
  if (method === 'telegram') return !!(settings && settings.telegramLinked);
  return !!(settings && settings.guardianEmail && settings.guardianEmail.trim());
}
