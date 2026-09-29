/**
 * ============================================================
 *  TokSpot web push (FCM) — device token registration.
 * ============================================================
 *  Order of operations:
 *   1. Set window.TOKSPOT_VAPID_KEY in js/firebase-config.js
 *      (Cloud Messaging → Web push certificates → key pair).
 *   2. Confirm firebase-messaging-sw.js is hosted at the site root
 *      (it already is), and that the backend calls
 *      exports.tokenCalledNotify (functions/index.js).
 *   3. This helper only registers in functions mode — the trusted
 *      backend keys each device token under its hospital via the
 *      registerPushToken callable.
 *
 *  Usage (token.html):
 *     <script src="js/push.js"></script>
 *     if (window.TokSpotPush) window.TokSpotPush.init({ slug, tokenId, number });
 */
(function (root, factory) {
  root.TokSpotPush = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (win) {

  const MESSAGING_CDN = 'https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging.js';

  let started = false;

  function isFunctionsMode() {
    return !!(win.TokSpotAPI && win.TokSpotAPI.mode() === 'functions');
  }

  function key() {
    return String(win.TOKSPOT_VAPID_KEY || '').trim();
  }

  /**
   * @param {object} ctx { slug, tokenId, number }
   */
  async function init(ctx) {
    if (started) return;
    if (!isFunctionsMode()) return; // prototype never registers push
    if (!key()) return;             // console VAPID not configured yet
    if (!('serviceWorker' in navigator) || !('Notification' in win)) return;
    if (win.Notification.permission === 'denied') return;
    if (win.Notification.permission !== 'granted') {
      try { await win.Notification.requestPermission(); } catch (_) {}
      if (win.Notification.permission !== 'granted') return;
    }

    started = true;
    try {
      let messaging = (win._messaging && typeof win._messaging.getToken === 'function')
        ? win._messaging
        : null;

      if (!messaging) {
        // Lazy-load the modular Messaging SDK and bind to the existing app.
        const mod = await import(MESSAGING_CDN);
        messaging = mod.getMessaging(win._app);
        win._messaging = messaging;
      }

      const currentToken = await messaging.getToken({ vapidKey: key() });
      if (!currentToken) return;

      await win.TokSpotAPI.registerPushToken({ slug: ctx.slug, token: currentToken });
      console.log('[push] device registered for', ctx.slug);
    } catch (e) {
      console.warn('[push] registration skipped:', e.message);
    }
  }

  return { init, isFunctionsMode: isFunctionsMode, key };
});