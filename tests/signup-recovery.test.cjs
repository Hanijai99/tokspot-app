'use strict';
/**
 * Signup must recover when the Auth account already exists.
 *
 * THE BUG THIS PINS
 * -----------------
 * Deleting the Firestore `hospitals` document in the console does NOT delete
 * the Firebase Auth user. Auth and Firestore are separate stores. So the exact
 * recovery a clinic performs after a bad first attempt —
 *
 *     1. register at signup.html
 *     2. something fails partway (mail rejected, network drop, closed tab)
 *     3. delete the half-written Firestore doc by hand
 *     4. register again with the same email
 *
 * — reached step 4 with the Auth user alive and the Firestore doc gone. The
 * old code rethrew `auth/email-already-in-use` straight to the alert, so every
 * retry failed identically with "Email already registered!" and there was no
 * way back in through the signup form. The clinic was permanently stuck with
 * no path forward except the Login tab, which cannot create a hospital.
 *
 * THE FIX
 * -------
 * On `auth/email-already-in-use`, sign in with the password just typed and
 * carry on. If the account already owns a hospital, hand back the existing
 * Hospital Code instead of minting a second one.
 *
 * The security-relevant constraint is `findExistingHospitalFor()`: it matches
 * on `adminUid` ONLY, never on email. Matching on email would let anyone who
 * knows a hospital's admin address adopt that hospital by re-registering. That
 * mirrors admin.html:558-560 deliberately, and is pinned below.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..');
const signup = fs.readFileSync(path.join(dir, 'signup.html'), 'utf8');
const admin = fs.readFileSync(path.join(dir, 'admin.html'), 'utf8');

// The recovery logic, isolated from the DOM wiring around it.
const regStart = signup.indexOf('async function registerHospital');
const regEnd = signup.indexOf('function startVerificationPolling');
assert.ok(regStart !== -1 && regEnd > regStart, 'could not locate registerHospital()');
const reg = signup.slice(regStart, regEnd);

const finderStart = signup.indexOf('async function findExistingHospitalFor');
const finderEnd = signup.indexOf('async function registerHospital');
const finder = signup.slice(finderStart, finderEnd);

// ------------------------------------------------------------------
//  1. The dead-end must be gone
// ------------------------------------------------------------------

test('email-already-in-use is handled, not rethrown to the user', () => {
  assert.match(
    reg,
    /if \(authErr\.code !== 'auth\/email-already-in-use'\) throw authErr/,
    'only email-already-in-use may be recovered; every other auth error must still propagate'
  );
  // The recovery must be inside that catch — not merely present somewhere.
  const catchBlock = reg.slice(reg.indexOf('auth/email-already-in-use'), reg.indexOf('registeredUser = userCred.user'));
  assert.ok(catchBlock.length > 400,
    'no recovery code found inside the email-already-in-use handler');
  assert.doesNotMatch(
    catchBlock,
    /throw new Error\(\s*'Email already registered/i,
    'the dead-end message must be gone'
  );
});

test('recovery signs in with the password just typed', () => {
  assert.match(
    reg,
    /signInWithEmailAndPassword\(window\._auth, email, password\)/,
    'must reuse the typed credentials rather than asking the admin to guess'
  );
});

test('a wrong password points at the Login tab, not a raw Firebase error', () => {
  assert.match(
    reg,
    /'auth\/wrong-password'/,
    'must recognise the credential-mismatch errors Firebase actually returns'
  );
  assert.match(
    reg,
    /'auth\/invalid-credential'/,
    'must also handle invalid-credential, which replaced wrong-password in newer SDKs'
  );
  assert.match(reg, /Login tab/i, 'the message must tell the admin where to go instead');
  // A raw Firebase code leaking to an admin is a UX failure.
  assert.doesNotMatch(
    reg.slice(reg.indexOf('signInWithEmailAndPassword')),
    /alert\('Error: ' \+ pwErr\.message\)/,
    'do not surface a raw auth error to the admin'
  );
});

// ------------------------------------------------------------------
//  2. Never mint a second hospital for one admin
// ------------------------------------------------------------------

test('an account that already owns a hospital is resumed, not duplicated', () => {
  assert.match(
    reg,
    /const existing = await findExistingHospitalFor\(userCred\.user\)/,
    'must check for an existing hospital after resuming'
  );
  assert.match(reg, /window\.location\.href = 'admin\.html'/, 'must hand off to the admin console');

  // The createHospital call must be AFTER the existing check, and the existing
  // branch must return first. Otherwise a second hospital is minted.
  const checkAt = reg.indexOf('findExistingHospitalFor(userCred.user)');
  const returnAt = reg.indexOf('return;', checkAt);
  const createAt = reg.indexOf('TokSpotAPI.createHospital(');
  assert.ok(checkAt < createAt, 'the existing-hospital check must precede createHospital');
  assert.ok(returnAt < createAt, 'the existing-hospital branch must return before creating');
});

test('the existing Hospital Code is seeded into the session on resume', () => {
  const block = reg.slice(reg.indexOf('if (existing)'), reg.indexOf('registeredUser = userCred.user'));
  for (const key of ['tokspot_admin_hospital', 'tokspot_frontdesk_hospital', 'tokspot_hospital_code']) {
    assert.ok(block.includes(key),
      `resume must seed "${key}" or admin.html will not know which hospital to load`);
  }
});

// ------------------------------------------------------------------
//  3. THE SECURITY CONSTRAINT — ownership by uid, never by email
// ------------------------------------------------------------------

test('findExistingHospitalFor matches on adminUid only, never on email', () => {
  assert.match(
    finder,
    /=== user\.uid/,
    'ownership must be matched on the authenticated uid'
  );
  // Any email comparison here would let a stranger adopt a hospital by
  // re-registering with a known admin address.
  assert.doesNotMatch(
    finder,
    /adminEmail|\.email\s*===|===\s*user\.email|toLowerCase\(\)\s*===/,
    'findExistingHospitalFor must not match on email — that would allow adopting another admin\'s hospital'
  );
});

/**
 * Assert a file resolves its hospital by uid and not by email.
 *
 * Applied to BOTH files independently rather than string-diffing the two
 * copies: their formatting will drift harmlessly, but the rule must not.
 *
 * The email check is scoped to the RESOLUTION PREDICATE — the `.find(...)`
 * callback that picks which hospital doc is "mine". `user.email` legitimately
 * appears elsewhere in both files (display copy, the setup button), and
 * flagging that would train this test to be ignored.
 */
