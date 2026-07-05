// Pure decision for the popup power toggle. Given the current settings, return the
// settings patch that flips the search filter between on and off.
//
// "On" means mode is not 'off'. Turning off stashes the current grey/hide choice in
// preferredMode so turning back on restores it. The restore guards against ever
// resolving to 'off' (which would make the toggle a silent no-op), falling back to
// 'grey' if preferredMode is missing or somehow 'off'.
export function nextModePatch(settings) {
  if (settings.mode !== 'off') {
    return { preferredMode: settings.mode, mode: 'off' };
  }
  const restore = (settings.preferredMode && settings.preferredMode !== 'off')
    ? settings.preferredMode
    : 'grey';
  return { mode: restore };
}
