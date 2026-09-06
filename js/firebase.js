/**
 * Shared Firebase loader — loads modular SDKs on demand and exposes
 * them globally (window._app, window._auth, window._db, window._fs).
 */
(function () {
  window._FB_READY = false;

  async function initFirebase() {
    if (window._FB_READY) return;

    // Supports both window.FB_CONFIG and window.firebaseConfig
    const config = window.firebaseConfig || window.FB_CONFIG || {};
    if (!config.apiKey || config.apiKey.startsWith('REPLACE')) {
      console.warn('firebase-config.js not set up yet.');
      window._FB_READY = false;
      return;
    }

    try {
      const { initializeApp } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js');
      const { 
        getFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc,
        collection, query, where, orderBy, limit, onSnapshot,
        addDoc, getDocs, serverTimestamp, increment, runTransaction 
      } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');

      const app = initializeApp(config);
      const db = getFirestore(app);

      // Auth module
      let auth = null;
      let useAuth = {};
      try {
        const authMod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js');
        auth = authMod.getAuth(app);
        useAuth = authMod;
      } catch (e) { /* auth optional */ }

      window._app = app;
      window._db = db;
      window._auth = auth;
      window._useAuth = useAuth;
      
      // Expose all firestore methods including runTransaction
      window._fs = {
        doc, getDoc, setDoc, updateDoc, deleteDoc,
        collection, query, where, orderBy, limit, onSnapshot,
        addDoc, getDocs, serverTimestamp, increment, runTransaction
      };
      
      window._FB_READY = true;

      // Lazy loader for Cloud Messaging
      window._loadMessaging = async function () {
        if (window._msgLoaded) return window._msgLoaded;
        try {
          const msgMod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging.js');
          msgMod.getMessaging(app);
          window._msgLoaded = msgMod;
          return msgMod;
        } catch (e) {
          console.warn('Messaging unavailable:', e.message);
          return null;
        }
      };
    } catch (err) {
      console.error('Firebase initialization error:', err);
      window._FB_READY = false;
    }
  }

  window.initFirebase = initFirebase;
  
  window.waitForFB = function () {
    return new Promise((resolve) => {
      if (window._FB_READY) return resolve(true);
      const t = setInterval(() => {
        if (window._FB_READY) { 
          clearInterval(t); 
          resolve(true); 
        }
      }, 40);
      // timeout guard
      setTimeout(() => { 
        clearInterval(t); 
        resolve(window._FB_READY); 
      }, 8000);
    });
  };
})();