function assertResolvesByUidOnly(label, src) {
  const findAt = src.indexOf('.find(');
  assert.ok(findAt !== -1, `${label}: no hospital-matching predicate found`);

  // The predicate is the .find(...) callback; bracket-match to its close.
  let depth = 0, end = -1;
  for (let i = src.indexOf('(', findAt); i < src.length; i++) {
    const ch = src[i];
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  assert.ok(end > findAt, `${label}: could not bracket-match the predicate`);
  const pred = src.slice(findAt, end);

  assert.match(pred, /adminUid/, `${label}: predicate must read the doc's adminUid`);
  assert.match(pred, /=== *(user\.)?uid/, `${label}: predicate must compare that uid to the auth uid`);
  assert.doesNotMatch(
    pred,
    /adminEmail|user\.email|===\s*email|toLowerCase\(\)/,
    `${label}: predicate must NOT match on email — anyone knowing a hospital's admin ` +
    'address could then claim it by re-registering with that address'
  );
}

test('signup.html and admin.html both resolve ownership by uid, and agree', () => {
  assertResolvesByUidOnly('signup.html', finder);
  assertResolvesByUidOnly('admin.html', admin.slice(admin.indexOf('async function resolveAdminHospital')));
});

test('both modes are covered in both files: bare scan for prototype, callable for hardened', () => {
  // Drift in the OTHER direction is just as bad: if a bare scan ever runs
  // while functions mode is live, the hardened rules deny it and both signup
  // and the admin console dead-end again.
  const adminResolve = admin.slice(admin.indexOf('async function resolveAdminHospital'));

  assert.match(finder, /TokSpotAPI\.mode\(\) === 'functions'/, "signup.html must branch on mode");
  assert.match(finder, /TokSpotAPI\.getMyHospital\(\)/, 'signup.html functions mode must call the server');
  assert.match(finder, /getDocs\(window\._fs\.collection\(window\._db, 'hospitals'\)\)/,
    'signup.html prototype mode must keep the scan');

  assert.match(adminResolve, /if \(FUNC\) \{/, 'admin.html must branch on mode');
  assert.match(adminResolve, /TokSpotAPI\.getMyHospital\(\)/, 'admin.html functions mode must call the server');
  assert.match(adminResolve, /getDocs\(window\._fs\.collection\(window\._db, 'hospitals'\)\)/,
    'admin.html prototype mode must keep the scan');

  // In both, the callable branch must come FIRST — the hardened rules deny
  // the scan, so running it there is a guaranteed permission error.
  for (const [label, src] of [['signup.html', finder], ['admin.html', adminResolve]]) {
    assert.ok(
      src.indexOf('getMyHospital') < src.indexOf("collection(window._db, 'hospitals')"),
      `${label}: the bare scan must sit in the prototype else-branch, after the callable`
    );
  }
});

test('the prototype scan asks the server for nothing and guesses no owner', () => {
  assert.match(
    finder,
    /window\.TokSpotAPI\.mode\(\) === 'functions'/,
    'must branch on mode: functions mode has no readable bare collection'
  );
  assert.match(finder, /TokSpotAPI\.getMyHospital\(\)/, 'functions mode must ask the server');
});

// ------------------------------------------------------------------
//  4. A failed verification email must not destroy a created hospital
// ------------------------------------------------------------------

test('a rejected verification email cannot destroy the new hospital', () => {
  const mailBlock = reg.slice(reg.indexOf('sendEmailVerification'));
  assert.match(mailBlock, /catch \(mailErr\)/, 'sendEmailVerification must be wrapped');
  assert.ok(
    reg.slice(reg.indexOf('registeredUser.emailVerified'), reg.indexOf('TokSpotAPI.createHospital('))
      .includes('catch'),
    'the catch must sit before createHospital, otherwise the throw aborts the signup'
  );
  assert.doesNotMatch(
    reg.slice(reg.indexOf('catch (mailErr)'), reg.indexOf('TokSpotAPI.createHospital(')),
    /throw mailErr/,
    'the mail error must be swallowed and logged, not rethrown'
  );
});

test('the verification email is only sent to an unverified account', () => {
  assert.match(
    reg,
    /if \(!registeredUser\.emailVerified\) \{/,
    're-sending to a verified account is rejected by Firebase and would strand the signup'
  );
  // And the UI must not claim mail was sent when none was.
  assert.match(reg, /registeredUser\.emailVerified\) \{/, 'modal copy must branch on verified state');
  assert.match(reg, /'Already Verified'/, 'a resumed verified account needs honest modal copy');
});

// ------------------------------------------------------------------
//  5. Nothing else got loosened along the way
// ------------------------------------------------------------------

test('validation still runs before any auth call', () => {
  const before = reg.slice(0, reg.indexOf('createUserWithEmailAndPassword'));
  for (const guard of ['hospName', 'hospCity', 'adminPhone', 'adminEmail', 'adminPassword', 'privacyCheck']) {
    assert.ok(before.includes(guard), `validation for ${guard} must precede the auth call`);
  }
  assert.match(before, /privacyCheck\.checked/, 'the privacy policy gate must not be skippable');
});

test('the hospital is still created through the API adapter', () => {
  assert.match(reg, /TokSpotAPI\.createHospital\(\{/, 'must use the adapter');
  assert.doesNotMatch(reg, /setDoc\(window\._fs\.doc\(window\._db, 'hospitals'/, 'no direct hospital write');
});