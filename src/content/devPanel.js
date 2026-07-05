// Content script on every Amazon page. It no longer injects a visible panel — its only
// job is to show Parago's on-page approval notification (the toast below the Amazon logo)
// when the popup's "Preview toast" (Developer mode) asks for it, so the shopper can see
// exactly what that notification looks like. Nothing is ever bought.
import { getSettings } from '../settings/storage.js';
import { t, setLang } from '../i18n/i18n.js';
import { showApprovalToast } from './approvalToast.js';

function previewToast() {
  getSettings()
    .then((s) => {
      if (!s.devMode) return; // preview is a Developer-mode-only aid
      setLang(s.lang);
      showApprovalToast({ title: t('toast_sent_title'), body: t('toast_sent_body') });
    })
    .catch(() => showApprovalToast({ title: 'Sent for approval' }));
}

try {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'parago_preview_toast') previewToast();
  });
} catch (e) { /* no chrome.runtime in this context */ }
