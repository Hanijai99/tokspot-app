/**
 * FCM Web Push — Push Notification helper.
 * Requires:
 *  - public/firebase-messaging-sw.js  (the SW that handles push)
 *  - a VAPID public key from Firebase Console → Project settings →
 *    Cloud Messaging → Web Push certificates.
 * Run enablePush() once to request permission & get a token, then
 * store the token under the hospital for later targeting.
 */
(function () {
  window._MSG = null;
  window._VAPID = null; // set after config

  // Attach messaging to the firebase loader once it's ready
  window.attachMessaging = function () {
    if (window._MSG || !window._FB_READY) return null;
    try {
      // firebase.js must expose a dynamic import of messaging
      if (typeof window._loadMessaging === 'function') {
        window._MSG = window._loadMessaging();
      }
    } catch (e) {}
    return window._MSG;
  };

  window.requestPushPermission = async function () {
    if (!window._FB_READY) { showToast('Firebase not ready.', true); return null; }
    try {
      const msg = window.attachMessaging();
      if (!msg) { showToast('Push not available.', true); return null; }
      if (!window._VAPID) { showToast('Set VAPID key first.', true); return null; }
      const current = await msg.getToken({ vapidKey: window._VAPID });
      if (current) { showToast('Notifications enabled.'); return current; }
      return null;
    } catch (e) {
      showToast('Permission denied: ' + (e.message || e.code), true, 4000);
      return null;
    }
  };
})();
