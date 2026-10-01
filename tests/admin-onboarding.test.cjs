'use strict';
/**
 * Admin hospital onboarding must go through the server in BOTH modes.
 *
 * Round 9.12 found the signup path could never survive the hardened
 * rules (isAdminOf() reads a doc that does not exist yet). The same bug
 * lived in a second place: admin.html's "Set Up Hospital Now" button,
 * which also wrote hospitals/{slug} directly. A third path — resolving
 * the admin's hospital by scanning the whole `hospitals` collection — is
 * also denied under the hardened rules, because the rule is evaluated
 * per document and a bare collection query cannot be proven to satisfy
 * isAdminOf().
 *
 * These tests pin all three so the migration cannot ship a dead admin
 * console.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..');
const admin = fs.readFileSync(path.join(dir, 'admin.html'), 'utf8');
const fn = fs.readFileSync(path.join(dir, 'functions', 'index.js'), 'utf8');
const api = fs.readFileSync(path.join(dir, 'js', 'api.js'), 'utf8');

const body = admin.slice(admin.indexOf('async function createInitialHospital'));

test('admin.html creates the hospital through the adapter, not a raw setDoc', () => {
  assert.match(body, /TokSpotAPI\.createHospital\(/, 'createInitialHospital must use the API adapter');
  assert.doesNotMatch(
    body.slice(0, 2500),
    /window\._fs\.setDoc\(window\._fs\.doc\(window\._db, 'hospitals'/,
    'admin.html must not write a hospital doc directly any more'
  );
  assert.doesNotMatch(body, /adminUid: uid/, 'the client must not choose the hospital owner');
});

test('admin.html resolves its hospital via the callable in functions mode', () => {
  const resolve = admin.slice(
    admin.indexOf('async function resolveAdminHospital'),
    admin.indexOf('function renderHospitalHeader')
  );
  assert.match(resolve, /if \(FUNC\) \{/, 'resolution must branch on the mode');
  assert.match(resolve, /TokSpotAPI\.getMyHospital\(\)/, 'functions mode must use the callable');
  assert.match(
    resolve,
    /window\._fs\.getDocs\(window\._fs\.collection\(window\._db, 'hospitals'\)\)/,
    'prototype mode must keep the collection scan'
  );
  // the scan must live in the else branch, i.e. prototype only
  const scanAt = resolve.indexOf("getDocs(window._fs.collection(window._db, 'hospitals'))");
  const callAt = resolve.indexOf('TokSpotAPI.getMyHospital');
  assert.ok(scanAt > callAt, 'the scan must come after the callable branch (else clause)');
});

test('a not-found from the callable falls through to the setup button', () => {
  const resolve = admin.slice(
    admin.indexOf('async function resolveAdminHospital'),
    admin.indexOf('function renderHospitalHeader')
  );
  assert.match(
    resolve,
    /catch \(e\) \{\s*if \(!\/not-found/,
    'a missing hospital must show the setup prompt, not an error'
  );
});

test('getMyHospital callable exists, is rate limited and requires auth', () => {
  const start = fn.indexOf('exports.getMyHospital = onCall(');
  assert.ok(start !== -1, 'getMyHospital must be a callable');
  const b = fn.slice(start, fn.indexOf('exports.createHospital = onCall('));
  assert.match(b, /rateLimiting: RL\./, 'must be rate limited');
  assert.match(b, /if \(!uid\) throw new HttpsError\('unauthenticated'/, 'must require an authed caller');
});

test('getMyHospital returns exactly one hospital and never a list', () => {
  const b = fn.slice(fn.indexOf('exports.getMyHospital'), fn.indexOf('exports.createHospital = onCall('));
  assert.match(b, /where\('adminUid', '==', uid\)\.limit\(1\)/, 'must query the caller\'s own uid');
  assert.match(b, /if \(!found\)[\s\S]{0,200}not-found/, 'must fail cleanly when none is linked');
  // a single object, never an array
  assert.doesNotMatch(b, /return \{ hospitals/, 'must not return a collection of hospitals');
  assert.doesNotMatch(b, /\[\s*\.\.\..*\]\s*;?\s*$/m, 'must not spread other tenants into the result');
  // and it must not hand back the whole doc
  assert.match(b, /slug: found\.id/, 'must return the slug explicitly');
  assert.doesNotMatch(b, /return found\.data\(\)/, 'must not return the raw doc');
});

test('getMyHospital never leaks other tenants through the email fallback', () => {
  const b = fn.slice(fn.indexOf('exports.getMyHospital'), fn.indexOf('exports.createHospital = onCall('));
  assert.match(b, /where\('adminEmail', '==', email\)\.limit\(1\)/, 'email fallback must be capped at one');
  // the returned shape must not include another admin's identifiers
  assert.doesNotMatch(b, /adminUid:|adminEmail:/, 'the response must not echo owner identifiers');
});

test('js/api.js exposes getMyHospital in functions mode only', () => {
  assert.match(api, /async function getMyHospital\(\)/, 'api must expose getMyHospital');
  assert.match(
    api,
    /apiMode\(\) !== 'functions'\) throw new Error\('getMyHospital needs functions mode\.'/,
    'prototype mode has no callable path for this'
  );
  assert.match(api, /return callFunction\('getMyHospital', \{\}\)/, 'functions mode must call it');
  assert.match(api, /^\s*getMyHospital,/m, 'must be in the public API surface');
});