'use strict';
/**
 * Prototype rules (`firestore.rules`) — emulator suite.
 *
 * Sibling to firestore-rules.test.cjs, which pins the HARDENED target.
 * This file pins the policy that is actually live during the prototype
 * phase, so the two can never drift apart silently and so the prototype
 * keeps working while the migration is pending.
 *
 * The behaviour this suite exists for: `isAdmin()` used to read
 * `request.auth.token.email` directly. Anonymous sign-ins (which
 * js/api.js ensureAuth() creates) carry NO email claim, so that read
 * threw an evaluation error instead of returning false — every rule
 * gated on isAdmin() failed with a rules *error* for email-less callers.
 * `callerEmail()` checks the claim exists first, which turns the error
 * into a clean deny. Same posture as firestore.rules.target.
 */
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
    projectId: 'tokspot-rules-live-test',
    firestore: { rules, host: '127.0.0.1', port: 8080 },
  });
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await db.doc('hospitals/h1').set({
      name: 'H1', adminUid: 'admin-1', adminEmail: 'admin@h1.test',
      hospitalCode: 'HOSP-1111', createdAt: new Date(),
    });
    await db.doc('hospitals/h2').set({
      name: 'H2', adminUid: 'admin-2', adminEmail: 'admin@h2.test',
      hospitalCode: 'HOSP-2222', createdAt: new Date(),
    });
    await db.doc('hospitals/h1/doctors/d1').set({
      name: 'Dr One', authUid: 'doctor-1', hospitalSlug: 'h1',
      status: 'active', onBreak: false, dailyLimit: 10,
    });
    await db.doc('hospitals/h1/tokens/t1').set({
      id: 't1', number: '001', hospitalId: 'h1', doctorId: 'd1',
      date: '2026-09-26', status: 'waiting', createdAt: new Date(),
    });
    await db.doc('hospitals/h1/rooms/r1').set({ name: 'Room 1', assignedDoctorId: 'd1' });
    await db.doc('hospitals/h1/queueState/2026-09-26_d1').set({ activeTokenId: 't1' });
    await db.doc('sms_queue/s1').set({ to: '+919999999999', status: 'pending' });
  });
});

after(async () => {
  if (testEnv) await testEnv.cleanup();
});

const DENIED = /permission-denied/i;

