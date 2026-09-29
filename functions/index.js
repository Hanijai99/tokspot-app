/**
 * ============================================================
 *  TokSpot trusted API (reference implementation)
 * ============================================================
 *  Roles: admin (hospital owner, Firebase Auth email/password),
 *         doctor (Firebase Auth user provisioned via provisionDoctor).
 *
 *  This is the SERVER-ENFORCED layer for the P0 architecture:
 *  clients never write tokens/counters/locks/audit events directly.
 *  The static pages must call these callables instead of Firestore
 *  SDK writes (migration task in README / PRODUCTION_READINESS.md).
 *
 *  Do NOT paste Admin credentials into browser code. This package
 *  runs only in the Firebase Functions runtime with the Admin SDK.
 * ============================================================
 */
'use strict';

const { initializeApp, applicationDefault, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { getMessaging } = require('firebase-admin/messaging');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentUpdated } = require('firebase-functions/v2/firestore');

// initializeApp() picks up GOOGLE_APPLICATION_CREDENTIALS when set,
// otherwise the default service account.
initializeApp({ credential: applicationDefault() });

const db = getFirestore();
const auth = getAuth();

// Queue domain — single source of truth shared with the client build
// (js/queue-domain.js); tests/domain-sync.test.cjs fails on drift.
const { ALLOWED_TRANSITIONS, normalizeStatus, canTransition } = require('./queue-domain');

// ------------------------------------------------------------------
//  Audit log (append-only; Functions-only writes per firestore.rules)
// ------------------------------------------------------------------
async function audit(actorUid, slug, action, targetId, outcome, detail) {
  try {
    await db.collection('auditLog').add({
      actorUid: actorUid || null,
      slug: slug || null,
      action,
      targetId: targetId || null,
      outcome,
      detail: detail || {},
      at: new Date(),
    });
  } catch (err) {
    // Never fail the business action because audit failed — but always log.
    console.error('audit write failed', action, err.message);
  }
}

