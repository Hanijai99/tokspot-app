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
