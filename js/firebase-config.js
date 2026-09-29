/**
 * ============================================================
 *  FIREBASE CONFIG — WEB (client-side)
 * ============================================================
 *  Paste your Firebase web app config here.
 *
 *  Steps:
 *   1. Firebase Console → create a NEW project (e.g. "hospital-token-app")
 *   2. Project Settings (gear) → Your apps → Add web app (</>)
 *   3. Register app, copy the `firebaseConfig` object it shows.
 *   4. Paste it in the CONFIG object below.
 *
 *  Also required for multi-hospital:
 *   - Enable Firebase Authentication → Email/Password (for hospital admin login)
 *   - Enable Firestore Database with the rules from firestore.rules
 * ============================================================
 */
window.FB_CONFIG = {
  apiKey: "AIzaSyB6MXuT01OqwVrglAsGGTxYHhpoc2I-QPk",
  authDomain: "tokenonspot.firebaseapp.com",
  projectId: "tokenonspot",
  storageBucket: "tokenonspot.firebasestorage.app",
  messagingSenderId: "26601366564",
  appId: "1:26601366564:web:eee67486ab849ac06824b1"
};

// Default hospital slug used when none is chosen in the URL ?h=slug
window.DEFAULT_HOSPITAL = "demo";

// ------------------------------------------------------------------
//  BACKEND MODE SWITCH — the one-line pilot flip.
//  Keep "prototype" during dev/demo. Set to "functions" ONLY after the
//  Firestore rules + Functions are deployed together (never rules
//  alone), or the static pages will stop talking to the database.
// ------------------------------------------------------------------
window.TOKSPOT_API_MODE = "prototype";

// ------------------------------------------------------------------
//  App Check (reCAPTCHA v3) — bot/abuse attestation for Firestore.
//  Console: Project Settings -> App Check -> Apps -> reCAPTCHA v3 ->
//  copy the *site key* here. Enable enforcement in the console ONLY
//  after this key is set AND the update below is deployed, or every
//  client request will be rejected.
// ------------------------------------------------------------------
window.TOKSPOT_APP_CHECK_SITE_KEY = "";

// ------------------------------------------------------------------
//  Web Push (FCM) — "Your turn!" notifications.
//  Leave empty until you complete the console setup:
//    1. Firebase Console → your project → Cloud Messaging
//    2. Copy the "Web configuration → Web push certificates → Key pair"
//    3. Paste it here (keep it client-side; it is a public key).
//  The pass page only registers device tokens when this is set AND the
//  app runs in functions mode (registerPushToken callable).
// ------------------------------------------------------------------
window.TOKSPOT_VAPID_KEY = "";
