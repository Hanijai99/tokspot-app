'use strict';
// createHospital is the ends-state onboarding path: the hardened rules
// deny a brand-new admin writing their own hospital doc, so the callable
// must own slug/code minting and adminUid stamping.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..');
const fn = fs.readFileSync(path.join(dir, 'functions', 'index.js'), 'utf8');
const api = fs.readFileSync(path.join(dir, 'js', 'api.js'), 'utf8');
const signup = fs.readFileSync(path.join(dir, 'signup.html'), 'utf8');

// The helper block above the callable is part of its contract, so the
// slice starts at createHospital's own banner comment.
const start = fn.indexOf('//  createHospital —');
const body = fn.slice(start === -1 ? fn.indexOf('exports.createHospital') : start,
  fn.indexOf('//  resolveHospitalByCode'));

test('createHospital callable exists and is exported', () => {
  assert.match(body, /^exports\.createHospital = onCall\(/m, 'createHospital must be a callable');
  assert.match(body, /rateLimiting: RL\.createHospital/, 'createHospital must be rate limited');
});

test('createHospital refuses anonymous and throws unauthenticated otherwise', () => {
  assert.match(body, /if \(!uid\) throw new HttpsError\('unauthenticated'/, 'must require an authed caller');
  assert.match(
    body,
    /sign_in_provider === 'anonymous'[\s\S]{0,200}failed-precondition/,
    'must reject anonymous sign-ins explicitly'
  );
});

test('createHospital stamps adminUid from the auth token, never from the client', () => {
  // the client sends name/city/phone/email only — never an owner id
  assert.doesNotMatch(body, /request\.data[^\n]*adminUid/, 'adminUid must not be read from request.data');
  assert.match(body, /adminUid: uid/, 'adminUid must come from the authenticated uid');
  assert.doesNotMatch(body, /\{[^}]*adminUid[^}]*\}\s*=\s*request\.data/, 'must not spread client data into the doc');
});

test('createHospital enforces one hospital per admin', () => {
  assert.match(body, /where\('adminUid', '==', uid\)/, 'must check for an existing hospital owned by this uid');
  assert.match(body, /already-exists/, 'must refuse a second hospital for the same admin');
});

test('createHospital mints a unique slug and a non-colliding hospital code', () => {
  assert.match(body, /function slugifyHospitalName/, 'must server-side slugify the name');
  assert.match(body, /while \(attempt < 6\)[\s\S]{0,220}exists/, 'must probe for a free slug');
  assert.match(body, /randomHospitalCode/, 'must mint the hospital code server-side');
  assert.match(body, /where\('hospitalCode', '==', code\)/, 'must check code collisions');
  // and never trust a client-supplied code
  assert.doesNotMatch(body, /request\.data[^\n]*hospitalCode/, 'hospitalCode must not come from the client');
});

test('createHospital bounds the length of every client-supplied field', () => {
  for (const field of ['name', 'city', 'phone']) {
    assert.match(
      body,
      new RegExp(`${field}[^\\n]*slice\\(0, \\d+\\)`),
      `${field} must be length-capped`
    );
  }
  assert.match(body, /if \(!cleanName\) throw new HttpsError\('invalid-argument'/, 'name must be required');
});

test('createHospital writes an audit entry', () => {
  assert.match(body, /await audit\(uid, slug, 'hospital:create'/, 'must audit the onboarding');
});

test('js/api.js exposes createHospital with both a callable and a prototype path', () => {
  assert.match(api, /async function createHospital\(opts\)/, 'api must expose createHospital');
  assert.match(
    api,
    /apiMode\(\) !== 'functions'\) return createHospitalPrototype\(/,
    'prototype mode must keep the direct write'
  );
  assert.match(api, /return callFunction\('createHospital'/, 'functions mode must use the callable');
  assert.match(api, /^\s*createHospital,/m, 'createHospital must be in the public API surface');
});

test('signup.html creates the hospital through the API, not a raw setDoc', () => {
  assert.match(signup, /window\.TokSpotAPI\.createHospital\(/, 'signup must use the API adapter');
  assert.doesNotMatch(
    signup,
    /window\._fs\.setDoc\(hospDocRef/,
    'signup must not write the hospital doc directly any more'
  );
  assert.match(signup, /js\/api\.js/, 'signup.html must load js/api.js');
  // the slug/code now come back from the server
  assert.match(signup, /generatedSlug = created\.slug/, 'slug must come from the API result');
  assert.match(signup, /generatedCode = created\.hospitalCode/, 'code must come from the API result');
});