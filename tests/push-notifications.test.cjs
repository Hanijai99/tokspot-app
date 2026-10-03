'use strict';
/**
 * Round 9.16 — web-push (FCM) correctness.
 *
 * Push had never been exercised end to end, and reading it surfaced two
 * defects that only appear once the Functions are actually deployed.
 *
 * 1. Every patient's phone buzzed for every other patient. The device
 *    registration carried no queue-token identity — `token.html` called
 *    init({ slug, tokenId }) but init only forwarded `slug`, and
 *    tokenCalledNotify multicast to EVERY device registered under the
 *    hospital. So calling token #42 notified all patients at that
 *    hospital and disclosed #42 to each of them. Registration is now
 *    bound to one queue token and the trigger filters on it. Devices
 *    registered before tokenId existed are skipped rather than sent a
 *    message about someone else's number.
 *
 * 2. Push could never register at all. js/push.js called
 *    `TokSpotAPI.registerPushToken(...)`, but api.js never defined or
 *    exported it, so the call threw and the catch swallowed it as
 *    "[push] registration skipped". The callable existed on the server
 *    the whole time.
 *
 * Also asserted: the trigger stays sanitized (number + counter only,
 * never patient name/phone), and prunes tokens FCM reports as dead.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
const fn = read('functions/index.js');
const api = read('js/api.js');
const push = read('js/push.js');
const tokenHtml = read('token.html');
const sw = read('firebase-messaging-sw.js');

// ------------------------------------------------------------------
//  1. The adapter method must exist (it did not).
// ------------------------------------------------------------------

test('api.js defines and exports registerPushToken', () => {
  assert.match(api, /async function registerPushToken\(/,
    'js/push.js calls TokSpotAPI.registerPushToken — api.js must define it');
  assert.match(api, /\n\s*registerPushToken,/,
    'registerPushToken must be exported on the TokSpotAPI object');
});

test('registerPushToken forwards tokenId to the callable', () => {
  assert.match(api, /callFunction\('registerPushToken',\s*\{\s*slug,\s*token,\s*tokenId\s*\}\)/,
    'the adapter must forward tokenId, otherwise the server cannot filter per token');
});

test('registerPushToken never throws in prototype mode', () => {
  // push.js already gates on functions mode, but the adapter is public
  // API and must not blow up if called directly.
  assert.match(api, /if \(apiMode\(\) !== 'functions'\) return \{ ok: false, skipped: 'prototype' \}/,
    'prototype mode must return a skip result rather than throw');
});

// ------------------------------------------------------------------
//  2. Registration must be scoped to one queue token.
// ------------------------------------------------------------------

test('registerPushToken rejects a registration with no tokenId', () => {
  assert.match(fn, /if \(!tokenId\) throw new HttpsError\('invalid-argument', 'tokenId required\.'\)/,
    'a hospital-scoped registration must be refused — that is the bug being fixed');
});

test('registerPushToken stores the tokenId on the device record', () => {
  assert.match(fn, /hospitals\/\$\{slug\}\/pushTokens\/\$\{token\}`\)[\s\S]{0,400}tokenId:\s*String\(tokenId\)/,
    'the device record must record which queue token it is watching');
});

test('js/push.js refuses to register without a tokenId', () => {
  assert.match(push, /if \(!ctx\.tokenId\)/,
    'push.js must not silently register at hospital scope');
  assert.match(push, /registerPushToken\(\{\s*slug:\s*ctx\.slug,\s*token:\s*currentToken,\s*tokenId:\s*ctx\.tokenId\s*\}\)/,
    'push.js must forward tokenId');
});

// ------------------------------------------------------------------
//  3. The trigger must notify only that token's devices.
// ------------------------------------------------------------------

test('tokenCalledNotify filters devices by tokenId instead of blasting the hospital', () => {
  const i = fn.indexOf('exports.tokenCalledNotify');
  assert.ok(i > -1, 'expected the trigger to exist');
  const body = fn.slice(i, i + 2200);
  assert.match(body, /if \(String\(rec\.tokenId \|\| ''\) === String\(tokenId\)\) targets\.push\(d\.id\)/,
    'the send list must be filtered to devices watching this token');
  assert.doesNotMatch(
    body,
    /tokens:\s*tokens\.docs\.map\(/,
    'must not multicast to every device registered at the hospital'
  );
});

test('tokenCalledNotify still only fires on waiting → called', () => {
  const i = fn.indexOf('exports.tokenCalledNotify');
  const body = fn.slice(i, i + 600);
  assert.match(body, /normalizeStatus\(before\.status\) !== 'waiting'/);
  assert.match(body, /normalizeStatus\(after\.status\) !== 'called'/);
});

test('tokenCalledNotify sends no patient identity in the payload', () => {
  const i = fn.indexOf('exports.tokenCalledNotify');
  const body = fn.slice(i, i + 2200);
  // The notification carries number + counter only.
  assert.match(body, /body: `Token #\$\{after\.number\} is now called at \$\{after\.counter/);
  for (const field of ['patientName', 'phone', 'patientPhone', 'email']) {
    assert.ok(
      !new RegExp(`notification[\\s\\S]{0,300}${field}`).test(body),
      `push payload must not include ${field}`
    );
  }
});

test('tokenCalledNotify prunes devices FCM reports as unregistered', () => {
  const i = fn.indexOf('exports.tokenCalledNotify');
  const body = fn.slice(i, i + 2600);
  assert.match(body, /messaging\/registration-token-not-registered/,
    'dead tokens must be detected');
  assert.match(body, /pushTokens\/\$\{t\}`\)\.delete\(\)/,
    'dead tokens must be deleted so they do not accumulate');
});

test('the trigger still requires at least one subscribed device', () => {
  const i = fn.indexOf('exports.tokenCalledNotify');
  const body = fn.slice(i, i + 2200);
  assert.match(body, /if \(!targets\.length\)[\s\S]{0,120}return;/,
    'must no-op rather than send an empty multicast');
});

// ------------------------------------------------------------------
//  4. Configuration + service worker wiring.
// ------------------------------------------------------------------

test('the VAPID key is a documented, empty-by-default config value', () => {
  const cfg = read('js/firebase-config.js');
  assert.match(cfg, /window\.TOKSPOT_VAPID_KEY\s*=\s*"";/,
    'VAPID must default to empty so push stays inert until the console key is pasted');
  assert.match(cfg, /Web push certificates/,
    'the config comment must keep pointing at the console step');
});

test('the service worker exists at the site root and shows a notification', () => {
  assert.match(sw, /firebase\.messaging\(\)/);
  assert.match(sw, /onBackgroundMessage/);
  assert.match(sw, /showNotification/);
});

test('only the token pass registers for push', () => {
  const pages = fs.readdirSync(dir).filter((f) => f.endsWith('.html'));
  const loaders = pages.filter((p) => /js\/push\.js/.test(fs.readFileSync(path.join(dir, p), 'utf8')));
  assert.deepStrictEqual(loaders, ['token.html'],
    'push registration belongs on the patient pass only — a desk or TV registering would notify staff');
});

test('the pass supplies the tokenId that registration now requires', () => {
  assert.match(tokenHtml, /TokSpotPush\.init\(\{\s*slug,\s*tokenId\s*\}\)/,
    'token.html must pass tokenId to init, which now depends on it');
});