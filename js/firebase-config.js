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
//  Web Push (FCM) — "Your turn!" notifications.
//  Leave empty until you complete the console setup:
//    1. Firebase Console → your project → Cloud Messaging
//    2. Copy the "Web configuration → Web push certificates → Key pair"
//    3. Paste it here (keep it client-side; it is a public key).
//  The pass page only registers device tokens when this is set AND the
//  app runs in functions mode (registerPushToken callable).
// ------------------------------------------------------------------
window.TOKSPOT_VAPID_KEY = "";
