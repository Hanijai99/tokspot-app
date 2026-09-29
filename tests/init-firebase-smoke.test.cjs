/**
 * ============================================================
 *  initFirebase smoke test — catches browser-script regressions
 * ============================================================
 *  Runs js/firebase.js in a simulated window with the gstatic CDN
 *  imports replaced by mocks. If the module ever throws before
 *  assigning window._fs (e.g. an undeclared identifier like the
 *  Round-5 'appCheck' bug), this test fails in CI.
 *
 *  Run: node --test tests/init-firebase-smoke.test.cjs
 * ============================================================
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const FIREBASE_JS = path.join(__dirname, '..', 'js', 'firebase.js');

function mockify(src) {
  const mock = (mod) => `await Promise.resolve(${mod})`;
  // Order matters: longer specific names first so 'firebase-app.js'
  // never half-matches 'firebase-app-check.js'.
  return src
    .replace(
      /await import\('https:\/\/www\.gstatic\.com\/firebasejs\/10\.12\.2\/firebase-app-check\.js'\)/g,
      mock(`{ getAppCheck: () => { throw new Error('not initialized'); }, initializeAppCheck: () => ({}), ReCaptchaV3Provider: class {} }`)
    )
    .replace(
      /await import\('https:\/\/www\.gstatic\.com\/firebasejs\/10\.12\.2\/firebase-messaging\.js'\)/g,
      mock(`{ getMessaging: () => ({}) }`)
    )
    .replace(
      /await import\('https:\/\/www\.gstatic\.com\/firebasejs\/10\.12\.2\/firebase-app\.js'\)/g,
      mock(`{ initializeApp: () => ({}) }`)
    )
    .replace(
      /await import\('https:\/\/www\.gstatic\.com\/firebasejs\/10\.12\.2\/firebase-firestore\.js'\)/g,
      mock(`{ getFirestore: () => ({}), doc: 1, getDoc: 1, setDoc: 1, updateDoc: 1, deleteDoc: 1, deleteField: 1, collection: 1, query: 1, where: 1, orderBy: 1, limit: 1, onSnapshot: 1, addDoc: 1, getDocs: 1, serverTimestamp: 1, increment: 1, runTransaction: 1 }`)
    )
    .replace(
      /await import\('https:\/\/www\.gstatic\.com\/firebasejs\/10\.12\.2\/firebase-auth\.js'\)/g,
      mock(`{ getAuth: () => ({}) }`)
    );
}

function runInitFirebase({ siteKey = '', apiKey = 'mock-api-key' } = {}) {
  const src = mockify(fs.readFileSync(FIREBASE_JS, 'utf8'));
  const win = {
    FB_CONFIG: { apiKey },
    TOKSPOT_API_MODE: 'prototype',
    TOKSPOT_APP_CHECK_SITE_KEY: siteKey,
    _FB_READY: false,
  };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  // Strip the outer IIFE so the body defines initFirebase, then call it.
  const body = src
    .replace(/^\s*\(function\s*\(\s*\)\s*\{/, '')
    .replace(/\}\s*\)\s*;\s*$/, '');
  const fn = new AsyncFunction('window', body);
  return (async () => {
    await fn(win);
    if (typeof win.initFirebase === 'function') {
      await win.initFirebase();
    }
    return win;
  })();
}

test('initFirebase assigns window._fs and _FB_READY with no site key', async () => {
  const win = await runInitFirebase();
  assert.equal(win._FB_READY, true, '_FB_READY must be true');
  assert.ok(win._fs, 'window._fs must be assigned');
  assert.ok(win._fs.getDocs !== undefined, 'getDocs exposed');
  assert.equal(typeof win._useAuth.getAuth, 'function', 'auth module exposed');
});

test('initFirebase tolerates an empty App Check site key (no crash, _fs still set)', async () => {
  const win = await runInitFirebase({ siteKey: '' });
  assert.equal(win._FB_READY, true);
  assert.ok(win._fs, 'window._fs must be assigned even with site key unset');
});

test('initFirebase with a site key still finishes (App Check lazy loader defined)', async () => {
  const win = await runInitFirebase({ siteKey: '6LcMOCK-site-key' });
  assert.equal(win._FB_READY, true, '_FB_READY must be true with site key set');
  assert.ok(win._fs, 'window._fs must be assigned');
  assert.equal(typeof win._loadAppCheck, 'function', 'App Check loader exposed');
});