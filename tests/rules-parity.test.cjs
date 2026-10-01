'use strict';
/**
 * Both rulesets must stay in lockstep on the email-claim guard.
 *
 * `isAdmin()` reading `request.auth.token.email` directly makes the
 * rules engine raise an evaluation error (not a deny) for any caller
 * without an email claim — every anonymous / PIN-era sign-in the
 * prototype creates. firestore.rules.target had the callerEmail() guard
 * from round 3; the live prototype ruleset did not, so the console rules
 * drifted from the repo and the live site was serving the buggy version.
 *
 * The two files are deployed in different places (console vs
 * `firestore.json` -> firestore.rules.target), so nothing but a test
 * keeps them aligned.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..');
const live = fs.readFileSync(path.join(dir, 'firestore.rules'), 'utf8');
const target = fs.readFileSync(path.join(dir, 'firestore.rules.target'), 'utf8');

const RULESETS = [
  ['firestore.rules (live prototype)', live],
  ['firestore.rules.target (hardened)', target],
];

for (const [name, src] of RULESETS) {
  test(`${name} defines callerEmail() and uses it in isAdmin()`, () => {
    assert.match(
      src,
      /function callerEmail\(\)\s*\{\s*return \('email' in request\.auth\.token\)/,
      `${name} must define callerEmail() that checks the claim exists`
    );
    assert.match(
      src,
      /function isAdmin(?:Of)?\([\w,]+\)[\s\S]{0,400}callerEmail\(\)/,
      `${name} must compare adminEmail against callerEmail(), not the raw claim`
    );
  });

  test(`${name} never reads request.auth.token.email outside callerEmail()`, () => {
    // Drop comment lines, then strip the callerEmail definition itself.
    // (The helper's doc comment legitimately quotes the raw field name,
    // and comments are not evaluated by the rules engine.)
    const code = src
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
    const withoutHelper = code.replace(
      /function callerEmail\(\)\s*\{[\s\S]*?\n\s*\}/,
      ''
    );
    assert.doesNotMatch(
      withoutHelper,
      /request\.auth\.token\.email/,
      `${name} still reads the email claim directly — an email-less caller would hit an eval error instead of a deny`
    );
  });

  }

test('the two rulesets agree on the shared helper contract', () => {
  // Every helper name used by one must exist in the other, so a rename
  // cannot land in only one file.
  const helpers = (src) => new Set(
    [...src.matchAll(/function (\w+)\(/g)].map((m) => m[1])
  );
  const liveHelpers = helpers(live);
  const targetHelpers = helpers(target);
  // Each ruleset names its admin check differently (isAdmin vs
  // isAdminOf) — that is intentional and documented, not drift.
  const REQUIRED = {
    'firestore.rules': ['signedIn', 'callerEmail'],
    'firestore.rules.target': ['signedIn', 'callerEmail', 'isDoctorOf', 'canReadAuditEvent'],
  };
  for (const [file, list] of Object.entries(REQUIRED)) {
    const src = file === 'firestore.rules' ? live : target;
    const set = helpers(src);
    for (const h of list) {
      assert.ok(set.has(h), `${file} must define ${h}`);
    }
  }
  // Both must expose exactly one admin predicate.
  for (const [name, src] of RULESETS) {
    const set = helpers(src);
    const adminFns = [...set].filter((h) => /^isAdmin/.test(h));
    assert.equal(adminFns.length, 1, `${name} must have exactly one admin predicate, found ${adminFns.join(', ')}`);
  }
});