// ------------------------------------------------------------------
//  Role checks (server side — the only checks that matter)
// ------------------------------------------------------------------
async function loadHospital(slug) {
  const snap = await db.doc(`hospitals/${slug}`).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

async function assertAdmin(context, slug) {
  const uid = context.auth && context.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');
  const h = await loadHospital(slug);
  if (!h) throw new HttpsError('not-found', 'Hospital not found.');
  const ok = h.adminUid === uid || h.adminEmail === (context.auth.token && context.auth.token.email);
  if (!ok) throw new HttpsError('permission-denied', 'Not an admin of this hospital.');
  return h;
}

async function assertDoctor(context, slug, doctorId) {
  const uid = context.auth && context.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');
  const snap = await db.doc(`hospitals/${slug}/doctors/${doctorId}`).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Doctor not found.');
  if (snap.data().authUid !== uid) {
    throw new HttpsError('permission-denied', 'This account is not the assigned doctor.');
  }
  return { id: doctorId, ...snap.data() };
}

function sanitizeNumber(input) {
  return String(input || '').replace(/^0+/, '') || '0';
}

// ------------------------------------------------------------------
//  issueToken — trusted token allocation (uniqueness + quota in one txn)
// ------------------------------------------------------------------
exports.issueToken = onCall({ maxInstances: 10 }, async (request) => {
  const { slug, code, doctorId, name, phone, priority, counter, source } =
    request.data || {};
  const today = new Date().toISOString().slice(0, 10);

  if (!slug || !doctorId) throw new HttpsError('invalid-argument', 'slug + doctorId required.');
  const hospital = await loadHospital(slug);
  if (!hospital) throw new HttpsError('not-found', 'Hospital not found.');
  if (code && String(hospital.hospitalCode || '').replace(/^HOSP-?/i, '') !== String(code).replace(/^HOSP-?/i, '')) {
    throw new HttpsError('permission-denied', 'Hospital code does not match.');
  }
  const cleanName = String(name || '').trim().slice(0, 60);
  if (!cleanName) throw new HttpsError('invalid-argument', 'Patient name required.');

  const cleanPhone = String(phone || '').replace(/\D/g, '').slice(-10);
  const counterRef = db.doc(`hospitals/${slug}/counters/${today}`);
  let tokenId = '';
  let number = '';

  try {
    await db.runTransaction(async (tx) => {
      // 1) Number uniqueness: single counter, incremented inside the txn.
      const cSnap = await tx.get(counterRef);
      const next = (cSnap.exists ? Number(cSnap.data().count || 0) : 0) + 1;
      if (!Number.isSafeInteger(next)) throw new Error('Counter overflow.');
      tx.set(counterRef, { count: next }, { merge: true });

      // 2) Per-day per-phone quota (client check is advisory only).
      if (cleanPhone) {
        const q = await tx.get(db.collection(`hospitals/${slug}/tokens`)
          .where('phone', '==', cleanPhone).where('date', '==', today));
        if (q.size >= 2) throw new HttpsError('resource-exhausted', 'Phone number reached its 2-token daily limit.');
      }

      // 3) Unguessable document id = the patient's live-pass capability.
      tokenId = db.collection(`hospitals/${slug}/tokens`).doc().id;
      number = String(next).padStart(3, '0');
      tx.set(db.doc(`hospitals/${slug}/tokens/${tokenId}`), {
        id: tokenId,
        number,
        patientName: cleanName,
        phone: cleanPhone || '',
        doctorId,
        hospitalId: slug,
        date: today,
        status: 'waiting',
        source: source === 'online' ? 'online' : 'desk',
        priority: Boolean(priority),
        counter: counter || 'Counter A',
        createdAt: new Date(),
      });
    });
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    throw new HttpsError('internal', `Issue failed: ${err.message}`);
  }

  await audit(request.auth.uid, slug, 'issue', tokenId, 'ok', { number, source });
  return { slug, tokenId, number };
});

// ------------------------------------------------------------------
//  transitionToken — call/skip/complete/requeue with lock + matrix
// ------------------------------------------------------------------
exports.transitionToken = onCall({ maxInstances: 10 }, async (request) => {
  const { slug, tokenId, nextStatus, changes } = request.data || {};
  if (!slug || !tokenId || !nextStatus) {
    throw new HttpsError('invalid-argument', 'slug, tokenId, nextStatus required.');
  }
  const actorUid = request.auth && request.auth.uid;
  if (!actorUid) throw new HttpsError('unauthenticated', 'Sign in required.');

  // Authorization is derived from the caller's Auth UID — never from a
  // client-supplied doctorId. Admin may operate any desk row; a doctor
  // may only transition tokens whose doctorId matches their own
  // provisioned profile (authUid on hospitals/{slug}/doctors/{docId}).
  const hospitalRef = db.doc(`hospitals/${slug}`);
  const hospitalSnap = await hospitalRef.get();
  if (!hospitalSnap.exists) throw new HttpsError('not-found', 'Hospital not found.');
  const hospital = hospitalSnap.data();
  const isAdmin = hospital.adminUid === actorUid ||
    hospital.adminEmail === (request.auth.token && request.auth.token.email);

  const pre = await db.doc(`hospitals/${slug}/tokens/${tokenId}`).get();
  if (!pre.exists) throw new HttpsError('not-found', 'Token not found.');
  const preDoctorId = String(pre.data().doctorId || 'unassigned');
  if (!isAdmin) {
    const docSnap = await db.doc(`hospitals/${slug}/doctors/${preDoctorId}`).get();
    const own = docSnap.exists && docSnap.data().authUid === actorUid;
    if (!own) throw new HttpsError('permission-denied', 'Not authorized for this token.');
  }

  const tokenRef = db.doc(`hospitals/${slug}/tokens/${tokenId}`);
  const outcome = await db.runTransaction(async (tx) => {
    const snap = await tx.get(tokenRef);
    if (!snap.exists) throw new HttpsError('not-found', 'Token not found.');
    const token = snap.data();
    const from = normalizeStatus(token.status);
    if (!canTransition(from, nextStatus)) {
      throw new HttpsError('failed-precondition', `Invalid transition: ${from} → ${nextStatus}.`);
    }

    const date = String(token.date || 'unknown');
    const docId = String(changes && changes.doctorId) || preDoctorId;
    const lockRef = db.doc(`hospitals/${slug}/queueState/${date}_${encodeURIComponent(docId)}`);
    const lockSnap = await tx.get(lockRef);
    const activeId = lockSnap.exists ? lockSnap.data().activeTokenId : null;

    if (nextStatus === 'called' && activeId && activeId !== tokenId) {
      throw new HttpsError('failed-precondition', 'This doctor already has an active patient.');
    }
    if ((nextStatus === 'completed' || nextStatus === 'skipped') && activeId && activeId !== tokenId) {
      throw new HttpsError('failed-precondition', 'This token is not the active patient.');
    }

    const nowMs = Date.now();
    const patch = { ...(changes || {}), status: nextStatus, updatedAt: new Date(nowMs) };
    if (nextStatus === 'called') patch.calledAt = new Date(nowMs);
    if (nextStatus === 'completed') patch.completedAt = new Date(nowMs);
    if (nextStatus === 'skipped') patch.skippedAt = new Date(nowMs);
    if (nextStatus === 'canceled') patch.canceledAt = new Date(nowMs);

    tx.update(tokenRef, patch);
    if (nextStatus === 'called') {
      tx.set(lockRef, { doctorId: docId, date, activeTokenId: tokenId, updatedAt: new Date(nowMs) });
    } else if ((nextStatus === 'completed' || nextStatus === 'skipped') && activeId === tokenId) {
      tx.set(lockRef, { doctorId: docId, date, activeTokenId: null, updatedAt: new Date(nowMs) });
    }
    return { from, nextStatus };
  });

  await audit(actorUid, slug, `transition:${nextStatus}`, tokenId, 'ok', outcome);
  return outcome;
});

// ------------------------------------------------------------------
//  cancelToken — patient self-cancel, verified by phone on the token
// ------------------------------------------------------------------
exports.cancelToken = onCall(async (request) => {
  const { slug, tokenId, phone } = request.data || {};
  const snap = await db.doc(`hospitals/${slug}/tokens/${tokenId}`).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Token not found.');
  const t = snap.data();
  if (String(t.phone || '') !== String(phone || '').replace(/\D/g, '').slice(-10)) {
    throw new HttpsError('permission-denied', 'Phone does not match this token.');
  }
  if (!canTransition(t.status, 'canceled')) {
    throw new HttpsError('failed-precondition', 'Token can no longer be canceled.');
  }
  await db.doc(`hospitals/${slug}/tokens/${tokenId}`).update({
    status: 'canceled', canceledAt: new Date(), updatedAt: new Date(),
  });
  await audit(request.auth && request.auth.uid, slug, 'transition:canceled', tokenId, 'ok', { byPatient: true });
  return { ok: true };
});

// ------------------------------------------------------------------
//  getDoctorQueue — the doctor desk's own day queue (staff view)
// ------------------------------------------------------------------
exports.getDoctorQueue = onCall(async (request) => {
  const { slug, doctorId } = request.data || {};
  if (!slug || !doctorId) throw new HttpsError('invalid-argument', 'slug + doctorId required.');
  await assertDoctor(request, slug, doctorId);
  const today = new Date().toISOString().slice(0, 10);
  const docs = await db.collection(`hospitals/${slug}/tokens`)
    .where('doctorId', '==', doctorId).where('date', '==', today).get();
  const rows = [];
  docs.forEach((d) => {
    const t = d.data();
    rows.push({
      id: d.id,
      number: t.number,
      patientName: t.patientName || '',
      phone: t.phone || '',
      status: normalizeStatus(t.status),
      priority: Boolean(t.priority),
      counter: t.counter || 'Counter A',
      createdAt: t.createdAt ? t.createdAt.toMillis() : null,
      calledAt: t.calledAt ? t.calledAt.toMillis() : null,
    });
  });
  rows.sort((a, b) => Number(a.number) - Number(b.number));
  return { rows };
});

// ------------------------------------------------------------------
//  getTokenStatus — sanitized patient pass feed (no names/phones)
// ------------------------------------------------------------------
exports.getTokenStatus = onCall(async (request) => {
  const { slug, tokenId } = request.data || {};
  const today = new Date().toISOString().slice(0, 10);
  const snap = await db.doc(`hospitals/${slug}/tokens/${tokenId}`).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Token not found.');
  const t = snap.data();
  const docs = await db.collection(`hospitals/${slug}/tokens`)
    .where('doctorId', '==', t.doctorId).where('date', '==', today).get();
  let ahead = 0;
  let serving = 0;
  docs.forEach((d) => {
    const s = normalizeStatus(d.data().status);
    const n = Number(d.data().number || 0);
    if (s === 'called') serving = Math.max(serving, n);
    if (s === 'waiting' && n < Number(t.number || 0)) ahead += 1;
  });
  return {
    number: t.number,
    status: normalizeStatus(t.status),
    counter: t.counter || 'Counter A',
    doctorName: t.doctorName || t.doctorId || '',
    createdAt: t.createdAt ? t.createdAt.toMillis() : null,
    calledAt: t.calledAt ? t.calledAt.toMillis() : null,
    completedAt: t.completedAt ? t.completedAt.toMillis() : null,
    aheadCount: ahead,
    nowServing: serving || 0,
  };
});

// ------------------------------------------------------------------
//  getTvFeed — sanitized waiting-room board (no names/phones/PII)
// ------------------------------------------------------------------
exports.getTvFeed = onCall(async (request) => {
  const { slug } = request.data || {};
  if (!slug) throw new HttpsError('invalid-argument', 'slug required.');
  const today = new Date().toISOString().slice(0, 10);
  const docs = await db.collection(`hospitals/${slug}/tokens`)
    .where('date', '==', today).limit(200).get();
  const board = { waiting: [], serving: [] };
  docs.forEach((d) => {
    const t = d.data();
    const s = normalizeStatus(t.status);
    if (s === 'waiting') board.waiting.push({ number: t.number, priority: Boolean(t.priority), counter: t.counter || 'Counter A' });
    if (s === 'called') board.serving.push({ number: t.number, doctorId: t.doctorId, counter: t.counter || 'Counter A' });
  });
  board.waiting.sort((a, b) => Number(a.number) - Number(b.number));
  return board;
});

// ------------------------------------------------------------------
//  registerPushToken — patient device token under the hospital
// ------------------------------------------------------------------
exports.registerPushToken = onCall(async (request) => {
  const { slug, token } = request.data || {};
  if (!slug || !token || token.length < 20) throw new HttpsError('invalid-argument', 'slug + token required.');
  const uid = request.auth && request.auth.uid;
  await db.doc(`hospitals/${slug}/pushTokens/${token}`).set({
    uid: uid || 'anonymous',
    registeredAt: new Date(),
    ua: (request.headers && request.headers['user-agent']) || null,
  }, { merge: true });
  return { ok: true };
});

// ------------------------------------------------------------------
//  provisionDoctor / revokeDoctor — no PINs, ever
// ------------------------------------------------------------------
exports.provisionDoctor = onCall(async (request) => {
  const { slug, doctorId, email, name, department } = request.data || {};
  await assertAdmin(request, slug);
  if (!email || !doctorId) throw new HttpsError('invalid-argument', 'email + doctorId required.');

  let user;
  try {
    user = await auth.createUser({ email, displayName: name || doctorId, emailVerified: true });
    await auth.setCustomUserClaims(user.uid, { role: 'doctor', hospitalSlug: slug });
  } catch (err) {
    throw new HttpsError('already-exists', `Auth provisioning failed: ${err.message}`);
  }

  await db.doc(`hospitals/${slug}/doctors/${doctorId}`).set({
    authUid: user.uid, email, name: name || doctorId, department: department || '',
    status: 'active', hospitalSlug: slug, updatedAt: new Date(),
  }, { merge: true });

  await audit(request.auth.uid, slug, 'doctor:provision', doctorId, 'ok', { authUid: user.uid });
  return { authUid: user.uid };
});

exports.revokeDoctor = onCall(async (request) => {
  const { slug, doctorId } = request.data || {};
  await assertAdmin(request, slug);
  const snap = await db.doc(`hospitals/${slug}/doctors/${doctorId}`).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Doctor not found.');
  const authUid = snap.data().authUid;
  if (authUid) {
    try { await auth.updateUser(authUid, { disabled: true }); } catch (_) {}
  }
  await db.doc(`hospitals/${slug}/doctors/${doctorId}`).update({
    status: 'inactive', authUid: null, disabledAt: new Date(),
  });
  await audit(request.auth.uid, slug, 'doctor:revoke', doctorId, 'ok', {});
  return { ok: true };
});

// ------------------------------------------------------------------
//  FCM push when a token is called (sanitized payload — no PII)
// ------------------------------------------------------------------
exports.tokenCalledNotify = onDocumentUpdated(
  'hospitals/{slug}/tokens/{tokenId}',
  async (event) => {
    const before = event.data.before.data() || {};
    const after = event.data.after.data() || {};
    if (normalizeStatus(before.status) !== 'waiting' || normalizeStatus(after.status) !== 'called') {
      return; // only fired on waiting → called
    }
    const slug = event.params.slug;
    const tokens = await db.collection(`hospitals/${slug}/pushTokens`).get();
    const message = {
      notification: {
        title: 'Your turn!',
        body: `Token #${after.number} is now called at ${after.counter || 'Counter A'}.`,
      },
      data: { slug, tokenId: event.params.tokenId, number: String(after.number || '') },
      tokens: tokens.docs.map((d) => d.id),
    };
    if (message.tokens.length) {
      const res = await getMessaging().sendEachForMulticast(message);
      console.log('push results', res.successCount, res.failureCount);
    }
  }
);