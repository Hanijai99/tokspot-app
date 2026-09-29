/**
 * Firestore Security Rules tests (Emulator Suite).
 *
 * Runs only when the emulator + @firebase/rules-unit-testing are
 * available (presence of the FIRESTORE_EMULATOR_HOST env var), so the
 * plain `node --test tests/` command stays green on machines without
 * them.
 *
 * Setup:
 *   npm install
 *   npm run emulators            # starts Firestore + Auth emulators
 *   (separate terminal) FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node --test tests/firestore-rules.test.cjs
 *
 * One-shot (no manual terminals, Java needed on PATH — use the JDK
 * bundled with Android Studio if Java is not installed):
 *
 *   $env:Path = "C:\Program Files\Android\Android Studio\jbr\bin;" + $env:Path
 *   npx firebase emulators:exec --project tokspot-rules-test --only firestore `
 *     "set FIRESTORE_EMULATOR_HOST=127.0.0.1:8080&& node --test tests\firestore-rules.test.cjs"
 */
'use strict';

const { before, after, test } = require('node:test');
const assert = require('node:assert');

let rulesTest = null;
try {
  rulesTest = require('@firebase/rules-unit-testing');
} catch (_) { rulesTest = null; }

const EMU = process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_EMULATOR_HOST || null;

let testEnv = null;

before(async () => {
  if (!rulesTest || !EMU) return;
  const rules = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'firestore.rules'), 'utf8');
  testEnv = await rulesTest.initializeTestEnvironment({
    projectId: 'tokspot-rules-test',
    firestore: { rules, host: '127.0.0.1', port: 8080 },
  });
  // seed: one hospital with one doctor and one token
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await db.doc('hospitals/h1').set({
      name: 'H1', adminUid: 'admin-1', adminEmail: 'admin@h1.test',
      hospitalCode: '1111', createdAt: new Date(),
    });
    await db.doc('hospitals/h1/doctors/d1').set({
      name: 'Dr One', authUid: 'doctor-1', hospitalSlug: 'h1', status: 'active',
    });
    await db.doc('hospitals/h1/tokens/t1').set({
      id: 't1', number: '001', patientName: 'PII', phone: '9999999999',
      doctorId: 'd1', date: '2026-09-26', status: 'waiting', createdAt: new Date(),
    });
  });
});

after(async () => {
  if (testEnv) await testEnv.cleanup();
});

const DENIED = /permission-denied/i;

if (!rulesTest || !EMU) {
  test('Firestore rules suite requires emulator + @firebase/rules-unit-testing', { skip: true, timeout: 1000 }, () => {});
} else {
  test('anonymous user cannot read a private token document', async () => {
    const anon = testEnv.unauthenticatedContext();
    await assert.rejects(
      anon.firestore().doc('hospitals/h1/tokens/t1').get(),
      DENIED
    );
  });

  test('anonymous user cannot write a token (issue must go through Functions)', async () => {
    const anon = testEnv.unauthenticatedContext();
    await assert.rejects(
      anon.firestore().doc('hospitals/h1/tokens/x9').set({ id: 'x9', status: 'called' }),
      DENIED
    );
  });

  test('doctor of another hospital cannot read hospital h1', async () => {
    // doctor-2 has no email claim — must still be denied cleanly
    const other = await testEnv.authenticatedContext('doctor-2');
    await assert.rejects(
      other.firestore().doc('hospitals/h1').get(),
      DENIED
    );
  });

  test('admin can read own hospital and doctor records', async () => {
    const admin = await testEnv.authenticatedContext('admin-1');
    const db = admin.firestore(); // cache — settings can only be applied once
    const h = await db.doc('hospitals/h1').get();
    assert.strictEqual(h.data().name, 'H1');
    const d = await db.doc('hospitals/h1/doctors/d1').get();
    assert.strictEqual(d.data().authUid, 'doctor-1');
  });

  test('assigned doctor can read own doctor profile', async () => {
    const doc = await testEnv.authenticatedContext('doctor-1');
    const db = doc.firestore();
    const d = await db.doc('hospitals/h1/doctors/d1').get();
    assert.strictEqual(d.data().name, 'Dr One');
  });

  test('clients cannot write auditLog rows', async () => {
    const admin = await testEnv.authenticatedContext('admin-1');
    await assert.rejects(
      admin.firestore().doc('auditLog/e1').set({ action: 'forged' }),
      DENIED
    );
  });
}