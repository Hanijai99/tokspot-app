'use strict';
/**
 * Round 9.15 — migration-gate coverage for the two pages/paths the
 * round 9.13 write audit missed.
 *
 * Round 9.13 audited direct Firestore *writes*. These two were reads
 * (plus one write that fires only because a sanitized read is missing
 * fields), so they slipped through:
 *
 * 1. qr.html did a bare `hospitals` collection query and a
 *    `hospitals/{slug}/doctors` query with no API path at all — it did
 *    not even load js/api.js. firestore.rules.target gates the
 *    hospitals read on isAdminOf(slug), which cannot be proven to hold
 *    for a whole result set, so both queries are denied and the page
 *    was dead in functions mode. It now resolves the caller's own
 *    hospital via getMyHospital and lists doctors via
 *    listDoctorsPublic.
 *
 * 2. admin.html's legacy hospital self-heal ran in both modes. The
 *    getMyHospital projection deliberately omits adminEmail/adminUid/
 *    recoveryKey, so the guard was always true and every admin page
 *    load fired a client-side updateDoc rewriting the hospital doc's
 *    owner fields — reintroducing the client-chosen-ownership write
 *    that round 9.13 removed from the create path.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');

// ------------------------------------------------------------------
//  qr.html
// ------------------------------------------------------------------

test('qr.html loads js/api.js so the functions path is reachable', () => {
  assert.match(
    read('qr.html'),
    /<script src="js\/api\.js\?v=\d+"><\/script>/,
    'qr.html must load js/api.js or TokSpotAPI is undefined in functions mode'
  );
});

test('qr.html never queries the hospitals collection in functions mode', () => {
  const src = read('qr.html');
  const scanIdx = src.indexOf("collection(window._db, 'hospitals')");
  assert.ok(scanIdx > -1, 'expected the prototype scan to still exist');
  const before = src.slice(Math.max(0, scanIdx - 900), scanIdx);
  const lastIf = before.lastIndexOf('if (FUNC)');
  const tail = lastIf === -1 ? '' : before.slice(lastIf);
  assert.ok(
    lastIf > -1 && tail.lastIndexOf('return') > -1 && tail.indexOf('if (FUNC)', 1) === -1,
    'the bare hospitals scan must be unreachable in functions mode — either an else branch or a preceding `if (FUNC) { ... return; }`'
  );
});

test('qr.html resolves its hospital and doctors through callables', () => {
  const src = read('qr.html');
  assert.match(src, /TokSpotAPI\.getMyHospital\(\)/,
    'hospital dropdown must come from getMyHospital in functions mode');
  assert.match(src, /TokSpotAPI\.listDoctorsPublic\(\{\s*slug/,
    'doctor dropdown must come from listDoctorsPublic in functions mode');
});

test('qr.html keeps the prototype scan available in prototype mode', () => {
  const src = read('qr.html');
  assert.match(src, /collection\(window\._db, 'hospitals', qHos, 'doctors'\)/,
    'the prototype doctor scan must be retained behind the FUNC branch');
});

// ------------------------------------------------------------------
//  admin.html legacy self-heal
// ------------------------------------------------------------------

test('admin.html never lets the client rewrite hospital owner fields in functions mode', () => {
  const src = read('admin.html');
  const healIdx = src.indexOf('recoveryKey: window._fs.deleteField()');
  assert.ok(healIdx > -1, 'expected the legacy self-heal block to exist');
  // Walk back to the guard that introduces it.
  const before = src.slice(Math.max(0, healIdx - 700), healIdx);
  assert.match(
    before,
    /if \(!FUNC && \(!hData\.hospitalCode/,
    'the self-heal must be gated on !FUNC — getMyHospital returns a projection without adminEmail, so an unguarded check always fires'
  );
});

test('admin.html still self-heals in prototype mode', () => {
  const src = read('admin.html');
  assert.match(src, /adminUid: user\.uid/, 'prototype self-heal must keep stamping the owner');
  assert.match(src, /recoveryKey: window\._fs\.deleteField\(\)/, 'prototype self-heal must keep clearing the legacy recovery key');
});

// ------------------------------------------------------------------
//  Global invariant: every page with a direct Firestore call can reach
//  the API adapter.
// ------------------------------------------------------------------

test('every page with a direct Firestore call loads js/api.js', () => {
  const pages = fs.readdirSync(dir).filter((f) => f.endsWith('.html'));
  const offenders = [];
  for (const page of pages) {
    const src = fs.readFileSync(path.join(dir, page), 'utf8');
    const usesFs = /window\._fs\.(getDoc|getDocs|setDoc|updateDoc|addDoc|deleteDoc|onSnapshot)\(/.test(src);
    if (usesFs && !/js\/api\.js/.test(src)) offenders.push(page);
  }
  assert.deepStrictEqual(offenders, [],
    `these pages touch Firestore directly but never load js/api.js, so they cannot branch to functions mode: ${offenders.join(', ')}`);
});

test('no page queries the hospitals collection outside a prototype branch', () => {
  const pages = fs.readdirSync(dir).filter((f) => f.endsWith('.html'));
  const offenders = [];
  for (const page of pages) {
    const src = fs.readFileSync(path.join(dir, page), 'utf8');
    // A whole-collection hospitals scan is the specific pattern the
    // hardened rules cannot satisfy: the read is gated on a per-document
    // isAdminOf(slug) that cannot be proven to hold for a result set.
    const re = /collection\(window\._db, 'hospitals'\)/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const line = src.slice(0, m.index).split('\n').length;
      const before = src.slice(Math.max(0, m.index - 900), m.index);
      // Guarded either by an explicit prototype branch (`if (!FUNC) {
      // scan }`) or by the common shape here: a functions branch that
      // `return`s, letting the prototype scan fall through beneath it.
      // Both are safe — what must not happen is a scan reachable in
      // functions mode.
      const guarded =
        /if \(!FUNC\)/.test(before) ||
        /else\s*\{/.test(before) ||
        // `if (FUNC) {` ... `return;` ... `}` with no intervening `if (FUNC)`
        // after the last return.
        (() => {
          const lastIf = before.lastIndexOf('if (FUNC)');
          if (lastIf === -1) return false;
          const after = before.slice(lastIf);
          const lastReturn = after.lastIndexOf('return');
          return lastReturn > -1 && after.indexOf('if (FUNC)', lastIf + 1) === -1;
        })() ||
        /\/\/[^\n]*prototype/i.test(before);
      if (!guarded) offenders.push(`${page}:${line}`);
    }
  }
  assert.deepStrictEqual(offenders, [],
    `bare hospitals collection scans must be prototype-only: ${offenders.join(', ')}`);
});

test('analytics.html resolves its hospital through the callable in functions mode', () => {
  const src = read('analytics.html');
  assert.match(src, /TokSpotAPI\.getMyHospital\(\)/,
    'analytics hospital picker must come from getMyHospital in functions mode');
  // The prototype scan must survive behind the branch.
  assert.match(src, /isHospitalAdmin\(user, d\.data\(\)\)/,
    'prototype path must keep its adminUid client-side filter');
});