if (!rulesTest || !EMU) {
  test('Prototype rules suite requires emulator + @firebase/rules-unit-testing', { skip: true, timeout: 1000 }, () => {});
} else {
  // ------------------------------------------------------------------
  //  The regression this suite was written for.
  // ------------------------------------------------------------------

  test('REGRESSION: an email-less caller is denied cleanly, not via an eval error', async () => {
    // doctor-2 stands in for an anonymous / PIN-era sign-in: no email claim.
    // Before callerEmail() this hit `request.auth.token.email` and the
    // engine raised a rules evaluation error instead of denying.
    const noEmail = await testEnv.authenticatedContext('doctor-2', { email: undefined });
    const db = noEmail.firestore();
    await assert.rejects(
      db.doc('hospitals/h1').delete(),
      DENIED,
      'email-less caller must get a clean permission-denied, not an eval error'
    );
  });

  test('REGRESSION: every isAdmin()-gated delete denies cleanly for a no-email caller', async () => {
    const noEmail = await testEnv.authenticatedContext('doctor-3', { email: undefined });
    const db = noEmail.firestore();
    // hospitals delete, doctors delete, rooms delete, appointments delete
    await assert.rejects(db.doc('hospitals/h1').delete(), DENIED);
    await assert.rejects(db.doc('hospitals/h1/doctors/d1').delete(), DENIED);
    await assert.rejects(db.doc('hospitals/h1/rooms/r1').delete(), DENIED);
  });

  test('an email-less caller can still do what the prototype allows', async () => {
    // The prototype posture is deliberately cooperative: signed-in
    // callers may issue/update tokens, own the queueState lock, and set
    // the doctor self-service fields. callerEmail() must not have
    // narrowed any of that.
    const noEmail = await testEnv.authenticatedContext('doctor-4', { email: undefined });
    const db = noEmail.firestore();
    await db.doc('hospitals/h1/tokens/t2').set({
      id: 't2', number: '002', hospitalId: 'h1', date: '2026-09-26',
      status: 'waiting', createdAt: new Date(),
    });
    await db.doc('hospitals/h1/tokens/t1').update({ status: 'called' });
    await db.doc('hospitals/h1/queueState/2026-09-26_d1').update({ activeTokenId: 't1' });
    await db.doc('hospitals/h1/doctors/d1').update({ onBreak: true, breakUpdatedAt: new Date() });
    const doc = await db.doc('hospitals/h1/doctors/d1').get();
    assert.strictEqual(doc.data().onBreak, true);
  });

  test('anonymous (unauthenticated) callers are still refused entirely', async () => {
    const anon = testEnv.unauthenticatedContext();
    const db = anon.firestore(); // settings apply once per context
    await assert.rejects(db.doc('hospitals/h1').get(), DENIED);
    await assert.rejects(db.doc('hospitals/h1/tokens/t1').get(), DENIED);
  });

  test('a real admin of the hospital can delete where isAdmin() gates it', async () => {
    const admin = await testEnv.authenticatedContext('admin-1', { email: 'admin@h1.test' });
    const db = admin.firestore();
    // rooms delete is admin-only
    await db.doc('hospitals/h1/rooms/r1').delete();
    // The prototype posture lets any signed-in caller READ rooms, so a
    // post-delete get() still succeeds — that is expected here and is
    // exactly what the hardened target closes. Assert the delete took
    // effect on the data instead of on read access.
    const snap = await db.doc('hospitals/h1/rooms/r1').get();
    assert.strictEqual(snap.exists, false, 'room should be deleted');
  });

  test('an admin of another hospital cannot delete this one', async () => {
    const other = await testEnv.authenticatedContext('admin-2', { email: 'admin@h2.test' });
    const db = other.firestore();
    await assert.rejects(db.doc('hospitals/h1').delete(), DENIED);
  });

  test('sms_queue stays enqueue-only, and only for signed-in callers', async () => {
    const signedIn = await testEnv.authenticatedContext('desk-1');
    const db = signedIn.firestore();
    await db.collection('sms_queue').add({ to: '+919999999999', status: 'pending' });
    // but the browser may not read back or update the outbox
    await assert.rejects(db.collection('sms_queue').get(), DENIED);
    await assert.rejects(db.doc('sms_queue/s1').update({ status: 'sent' }), DENIED);
  });

  test('feedback may be submitted but never edited afterwards', async () => {
    const patient = await testEnv.authenticatedContext('patient-1');
    const db = patient.firestore();
    const ref = await db.collection('hospitals/h1/feedback').add({ rating: 5, comment: 'good' });
    await assert.rejects(ref.update({ rating: 1 }), DENIED, 'feedback must be immutable');
    await assert.rejects(ref.delete(), DENIED, 'feedback must not be deletable');
  });

  test('token status transitions are constrained to the known set', async () => {
    const desk = await testEnv.authenticatedContext('desk-2');
    const db = desk.firestore();
    await assert.rejects(
      db.doc('hospitals/h1/tokens/t1').update({ status: 'banana' }),
      DENIED,
      'unknown status must be refused'
    );
  });

  test('a token cannot be created with a mismatched id/hospitalId', async () => {
    const desk = await testEnv.authenticatedContext('desk-3');
    const db = desk.firestore();
    await assert.rejects(
      db.doc('hospitals/h1/tokens/bad1').set({
        id: 'something-else', hospitalId: 'h1', date: '2026-09-26', status: 'waiting',
      }),
      DENIED
    );
  });
}