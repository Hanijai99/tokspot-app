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

const { initializeApp, applicationDefault } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { getMessaging } = require('firebase-admin/messaging');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');

// initializeApp() picks up GOOGLE_APPLICATION_CREDENTIALS when set,
// otherwise the default service account.
initializeApp({ credential: applicationDefault() });

const db = getFirestore();
const auth = getAuth();

// Queue domain — single source of truth shared with the client build
// (js/queue-domain.js); tests/domain-sync.test.cjs fails on drift.
const { ALLOWED_TRANSITIONS, normalizeStatus, canTransition, averageWaitMinutes, estimateWaitMinutes } = require('./queue-domain');
const queueDomain = require('./queue-domain');

// Measured + estimate wait stats for a set of day rows.
function queueStats(rows) {
  const waitingCount = rows.filter((r) => r.status === 'waiting').length;
  const served = rows.filter((r) => r.status === 'called' || r.status === 'completed' || r.status === 'skipped');
  const avgServeMinutes = averageWaitMinutes(served);
  return {
    waitingCount,
    avgServeMinutes,
    waitEstimateMinutes: estimateWaitMinutes({ waitingCount, avgServeMinutes }),
  };
}

// Doctor display status derived from its doc fields.
function doctorDisplayStatus(doc) {
  if (doc.status === 'closed') return 'closed';
  if (doc.onBreak) return 'break';
  return 'open';
}

// ------------------------------------------------------------------
//  Operation-scoped rate limits (abuse/bot guard per caller)
// ------------------------------------------------------------------
const RL = {
  issue: { maxCalls: 60, periodSeconds: 60 },
  transition: { maxCalls: 240, periodSeconds: 60 },
  pharmacy: { maxCalls: 120, periodSeconds: 60 },
  pharmacyQueue: { maxCalls: 120, periodSeconds: 60 },
  prescription: { maxCalls: 60, periodSeconds: 60 },
  cancel: { maxCalls: 60, periodSeconds: 60 },
  tokenStatus: { maxCalls: 120, periodSeconds: 60 },
  doctorQueue: { maxCalls: 120, periodSeconds: 60 },
  tvFeed: { maxCalls: 120, periodSeconds: 60 },
  tokenByNumber: { maxCalls: 20, periodSeconds: 60 },
  audit: { maxCalls: 30, periodSeconds: 60 },
  myProfile: { maxCalls: 30, periodSeconds: 60 },
  pushToken: { maxCalls: 30, periodSeconds: 60 },
  smsFlush: { maxCalls: 5, periodSeconds: 60 },
  provision: { maxCalls: 5, periodSeconds: 60 },
  createHospital: { maxCalls: 5, periodSeconds: 3600 },
  codeResolve: { maxCalls: 30, periodSeconds: 60 },
  listSlots: { maxCalls: 60, periodSeconds: 60 },
  createAppt: { maxCalls: 20, periodSeconds: 60 },
  deskAppts: { maxCalls: 60, periodSeconds: 60 },
  apptCheckIn: { maxCalls: 60, periodSeconds: 60 },
  reminderScan: { maxCalls: 10, periodSeconds: 60 },
  feedback: { maxCalls: 10, periodSeconds: 60 },
  analytics: { maxCalls: 30, periodSeconds: 60 },
  handover: { maxCalls: 20, periodSeconds: 60 },
};

// ------------------------------------------------------------------
//  Timezone-safe "today" — the clinic's day, never the client's.
//  Hospitals may set `timezone` (IANA) on their doc; falls back to
//  Asia/Kolkata. Layout: YYYY-MM-DD (same shape as prototype).
// ------------------------------------------------------------------
const DEFAULT_TZ = 'Asia/Kolkata';

function getHospitalTz(hospital) {
  return (hospital && hospital.timezone) || DEFAULT_TZ;
}

function todayInZone(tz, now) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now || new Date());
  const get = (type) => (parts.find((p) => p.type === type) || { value: '' }).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function daysAgoIso(n, from) {
  return new Date((from || Date.now()) - n * 864e5).toISOString().slice(0, 10);
}

function normalizeHospitalCode(input) {
  return String(input || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase().replace(/^HOSP/, '');
}

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
//  Notification outbox (server-side; consumers plug a provider — see
//  flushSmsOutbox / flushWhatsAppOutbox / smsRetention). The browser
//  never writes rows here. Each row carries `channel`: 'sms' or
//  'whatsapp' so two independent provider adapters can drain the same
//  queue.
// ------------------------------------------------------------------
async function enqueueNotify(slug, phone, body, channel) {
  if (!phone) return;
  try {
    await db.collection('sms_queue').add({
      slug,
      phone: String(phone).replace(/\D/g, '').slice(-10),
      body,
      channel: channel === 'whatsapp' ? 'whatsapp' : 'sms',
      status: 'pending',
      provider: null,
      attempts: 0,
      createdAt: new Date(),
    });
  } catch (err) {
    console.error(`${channel || 'sms'} enqueue failed`, slug, err.message);
  }
}

// Email reminder outbox: same design as sms_queue but for addresses.
// Consumed by flushEmailOutbox (provider adapter plugs in there).
async function enqueueEmailNotify(slug, to, subject, body) {
  if (!to) return;
  try {
    await db.collection('email_queue').add({
      slug,
      to: String(to).trim().slice(0, 120),
      subject: String(subject || '').slice(0, 140),
      body: String(body || '').slice(0, 600),
      status: 'pending',
      provider: null,
      attempts: 0,
      createdAt: new Date(),
    });
  } catch (err) {
    console.error('email enqueue failed', slug, err.message);
  }
}

// Enqueue every channel the hospital has enabled (default: SMS only).
// `hospital.notifyChannels` is set by the admin, e.g. ['sms','whatsapp'].
function channelsFor(hospital) {
  const list = Array.isArray(hospital && hospital.notifyChannels) ? hospital.notifyChannels : ['sms'];
  return list.length ? list : ['sms'];
}

async function notifyPatient(slug, hospital, phone, body) {
  const channels = channelsFor(hospital);
  await Promise.all(channels.map((ch) => enqueueNotify(slug, phone, body, ch === 'whatsapp' ? 'whatsapp' : 'sms')));
}

// ------------------------------------------------------------------
//  issueToken — trusted token allocation (uniqueness + quota + idempotency)
// ------------------------------------------------------------------
exports.issueToken = onCall({ maxInstances: 10, rateLimiting: RL.issue }, async (request) => {
  const { slug, code, doctorId, name, phone, priority, counter, source, idempotencyKey, pharmacy } =
    request.data || {};
  if (!slug || !doctorId) throw new HttpsError('invalid-argument', 'slug + doctorId required.');
  const hospital = await loadHospital(slug);
  if (!hospital) throw new HttpsError('not-found', 'Hospital not found.');
  if (code && normalizeHospitalCode(hospital.hospitalCode) !== normalizeHospitalCode(code)) {
    throw new HttpsError('permission-denied', 'Hospital code does not match.');
  }
  const cleanName = String(name || '').trim().slice(0, 60);
  if (!cleanName) throw new HttpsError('invalid-argument', 'Patient name required.');

  const cleanPhone = String(phone || '').replace(/\D/g, '').slice(-10);
  const tz = getHospitalTz(hospital);
  const today = todayInZone(tz);

  // Capture the wait estimate shown at issue time (before the new token
  // joins the queue) so analytics can later compare estimate vs actual.
  let estWaitMinutes = null;
  try {
    const snap = await db.collection(`hospitals/${slug}/tokens`)
      .where('doctorId', '==', doctorId).where('date', '==', today).get();
    const rows = [];
    snap.forEach((d) => rows.push(d.data()));
    estWaitMinutes = queueStats(rows).waitEstimateMinutes;
  } catch (_) { estWaitMinutes = null; }

  const key = String(idempotencyKey || '').slice(0, 80);
  let tokenId = '';
  let number = '';
  let reused = false;

  try {
    await db.runTransaction(async (tx) => {
      // 0) Idempotency: a retried request with the same key returns the
      //    already-issued token instead of creating a duplicate.
      if (key) {
        const dup = await tx.get(db.collection(`hospitals/${slug}/tokens`)
          .where('idempotencyKey', '==', key).where('date', '==', today));
        if (dup.size === 1) {
          const existing = dup.docs[0].data();
          tokenId = dup.docs[0].id;
          number = existing.number;
          reused = true;
          return;
        }
      }

      // 1) Doctor's daily token limit (0/unset = unlimited). Counted inside
      //    the txn so concurrent calls cannot exceed the cap; canceled rows
      //    free a slot. The doctor can adjust the limit any time via
      //    setDoctorDailyLimit (self-service) or the admin desk.
      const dSnap = await tx.get(db.doc(`hospitals/${slug}/doctors/${doctorId}`));
      const dailyLimit = dSnap.exists ? Number(dSnap.data().dailyLimit || 0) : 0;
      if (dailyLimit > 0) {
        const dayTokens = await tx.get(db.collection(`hospitals/${slug}/tokens`)
          .where('doctorId', '==', doctorId).where('date', '==', today));
        let issuedToday = 0;
        dayTokens.forEach((d) => {
          if (normalizeStatus(d.data().status) !== 'canceled') issuedToday++;
        });
        if (issuedToday >= dailyLimit) {
          throw new HttpsError('resource-exhausted',
            `This doctor's daily token limit of ${dailyLimit} has been reached. Please try again tomorrow.`);
        }
      }

      // 2) Number uniqueness: single counter, incremented inside the txn.
      const counterRef = db.doc(`hospitals/${slug}/counters/${today}`);
      const cSnap = await tx.get(counterRef);
      const next = (cSnap.exists ? Number(cSnap.data().count || 0) : 0) + 1;
      if (!Number.isSafeInteger(next)) throw new Error('Counter overflow.');
      tx.set(counterRef, { count: next }, { merge: true });

      // 3) Per-day per-phone quota (client check is advisory only).
      if (cleanPhone) {
        const q = await tx.get(db.collection(`hospitals/${slug}/tokens`)
          .where('phone', '==', cleanPhone).where('date', '==', today));
        if (q.size >= 2) throw new HttpsError('resource-exhausted', 'Phone number reached its 2-token daily limit.');
      }

      // 4) Unguessable document id = the patient's live-pass capability.
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
        idempotencyKey: key || null,
        estWaitMinutes,
        createdAt: new Date(),
        ...(pharmacy ? { pharmacy: true, pharmacyStatus: 'waiting', pharmacySentAt: new Date() } : {}),
      });
    });
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    throw new HttpsError('internal', `Issue failed: ${err.message}`);
  }

  if (!reused) {
    await audit(request.auth.uid, slug, 'issue', tokenId, 'ok', { number, source });
    if (cleanPhone) {
      await notifyPatient(slug, hospital, cleanPhone,
        `Your token #${number} at ${hospital.name || slug} is booked. Wait for your turn — you will be notified when called.`);
    }
  }
  return { slug, tokenId, number, reused };
});

// ------------------------------------------------------------------
//  routeToPharmacy — doctor desk sends a completed token to the
//  pharmacy counter (queue routing only, no clinical data).
// ------------------------------------------------------------------
exports.routeToPharmacy = onCall({ maxInstances: 10, rateLimiting: RL.pharmacy }, async (request) => {
  const { slug, tokenId } = request.data || {};
  if (!slug || !tokenId) throw new HttpsError('invalid-argument', 'slug + tokenId required.');
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');
  const hospital = await loadHospital(slug);
  if (!hospital) throw new HttpsError('not-found', 'Hospital not found.');
  const ref = db.doc(`hospitals/${slug}/tokens/${tokenId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Token not found.');
  const now = new Date();
  await ref.update({
    pharmacy: true,
    pharmacyStatus: 'waiting',
    pharmacySentAt: now,
  });
  await audit(uid, slug, 'pharmacy:routed', tokenId, 'ok', { number: snap.data().number });
  return { ok: true, tokenId };
});

// ------------------------------------------------------------------
//  pharmacyAction — pharmacy counter desk: call / recall / skip /
//  dispense a token routed to the pharmacy. Only queue-stage markers
//  are written; no medication or diagnosis data is ever stored.
// ------------------------------------------------------------------
exports.pharmacyAction = onCall({ maxInstances: 10, rateLimiting: RL.pharmacy }, async (request) => {
  const { slug, tokenId, action, counter } = request.data || {};
  if (!slug || !tokenId || !action) {
    throw new HttpsError('invalid-argument', 'slug + tokenId + action required.');
  }
  const allowed = ['call', 'recall', 'skip', 'dispense'];
  if (!allowed.includes(action)) throw new HttpsError('invalid-argument', 'Unknown pharmacy action.');
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');
  const hospital = await loadHospital(slug);
  if (!hospital) throw new HttpsError('not-found', 'Hospital not found.');

  const ref = db.doc(`hospitals/${slug}/tokens/${tokenId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Token not found.');
  const t = snap.data();
  if (t.pharmacy !== true) {
    throw new HttpsError('failed-precondition', 'Token is not routed to the pharmacy counter.');
  }
  const counterName = String(counter || 'Pharmacy').slice(0, 40);
  const now = new Date();
  const patch = {};
  if (action === 'call') {
    if (String(t.pharmacyStatus || '') === 'dispensed') throw new HttpsError('failed-precondition', 'Token was already dispensed.');
    patch.pharmacyStatus = 'called';
    patch.pharmacyCalledAt = now;
    patch.pharmacyCounter = counterName;
  } else if (action === 'recall') {
    if (String(t.pharmacyStatus || '') !== 'called') throw new HttpsError('failed-precondition', 'No active patient to recall.');
    patch.pharmacyCalledAt = now;
    patch.pharmacyRecallCount = (Number(t.pharmacyRecallCount) || 0) + 1;
  } else if (action === 'skip') {
    if (String(t.pharmacyStatus || '') === 'dispensed') throw new HttpsError('failed-precondition', 'Token was already dispensed.');
    patch.pharmacyStatus = 'skipped';
    patch.pharmacySkippedAt = now;
    patch.pharmacyCounter = counterName;
  } else if (action === 'dispense') {
    if (String(t.pharmacyStatus || '') !== 'called') throw new HttpsError('failed-precondition', 'No called patient at this counter to dispense.');
    patch.pharmacyStatus = 'dispensed';
    patch.pharmacyDispensedAt = now;
    patch.pharmacyCounter = counterName;
  }
  await ref.update(patch);
  await audit(uid, slug, `pharmacy:${action}`, tokenId, 'ok', { number: t.number, counter: counterName });
  return { ok: true, status: patch.pharmacyStatus };
});

// ------------------------------------------------------------------
//  getPharmacyQueue — today's pharmacy queue for a counter desk.
//  Staff view: token number, patient name (desk only), doctor, stage.
// ------------------------------------------------------------------
exports.getPharmacyQueue = onCall({ rateLimiting: RL.pharmacyQueue }, async (request) => {
  const { slug } = request.data || {};
  if (!slug) throw new HttpsError('invalid-argument', 'slug required.');
  const hospital = await loadHospital(slug);
  if (!hospital) throw new HttpsError('not-found', 'Hospital not found.');
  const today = todayInZone(getHospitalTz(hospital));
  const docs = await db.collection(`hospitals/${slug}/tokens`)
    .where('date', '==', today).get();
  const rows = [];
  docs.forEach((d) => {
    const t = d.data();
    // Pharmacy stage starts only after the consultation completes.
    if (t.pharmacy !== true || normalizeStatus(t.status) !== 'completed') return;
    rows.push({
      id: d.id,
      number: t.number,
      patientName: t.patientName || '',
      phone: t.phone || '',
      doctorName: t.doctorName || '',
      priority: Boolean(t.priority),
      pharmacyStatus: String(t.pharmacyStatus || 'waiting'),
      pharmacyCounter: String(t.pharmacyCounter || ''),
      createdAt: t.createdAt ? t.createdAt.toMillis() : null,
      pharmacySentAt: t.pharmacySentAt ? t.pharmacySentAt.toMillis() : null,
      pharmacyCalledAt: t.pharmacyCalledAt ? t.pharmacyCalledAt.toMillis() : null,
      pharmacyDispensedAt: t.pharmacyDispensedAt ? t.pharmacyDispensedAt.toMillis() : null,
      pharmacyRecallCount: Number(t.pharmacyRecallCount) || 0,
      prescription: t.prescription || null,
    });
  });
  rows.sort((a, b) => Number(a.number) - Number(b.number));
  return { rows };
});

// ------------------------------------------------------------------
//  savePrescription — doctor desk saves the consultation prescription
//  onto the token doc. The pharmacy queue reads it to dispense and the
//  patient pass displays/prints it. Clinical data only ever lives on the
//  token doc under the app's rules posture.
// ------------------------------------------------------------------
exports.savePrescription = onCall({ maxInstances: 10, rateLimiting: RL.prescription }, async (request) => {
  const { slug, tokenId, prescription } = request.data || {};
  if (!slug || !tokenId) throw new HttpsError('invalid-argument', 'slug + tokenId required.');
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');

  const rawItems = Array.isArray(prescription && prescription.items) ? prescription.items : [];
  if (!rawItems.length) throw new HttpsError('invalid-argument', 'At least one medicine is required.');
  if (rawItems.length > 50) throw new HttpsError('invalid-argument', 'Maximum 50 medicines per prescription.');

  const s = (v) => String(v == null ? '' : v).trim().slice(0, 120);
  const items = rawItems.map((it) => ({
    name: s(it && it.name),
    strength: s(it && it.strength),
    dose: s(it && it.dose),
    frequency: s(it && it.frequency),
    duration: s(it && it.duration),
    instructions: s(it && it.instructions),
  })).filter((it) => it.name);
  if (!items.length) throw new HttpsError('invalid-argument', 'At least one named medicine is required.');
  const notes = String(prescription ? prescription.notes || '' : '').slice(0, 500);

  const hospital = await loadHospital(slug);
  if (!hospital) throw new HttpsError('not-found', 'Hospital not found.');
  const ref = db.doc(`hospitals/${slug}/tokens/${tokenId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Token not found.');
  const status = normalizeStatus(snap.data().status || '');
  if (!['called', 'in-consultation', 'completed'].includes(status)) {
    throw new HttpsError('failed-precondition', 'Prescriptions can only be added while the patient is in consultation.');
  }

  await ref.update({
    prescription: {
      items,
      notes,
      prescribedBy: s(prescription && prescription.prescribedBy),
      prescribedAt: new Date(),
    },
  });
  await audit(uid, slug, 'token:prescription', tokenId, 'ok', { number: snap.data().number, items: items.length });
  return { ok: true, tokenId };
});

// ------------------------------------------------------------------
//  transitionToken — call/skip/complete/requeue with lock + matrix
// ------------------------------------------------------------------
exports.transitionToken = onCall({ maxInstances: 10, rateLimiting: RL.transition }, async (request) => {
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
      throw new HttpsError('failed-precondition', 'Cannot complete a token that is not the active patient.');
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
    return { from, nextStatus, phone: token.phone || '', number: token.number || '' };
  });

  await audit(actorUid, slug, `transition:${nextStatus}`, tokenId, 'ok', outcome);
  if (nextStatus === 'called' && outcome.phone) {
    await notifyPatient(slug, hospital, outcome.phone,
      `Good news! Token #${outcome.number} is now called. Please proceed to ${changes && changes.counter ? changes.counter : 'your doctor'}.`);
  }
  // Feedback survey goes out on completion (feature: patient feedback).
  if (nextStatus === 'completed' && outcome.phone) {
    const base = process.env.TOKSPOT_BASE_URL || 'https://tokspot-app.vercel.app';
    await notifyPatient(slug, hospital, outcome.phone,
      `Your consultation is complete. Please rate your visit: ${base}/feedback.html?h=${encodeURIComponent(slug)}&t=${encodeURIComponent(tokenId)}`);
  }
  return { from: outcome.from, nextStatus };
});

// ------------------------------------------------------------------
//  cancelToken — patient self-cancel, verified by phone on the token
// ------------------------------------------------------------------
exports.cancelToken = onCall({ rateLimiting: RL.cancel }, async (request) => {
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
exports.getDoctorQueue = onCall({ rateLimiting: RL.doctorQueue }, async (request) => {
  const { slug, doctorId } = request.data || {};
  if (!slug || !doctorId) throw new HttpsError('invalid-argument', 'slug + doctorId required.');
  await assertDoctor(request, slug, doctorId);
  const hospital = await loadHospital(slug);
  const today = todayInZone(getHospitalTz(hospital));
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
      source: t.source || 'desk',
      createdAt: t.createdAt ? t.createdAt.toMillis() : null,
      calledAt: t.calledAt ? t.calledAt.toMillis() : null,
    });
  });
  rows.sort((a, b) => Number(a.number) - Number(b.number));
  return { rows, stats: queueStats(rows) };
});

// ------------------------------------------------------------------
//  setDoctorBreak — doctor self-service or admin: toggles onBreak on
//  the doctor doc so the TV board + desk show the break state.
// ------------------------------------------------------------------
exports.setDoctorBreak = onCall({ rateLimiting: RL.myProfile }, async (request) => {
  const { slug, doctorId, onBreak, breakNote } = request.data || {};
  if (!slug || !doctorId) throw new HttpsError('invalid-argument', 'slug + doctorId required.');
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');

  const hospital = await loadHospital(slug);
  if (!hospital) throw new HttpsError('not-found', 'Hospital not found.');

  // Admin of the hospital can set any doctor; a doctor can set themselves.
  const isAdmin = hospital.adminUid === uid;
  const dSnap = await db.doc(`hospitals/${slug}/doctors/${doctorId}`).get();
  if (!dSnap.exists) throw new HttpsError('not-found', 'Doctor not found.');
  if (!isAdmin && dSnap.data().authUid !== uid) {
    throw new HttpsError('permission-denied', 'Not authorized for this doctor.');
  }

  const update = {
    onBreak: Boolean(onBreak),
    breakNote: String(breakNote || '').slice(0, 200),
    breakUpdatedAt: new Date().toISOString(),
  };
  await db.doc(`hospitals/${slug}/doctors/${doctorId}`).update(update);
  await audit(uid, slug, onBreak ? 'doctor:break-on' : 'doctor:break-off', doctorId, 'ok', { breakNote: update.breakNote });
  return { ok: true, onBreak: update.onBreak };
});

// ------------------------------------------------------------------
//  setDoctorDailyLimit — doctor self-service or admin: sets the cap on
//  how many tokens the doctor accepts per day (0 = unlimited). The
//  doctor can change it at any time; every change is audited. Enforced
//  server-side in issueToken and checkInAppointment.
// ------------------------------------------------------------------
exports.setDoctorDailyLimit = onCall({ rateLimiting: RL.myProfile }, async (request) => {
  const { slug, doctorId, dailyLimit } = request.data || {};
  if (!slug || !doctorId) throw new HttpsError('invalid-argument', 'slug + doctorId required.');
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');

  const hospital = await loadHospital(slug);
  if (!hospital) throw new HttpsError('not-found', 'Hospital not found.');

  const isAdmin = hospital.adminUid === uid ||
    hospital.adminEmail === (request.auth.token && request.auth.token.email);
  const dSnap = await db.doc(`hospitals/${slug}/doctors/${doctorId}`).get();
  if (!dSnap.exists) throw new HttpsError('not-found', 'Doctor not found.');
  if (!isAdmin && dSnap.data().authUid !== uid) {
    throw new HttpsError('permission-denied', 'Not authorized for this doctor.');
  }

  const n = Math.floor(Number(dailyLimit));
  if (!Number.isFinite(n) || n < 0 || n > 999) {
    throw new HttpsError('invalid-argument', 'dailyLimit must be a whole number 0-999 (0 = unlimited).');
  }
  await dSnap.ref.update({ dailyLimit: n, dailyLimitUpdatedAt: new Date().toISOString() });
  await audit(uid, slug, 'doctor:daily-limit', doctorId, 'ok', { dailyLimit: n });
  return { ok: true, dailyLimit: n };
});

// ------------------------------------------------------------------
//  getDeskQueue — front-desk staff feed. The "door key" is the
//  hospital code (as when authorizing the station). Returns the day's
//  rows for one doctor so the desk can call/print/skip without any
//  client token reads (the target rules deny those to anonymous desk
//  users).
// ------------------------------------------------------------------
exports.getDeskQueue = onCall({ rateLimiting: RL.doctorQueue }, async (request) => {
  const { code, doctorId } = request.data || {};
  if (!code || !doctorId) throw new HttpsError('invalid-argument', 'code + doctorId required.');

  const hospitals = await db.collection('hospitals').get();
  let slug = null;
  hospitals.forEach((h) => {
    if (normalizeHospitalCode(h.data().hospitalCode) === normalizeHospitalCode(code)) slug = h.id;
  });
  if (!slug) throw new HttpsError('permission-denied', 'Invalid hospital code.');

  const hospital = await loadHospital(slug);
  const today = todayInZone(getHospitalTz(hospital));
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
      source: t.source || 'desk',
      createdAt: t.createdAt ? t.createdAt.toMillis() : null,
      calledAt: t.calledAt ? t.calledAt.toMillis() : null,
    });
  });
  rows.sort((a, b) => Number(a.number) - Number(b.number));
  return { rows, slug, stats: queueStats(rows) };
});

// ------------------------------------------------------------------
//  getTokenStatus — sanitized patient pass feed (no names/phones)
// ------------------------------------------------------------------
exports.getTokenStatus = onCall({ rateLimiting: RL.tokenStatus }, async (request) => {
  const { slug, tokenId } = request.data || {};
  if (!slug || !tokenId) throw new HttpsError('invalid-argument', 'slug + tokenId required.');
  const hospital = await loadHospital(slug);
  if (!hospital) throw new HttpsError('not-found', 'Hospital not found.');
  const today = todayInZone(getHospitalTz(hospital));
  const snap = await db.doc(`hospitals/${slug}/tokens/${tokenId}`).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Token not found.');
  const t = snap.data();

  let doctorName = '';
  if (t.doctorId) {
    const dSnap = await db.doc(`hospitals/${slug}/doctors/${t.doctorId}`).get();
    if (dSnap.exists) {
      const d = dSnap.data();
      doctorName = [d.name, d.department].filter(Boolean).join(' · ');
    }
  }

  const docs = await db.collection(`hospitals/${slug}/tokens`)
    .where('doctorId', '==', t.doctorId).where('date', '==', today).get();
  let ahead = 0;
  let serving = 0;
  const dayRows = [];
  docs.forEach((d) => {
    const s = normalizeStatus(d.data().status);
    const n = Number(d.data().number || 0);
    dayRows.push({
      status: s,
      number: n,
      createdAt: d.data().createdAt ? d.data().createdAt.toMillis() : null,
      calledAt: d.data().calledAt ? d.data().calledAt.toMillis() : null,
    });
    if (s === 'called') serving = Math.max(serving, n);
    if (s === 'waiting' && n < Number(t.number || 0)) ahead += 1;
  });
  const stats = queueStats(dayRows);
  return {
    slug,
    tokenId,
    number: t.number,
    status: normalizeStatus(t.status),
    counter: t.counter || 'Counter A',
    hospitalName: hospital.name || slug,
    hospitalCode: hospital.hospitalCode || '',
    doctorName: doctorName || t.doctorName || t.doctorId || '',
    date: t.date || today,
    createdAt: t.createdAt ? t.createdAt.toMillis() : null,
    calledAt: t.calledAt ? t.calledAt.toMillis() : null,
    completedAt: t.completedAt ? t.completedAt.toMillis() : null,
    aheadCount: ahead,
    nowServing: serving || 0,
    avgServeMinutes: stats.avgServeMinutes,
    waitEstimateMinutes: estimateWaitMinutes({ waitingCount: ahead, avgServeMinutes: stats.avgServeMinutes }),
    prescription: t.prescription || null,
  };
});

// ------------------------------------------------------------------
//  getTvFeed — sanitized waiting-room board (no names/phones/PII)
// ------------------------------------------------------------------
exports.getTvFeed = onCall({ rateLimiting: RL.tvFeed }, async (request) => {
  const { slug } = request.data || {};
  if (!slug) throw new HttpsError('invalid-argument', 'slug required.');
  const hospital = await loadHospital(slug);
  if (!hospital) throw new HttpsError('not-found', 'Hospital not found.');
  const today = todayInZone(getHospitalTz(hospital));
  const docs = await db.collection(`hospitals/${slug}/tokens`)
    .where('date', '==', today).limit(200).get();
  const board = { waiting: [], serving: [] };
  docs.forEach((d) => {
    const t = d.data();
    const s = normalizeStatus(t.status);
    if (s === 'waiting') {
      board.waiting.push({ number: t.number, priority: Boolean(t.priority), counter: t.counter || 'Counter A' });
    }
    if (s === 'called') {
      board.serving.push({
        number: t.number,
        doctorId: t.doctorId || '',
        counter: t.counter || 'Counter A',
        calledAt: t.calledAt ? t.calledAt.toMillis() : 0,
      });
    }
  });
  board.waiting.sort((a, b) => Number(a.number) - Number(b.number));
  board.serving.sort((a, b) => (b.calledAt || 0) - (a.calledAt || 0));

  // Pharmacy counter board. Sanitized like the rest of the TV feed: the
  // token number and the counter label only, never a patient name, phone
  // or the prescription itself. A token joins this stage once the
  // consultation is completed and it has been routed to the pharmacy.
  // The projection is shared with the browser via functions/queue-domain.js.
  const pharmacyRows = [];
  docs.forEach((d) => {
    const t = d.data();
    if (t.pharmacy !== true || normalizeStatus(t.status) !== 'completed') return;
    pharmacyRows.push({
      pharmacyStatus: String(t.pharmacyStatus || 'waiting'),
      number: t.number,
      counter: String(t.pharmacyCounter || ''),
      calledAt: t.pharmacyCalledAt ? t.pharmacyCalledAt.toMillis() : 0,
    });
  });
  const pharmacyView = queueDomain.pharmacyBoardView(pharmacyRows);
  const pharmacy = pharmacyView.active
    ? {
      active: {
        number: pharmacyView.active.number,
        counter: pharmacyView.active.counter,
        calledAt: pharmacyView.active.calledAt,
      },
      waiting: pharmacyView.waiting,
    }
    : { active: null, waiting: pharmacyView.waiting };
  board.pharmacy = pharmacy;

  // Hall-level measured/estimate wait stats (all doctors, today).
  const hallRows = [];
  docs.forEach((d) => {
    const t = d.data();
    hallRows.push({
      status: normalizeStatus(t.status),
      createdAt: t.createdAt ? t.createdAt.toMillis() : null,
      calledAt: t.calledAt ? t.calledAt.toMillis() : null,
    });
  });
  const hallStats = queueStats(hallRows);

  // Doctor roster so the board can show break/closed state per doctor.
  const docSnap = await db.collection(`hospitals/${slug}/doctors`).get();
  const doctors = [];
  docSnap.forEach((d) => {
    const doc = d.data();
    if (doc.status === 'closed') return;
    doctors.push({
      id: d.id,
      name: doc.name || 'Doctor',
      department: doc.department || '',
      counter: doc.counter || doc.room || '',
      onBreak: Boolean(doc.onBreak),
      breakNote: doc.breakNote || '',
      displayStatus: doctorDisplayStatus(doc),
    });
  });

  return {
    ...board,
    pharmacy,
    waitEstimateMinutes: hallStats.waitEstimateMinutes,
    avgServeMinutes: hallStats.avgServeMinutes,
    doctors,
  };
});

// ------------------------------------------------------------------
//  getTokenByNumber — public lookup scoped to ONE hospital code.
//  Replaces the old cross-tenant client scan (privacy + cost). No
//  PII is returned: only a slug + unguessable token id for redirect.
// ------------------------------------------------------------------
exports.getTokenByNumber = onCall({ rateLimiting: RL.tokenByNumber }, async (request) => {
  const { code, number } = request.data || {};
  if (!code || !number) throw new HttpsError('invalid-argument', 'Hospital code and token number required.');
  const wanted = sanitizeNumber(number);
  const codePrefix = normalizeHospitalCode(code);

  const hospitals = await db.collection('hospitals').get();
  let target = null;
  hospitals.forEach((h) => {
    const hCode = normalizeHospitalCode(h.data().hospitalCode);
    if (hCode && hCode === codePrefix) target = { id: h.id, ...h.data() };
  });
  if (!target) throw new HttpsError('not-found', 'No hospital matches this code.');

  const today = todayInZone(getHospitalTz(target));
  const docs = await db.collection(`hospitals/${target.id}/tokens`)
    .where('date', '==', today).get();
  const matches = [];
  docs.forEach((d) => {
    const num = sanitizeNumber(d.data().number);
    if (num === wanted) matches.push({ id: d.id, num });
  });

  if (matches.length === 0) {
    throw new HttpsError('not-found', `No active token "${wanted}" found at this hospital today.`);
  }
  if (matches.length > 1) {
    throw new HttpsError('failed-precondition', 'This token number matches multiple passes today.');
  }
  await audit(request.auth && request.auth.uid, target.id, 'lookup:number', matches[0].id, 'ok', { number: wanted });
  return { slug: target.id, tokenId: matches[0].id, number: matches[0].num, hospitalName: target.name || target.id };
});

// ------------------------------------------------------------------
//  createHospital — hospital self-onboarding, server-mediated.
//
//  Why this exists: under the hardened policy a brand-new admin cannot
//  write their own /hospitals/{slug} doc (isAdminOf() needs a doc that
//  does not exist yet), so signup.html's direct setDoc is denied. This
//  callable performs the creation with Admin credentials and stamps
//  adminUid from the authenticated caller — the client can never choose
//  who owns the hospital.
//
//  Guards: requires a real (non-anonymous) Firebase Auth user, mints a
//  server-side slug + hospital code, enforces one hospital per admin,
//  and rate limits to 5/hour per caller. Nothing PII-bearing is trusted
//  from the client beyond length-capped name/city/phone/email.
// ------------------------------------------------------------------
function slugifyHospitalName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

async function randomHospitalCode() {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const n = Math.floor(1000 + Math.random() * 9000);
    const code = `HOSP-${n}`;
    const clash = await db.collection('hospitals')
      .where('hospitalCode', '==', code).limit(1).get();
    if (clash.empty) return code;
  }
  // Fall back to a time-derived code rather than failing the signup.
  return `HOSP-${String(Date.now()).slice(-4)}`;
}

// ------------------------------------------------------------------
//  getMyHospital — resolve the caller's OWN hospital doc.
//
//  Why: admin.html used to find its hospital by listing the whole
//  `hospitals` collection and matching adminUid in the browser. Under the
//  hardened rules that query is denied (the rule is evaluated per doc, so
//  a bare collection scan cannot be proven to satisfy isAdminOf), which
//  would leave an admin unable to reach their own dashboard. This
//  callable does the lookup with Admin credentials and returns only the
//  one hospital the caller owns — never a list, never another tenant.
// ------------------------------------------------------------------
exports.getMyHospital = onCall({ rateLimiting: RL.codeResolve }, async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in to load your hospital.');
  const email = request.auth.token && request.auth.token.email;

  let found = null;
  const byUid = await db.collection('hospitals').where('adminUid', '==', uid).limit(1).get();
  if (!byUid.empty) {
    found = byUid.docs[0];
  } else if (email) {
    // Fall back to the email claim for hospitals provisioned before
    // adminUid was stamped. Never matches more than one hospital: the
    // query is capped and the create path enforces one per identity.
    const byEmail = await db.collection('hospitals').where('adminEmail', '==', email).limit(1).get();
    if (!byEmail.empty) found = byEmail.docs[0];
  }
  if (!found) {
    await audit(uid, null, 'hospital:resolve', null, 'not-found', {});
    throw new HttpsError('not-found', 'No hospital is linked to this account.');
  }

  const d = found.data();
  const result = {
    slug: found.id,
    name: d.name || found.id,
    city: d.city || '',
    phone: d.phone || '',
    hospitalCode: d.hospitalCode || d.code || '',
    emailVerified: Boolean(d.emailVerified),
    status: d.status || 'active',
  };
  await audit(uid, found.id, 'hospital:resolve', found.id, 'ok', {});
  return result;
});

exports.createHospital = onCall({ rateLimiting: RL.createHospital }, async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in before creating a hospital.');
  if (request.auth.token && request.auth.token.firebase && request.auth.token.firebase.sign_in_provider === 'anonymous') {
    throw new HttpsError('failed-precondition', 'Use an email/password account to register a hospital.');
  }

  const { name, city, phone, email } = request.data || {};
  const cleanName = String(name || '').trim().slice(0, 120);
  if (!cleanName) throw new HttpsError('invalid-argument', 'Hospital name is required.');
  const cleanCity = String(city || '').trim().slice(0, 80);
  const cleanPhone = String(phone || '').trim().slice(0, 24);
  const cleanEmail = String(email || request.auth.token.email || '').trim().slice(0, 160);

  // One hospital per admin — otherwise a compromised client could mint
  // unlimited tenants under a single identity.
  const owned = await db.collection('hospitals').where('adminUid', '==', uid).limit(1).get();
  if (!owned.empty) {
    const existing = owned.docs[0];
    await audit(uid, existing.id, 'hospital:create', existing.id, 'rejected', { reason: 'already-owner' });
    throw new HttpsError('already-exists', 'This account already owns a hospital.');
  }

  const baseSlug = slugifyHospitalName(cleanName) || 'hospital';
  let slug = baseSlug;
  let attempt = 1;
  // eslint-disable-next-line no-await-in-loop
  while (attempt < 6) {
    const exists = await db.doc(`hospitals/${slug}`).get();
    if (!exists.exists) break;
    slug = `${baseSlug}-${attempt}`;
    attempt += 1;
  }
  const taken = await db.doc(`hospitals/${slug}`).get();
  if (taken.exists) throw new HttpsError('resource-exhausted', 'Could not allocate a hospital URL. Try a different name.');

  const code = await randomHospitalCode();
  const now = new Date();
  await db.doc(`hospitals/${slug}`).set({
    name: cleanName,
    city: cleanCity,
    phone: cleanPhone,
    hospitalCode: code,
    code,
    adminEmail: cleanEmail,
    adminUid: uid,
    emailVerified: false,
    status: 'active',
    createdAt: now,
    createdBy: 'signup',
  });
  await audit(uid, slug, 'hospital:create', slug, 'ok', { city: cleanCity });
  return { slug, hospitalCode: code };
});

// ------------------------------------------------------------------
//  resolveHospitalByCode — public code → {slug, name, code} lookup.
//  Used by TV display + doctor login; replaces client-side hospital
//  scans (which the target rules deny for anonymous visitors).
// ------------------------------------------------------------------
exports.resolveHospitalByCode = onCall({ rateLimiting: RL.codeResolve }, async (request) => {
  const { code } = request.data || {};
  if (!code) throw new HttpsError('invalid-argument', 'code required.');
  const wanted = normalizeHospitalCode(code);
  if (!wanted) throw new HttpsError('invalid-argument', 'code required.');

  const hospitals = await db.collection('hospitals').get();
  let target = null;
  hospitals.forEach((h) => {
    const hCode = normalizeHospitalCode(h.data().hospitalCode);
    if (hCode && hCode === wanted) {
      target = {
        id: h.id,
        name: h.data().name || h.id,
        hospitalCode: h.data().hospitalCode || code,
      };
    }
  });
  if (!target) throw new HttpsError('not-found', 'No hospital matches this code.');
  return target;
});

// ------------------------------------------------------------------
//  listDoctorsPublic — sanitized doctor options for the booking form /
//  front desk. Returns id, name, department, room and status only —
//  never authUid, email or PIN-era fields. Gates 'closed' doctors out.
// ------------------------------------------------------------------
exports.listDoctorsPublic = onCall({ rateLimiting: RL.codeResolve }, async (request) => {
  const { slug } = request.data || {};
  if (!slug) throw new HttpsError('invalid-argument', 'slug required.');
  const hospital = await loadHospital(slug);
  if (!hospital) throw new HttpsError('not-found', 'Hospital not found.');
  const docs = await db.collection(`hospitals/${slug}/doctors`).get();
  const doctors = [];
  docs.forEach((d) => {
    const doc = d.data();
    if (doc.status === 'closed') return;
    doctors.push({
      id: d.id,
      name: doc.name || 'Doctor',
      department: doc.department || 'Consultation',
      room: doc.room || doc.counter || '',
      status: doc.status || 'active',
      onBreak: Boolean(doc.onBreak),
      breakNote: doc.breakNote || '',
      displayStatus: doctorDisplayStatus(doc),
    });
  });
  doctors.sort((a, b) => a.name.localeCompare(b.name));
  return { doctors };
});

// ------------------------------------------------------------------
//  Advance appointments — public slot browsing/booking + desk check-in.
//  Slots are 15-minute windows derived from the doctor's weekly
//  `schedule` (admin-set); names/phones never leave the trusted side.
// ------------------------------------------------------------------
const SLOT_MINUTES = 15;
const DEFAULT_APPT_WINDOWS = [{ start: '09:00', end: '13:00' }];

function appointmentWindows(doctorDoc, dateStr) {
  const schedule = Array.isArray(doctorDoc && doctorDoc.schedule) ? doctorDoc.schedule : null;
  if (!schedule || !schedule.length) return DEFAULT_APPT_WINDOWS;
  const day = new Date(dateStr + 'T00:00:00Z').getUTCDay();
  const hits = schedule.filter((s) => Number(s.day) === day);
  if (!hits.length) return [];
  return hits
    .map((s) => ({ start: s.start || '09:00', end: s.end || '13:00' }))
    .filter((w) => w.start < w.end);
}

function minutesOf(timeStr) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(timeStr || ''));
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function fmtMinutes(total) {
  return String(Math.floor(total / 60)).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0');
}

function slotsForWindows(windows) {
  const out = [];
  for (const w of windows) {
    let cur = minutesOf(w.start);
    const end = minutesOf(w.end);
    if (cur === null || end === null) continue;
    while (cur + SLOT_MINUTES <= end) {
      out.push(fmtMinutes(cur));
      cur += SLOT_MINUTES;
    }
  }
  return out;
}

exports.listAvailableSlots = onCall({ rateLimiting: RL.listSlots }, async (request) => {
  const { slug, doctorId, date } = request.data || {};
  if (!slug || !doctorId || !date) throw new HttpsError('invalid-argument', 'slug + doctorId + date required.');
  const hospital = await loadHospital(slug);
  if (!hospital) throw new HttpsError('not-found', 'Hospital not found.');
  const dSnap = await db.doc(`hospitals/${slug}/doctors/${doctorId}`).get();
  if (!dSnap.exists) throw new HttpsError('not-found', 'Doctor not found.');
  if (dSnap.data().status === 'closed') {
    throw new HttpsError('failed-precondition', 'Doctor is not accepting bookings right now.');
  }

  const windows = appointmentWindows(dSnap.data(), date);
  const taken = new Set();
  const appts = await db.collection(`hospitals/${slug}/appointments`)
    .where('doctorId', '==', doctorId).where('date', '==', date).get();
  appts.forEach((d) => {
    const a = d.data();
    if (a.status === 'booked' || a.status === 'arrived') taken.add(a.slotStart);
  });
  return {
    date,
    slots: slotsForWindows(windows).map((start) => ({ start, taken: taken.has(start) })),
  };
});

exports.createAppointment = onCall({ rateLimiting: RL.createAppt }, async (request) => {
  const { slug, doctorId, date, slotStart, name, phone, email } = request.data || {};
  if (!slug || !doctorId || !date || !slotStart) {
    throw new HttpsError('invalid-argument', 'slug + doctorId + date + slotStart required.');
  }
  const hospital = await loadHospital(slug);
  if (!hospital) throw new HttpsError('not-found', 'Hospital not found.');
  const cleanName = String(name || '').trim().slice(0, 60);
  const cleanPhone = String(phone || '').replace(/\D/g, '').slice(-10);
  const cleanEmail = String(email || '').trim().slice(0, 120);
  if (cleanEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(cleanEmail)) {
    throw new HttpsError('invalid-argument', 'A valid email address is required for the reminder.');
  }
  if (!cleanName) throw new HttpsError('invalid-argument', 'Patient name required.');
  if (!cleanPhone || cleanPhone.length < 10) throw new HttpsError('invalid-argument', 'Valid 10-digit phone required.');

  const tz = getHospitalTz(hospital);
  const today = todayInZone(tz);
  const maxDate = new Date(new Date(today + 'T00:00:00Z').getTime() + 14 * 86400000).toISOString().slice(0, 10);
  if (date < today || date > maxDate) {
    throw new HttpsError('invalid-argument', 'Date must be within the next 14 days.');
  }

  const dSnap = await db.doc(`hospitals/${slug}/doctors/${doctorId}`).get();
  if (!dSnap.exists) throw new HttpsError('not-found', 'Doctor not found.');
  const slots = slotsForWindows(appointmentWindows(dSnap.data(), date));
  if (!slots.includes(slotStart)) throw new HttpsError('invalid-argument', 'Slot is outside the doctor\'s consultation hours.');

  const apptId = db.collection(`hospitals/${slug}/appointments`).doc().id;
  await db.runTransaction(async (tx) => {
    const conflict = await tx.get(db.collection(`hospitals/${slug}/appointments`)
      .where('doctorId', '==', doctorId).where('date', '==', date).where('slotStart', '==', slotStart));
    const conflictRows = [];
    conflict.forEach((d) => conflictRows.push(d));
    if (conflictRows.length) throw new HttpsError('conflict', 'That time slot was just booked. Please pick another.');

    const quota = await tx.get(db.collection(`hospitals/${slug}/appointments`)
      .where('phone', '==', cleanPhone).where('date', '==', date));
    const quotaCount = quota.docs ? quota.docs.length : quota.size;
    if (quotaCount >= 5) throw new HttpsError('resource-exhausted', 'Phone number reached its 5-booking daily limit.');

    tx.set(db.doc(`hospitals/${slug}/appointments/${apptId}`), {
      id: apptId,
      doctorId,
      doctorName: dSnap.data().name || doctorId,
      date,
      slotStart,
      patientName: cleanName,
      phone: cleanPhone,
      email: cleanEmail || null,
      status: 'booked',
      tokenId: null,
      createdBy: 'patient',
      createdAt: new Date(),
    });
  });
  await audit(request.auth && request.auth.uid, slug, 'appointment:create', apptId, 'ok', { doctorId, slotStart });
  return { ok: true, appointmentId: apptId, slotStart };
});

exports.listTodayAppointments = onCall({ rateLimiting: RL.deskAppts }, async (request) => {
  const { code, doctorId } = request.data || {};
  if (!code || !doctorId) throw new HttpsError('invalid-argument', 'code + doctorId required.');
  const hospitals = await db.collection('hospitals').get();
  let slug = null;
  hospitals.forEach((h) => {
    if (normalizeHospitalCode(h.data().hospitalCode) === normalizeHospitalCode(code)) slug = h.id;
  });
  if (!slug) throw new HttpsError('permission-denied', 'Invalid hospital code.');
  const hospital = await loadHospital(slug);
  const today = todayInZone(getHospitalTz(hospital));
  const docs = await db.collection(`hospitals/${slug}/appointments`)
    .where('doctorId', '==', doctorId).where('date', '==', today).get();
  const rows = [];
  docs.forEach((d) => {
    const a = d.data();
    rows.push({
      id: d.id,
      slotStart: a.slotStart || '',
      patientName: a.patientName || '',
      phone: a.phone || '',
      status: a.status || 'booked',
      tokenId: a.tokenId || null,
    });
  });
  rows.sort((x, y) => String(x.slotStart).localeCompare(String(y.slotStart)));
  return { rows, slug };
});

exports.checkInAppointment = onCall({ rateLimiting: RL.apptCheckIn }, async (request) => {
  const { code, appointmentId } = request.data || {};
  if (!code || !appointmentId) throw new HttpsError('invalid-argument', 'code + appointmentId required.');
  const hospitals = await db.collection('hospitals').get();
  let slug = null;
  hospitals.forEach((h) => {
    if (normalizeHospitalCode(h.data().hospitalCode) === normalizeHospitalCode(code)) slug = h.id;
  });
  if (!slug) throw new HttpsError('permission-denied', 'Invalid hospital code.');
  const hospital = await loadHospital(slug);
  const today = todayInZone(getHospitalTz(hospital));

  let tokenId = '';
  let number = '';
  let phone = '';
  await db.runTransaction(async (tx) => {
    const aSnap = await tx.get(db.doc(`hospitals/${slug}/appointments/${appointmentId}`));
    if (!aSnap.exists) throw new HttpsError('not-found', 'Appointment not found.');
    const a = aSnap.data();
    if (a.date !== today || a.status !== 'booked') {
      throw new HttpsError('failed-precondition', 'This appointment is not check-in-able today (already checked in or completed).');
    }
    phone = String(a.phone || '');

    // Doctor's daily token limit (0/unset = unlimited). Counted inside the
    // txn so concurrent check-ins cannot exceed the cap.
    const dSnap2 = await tx.get(db.doc(`hospitals/${slug}/doctors/${a.doctorId}`));
    const dailyLimit = dSnap2.exists ? Number(dSnap2.data().dailyLimit || 0) : 0;
    if (dailyLimit > 0) {
      const dayTokens = await tx.get(db.collection(`hospitals/${slug}/tokens`)
        .where('doctorId', '==', a.doctorId).where('date', '==', today));
      let issuedToday = 0;
      dayTokens.forEach((d) => {
        if (normalizeStatus(d.data().status) !== 'canceled') issuedToday++;
      });
      if (issuedToday >= dailyLimit) {
        throw new HttpsError('resource-exhausted',
          `This doctor's daily token limit of ${dailyLimit} has been reached. Please try again tomorrow.`);
      }
    }

    // Number uniqueness: the same daily counter the desk uses.
    const counterRef = db.doc(`hospitals/${slug}/counters/${today}`);
    const cSnap = await tx.get(counterRef);
    const next = (cSnap.exists ? Number(cSnap.data().count || 0) : 0) + 1;
    if (!Number.isSafeInteger(next)) throw new Error('Counter overflow.');
    tx.set(counterRef, { count: next }, { merge: true });

    tokenId = db.collection(`hospitals/${slug}/tokens`).doc().id;
    number = String(next).padStart(3, '0');
    tx.set(db.doc(`hospitals/${slug}/tokens/${tokenId}`), {
      id: tokenId,
      number,
      patientName: a.patientName,
      phone,
      doctorId: a.doctorId,
      hospitalId: slug,
      date: today,
      status: 'waiting',
      source: 'appointment',
      priority: false,
      counter: 'Counter A',
      appointmentId,
      createdAt: new Date(),
    });
    tx.update(db.doc(`hospitals/${slug}/appointments/${appointmentId}`), {
      status: 'arrived',
      tokenId,
      checkedInAt: new Date(),
    });
  });

  await audit(null, slug, 'appointment:checkin', appointmentId, 'ok', { tokenId, number });
  if (phone) {
    await notifyPatient(slug, hospital, phone,
      `You checked in at ${hospital.name || slug}. Your token #${number} is in queue — you will be notified when called.`);
  }
  return { ok: true, slug, tokenId, number };
});

// ------------------------------------------------------------------
//  Round 7 — appointment reminders + no-show, feedback, analytics,
//  and queue handover. All code-gated/authorized server-side.
// ------------------------------------------------------------------

// Resolve a hospital slug from a (sanitized) desk code. Returns null
// when no hospital matches — callers decide the error context.
async function slugForCode(code) {
  const hospitals = await db.collection('hospitals').get();
  let slug = null;
  hospitals.forEach((h) => {
    if (normalizeHospitalCode(h.data().hospitalCode) === normalizeHospitalCode(code)) slug = h.id;
  });
  return slug;
}

// minutes since midnight for a "HH:MM" slot string (or null).
function slotMinutes(slotStart) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(slotStart || ''));
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

// Drive a full reminder + no-show sweep for one hospital: sends the
// day-before reminder for tomorrow's bookings, the 2-hour-before
// reminder for today's upcoming slots, and auto-marks booked
// appointments whose slot passed 30+ minutes ago (still un-checked-in)
// as no-show. Idempotent via reminderSent1d/reminderSent2h flags.
async function runAppointmentSweep(slug, hospital) {
  const tz = getHospitalTz(hospital);
  const now = new Date();
  const today = todayInZone(tz, now);
  const tomorrow = todayInZone(tz, new Date(now.getTime() + 86400000));
  const nowParts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const partVal = (type) => (nowParts.find((p) => p.type === type) || { value: '0' }).value;
  const nowClock = (Number(partVal('hour')) % 24) * 60 + Number(partVal('minute'));

  let remindersSent = 0;
  let noShowsMarked = 0;

  // Today: 2-hour-before reminders + overdue auto no-show.
  const todayDocs = await db.collection(`hospitals/${slug}/appointments`)
    .where('date', '==', today).where('status', '==', 'booked').get();
  await Promise.all(todayDocs.docs.map(async (d) => {
    const a = d.data();
    const slotMin = slotMinutes(a.slotStart);
    if (slotMin === null) return;
    const minsUntil = slotMin - nowClock;

    // Overdue by >= 30 min and never checked in → no-show.
    if (minsUntil <= -30 && !a.tokenId) {
      await d.ref.update({ status: 'no-show', noShowAt: new Date() });
      await audit(null, slug, 'appointment:no-show', d.id, 'ok', { auto: true, slotStart: a.slotStart });
      noShowsMarked++;
      return;
    }
    // Within the next 2 hours → one reminder per visit (SMS/WhatsApp via
    // the outbox, plus an email when the patient left one).
    if (minsUntil > 0 && minsUntil <= 120 && !a.reminderSent2h && (a.phone || a.email)) {
      const cleanMail = String(a.email || '').trim();
      if (a.phone) {
        await notifyPatient(slug, hospital, a.phone,
          `Reminder: Your appointment at ${hospital.name || slug} is at ${a.slotStart}. Please be ready — you are next in line soon.`);
      }
      if (cleanMail) {
        await enqueueEmailNotify(slug, cleanMail,
          `Appointment reminder today — ${hospital.name || slug}`,
          `Hi ${a.patientName || 'there'},\n\nThis is a reminder that your appointment at ${hospital.name || slug} is TODAY at ${a.slotStart}.\nPlease be ready — you are next in line soon.\n\nRegards,\n${hospital.name || slug}`);
      }
      await d.ref.update({ reminderSent2h: new Date() });
      remindersSent++;
    }
  }));

  // Tomorrow: single day-before reminder (SMS/WhatsApp + email).
  const tomorrowDocs = await db.collection(`hospitals/${slug}/appointments`)
    .where('date', '==', tomorrow).where('status', '==', 'booked').get();
  await Promise.all(tomorrowDocs.docs.map(async (d) => {
    const a = d.data();
    const cleanMail = String(a.email || '').trim();
    if (a.reminderSent1d || !(a.phone || cleanMail)) return;
    if (a.phone) {
      await notifyPatient(slug, hospital, a.phone,
        `Reminder: Your appointment at ${hospital.name || slug} is tomorrow at ${a.slotStart}. Please arrive 10 minutes early.`);
    }
    if (cleanMail) {
      await enqueueEmailNotify(slug, cleanMail,
        `Your appointment tomorrow — ${hospital.name || slug}`,
        `Hi ${a.patientName || 'there'},\n\nThis is a reminder that your appointment at ${hospital.name || slug} is TOMORROW at ${a.slotStart}.\nPlease arrive 10 minutes early.\n\nRegards,\n${hospital.name || slug}`);
    }
    await d.ref.update({ reminderSent1d: new Date() });
    remindersSent++;
  }));

  return { remindersSent, noShowsMarked };
}

// Desk-triggered scan for the station's hospital (also used by the
// scheduled runner). Code-gated, no admin auth required.
exports.appointmentReminderScan = onCall({ rateLimiting: RL.reminderScan }, async (request) => {
  const { code } = request.data || {};
  if (!code) throw new HttpsError('invalid-argument', 'code required.');
  const slug = await slugForCode(code);
  if (!slug) throw new HttpsError('permission-denied', 'Invalid hospital code.');
  const hospital = await loadHospital(slug);
  const result = await runAppointmentSweep(slug, hospital);
  await audit(request.auth && request.auth.uid, slug, 'appointment:reminder-scan', null, 'ok', result);
  return { ok: true, ...result };
});

// Manual no-show mark for a single overdue booking (desk).
exports.markNoShow = onCall({ rateLimiting: RL.reminderScan }, async (request) => {
  const { code, appointmentId } = request.data || {};
  if (!code || !appointmentId) throw new HttpsError('invalid-argument', 'code + appointmentId required.');
  const slug = await slugForCode(code);
  if (!slug) throw new HttpsError('permission-denied', 'Invalid hospital code.');
  const aSnap = await db.doc(`hospitals/${slug}/appointments/${appointmentId}`).get();
  if (!aSnap.exists) throw new HttpsError('not-found', 'Appointment not found.');
  const a = aSnap.data();
  if (a.status !== 'booked') {
    throw new HttpsError('failed-precondition', 'Only booked appointments can be marked no-show.');
  }
  await db.doc(`hospitals/${slug}/appointments/${appointmentId}`).update({ status: 'no-show', noShowAt: new Date() });
  await audit(request.auth && request.auth.uid, slug, 'appointment:no-show', appointmentId, 'ok', { manual: true, slotStart: a.slotStart });
  return { ok: true };
});

// Patient feedback for a completed token (one submission per token).
// Public callable — callers only need the unguessable tokenId.
exports.submitFeedback = onCall({ rateLimiting: RL.feedback }, async (request) => {
  const { slug, tokenId, rating, comment } = request.data || {};
  if (!slug || !tokenId) throw new HttpsError('invalid-argument', 'slug + tokenId required.');
  const r = Math.floor(Number(rating));
  if (!(r >= 1 && r <= 5)) throw new HttpsError('invalid-argument', 'Rating must be an integer 1-5.');
  const cleanComment = String(comment || '').trim().slice(0, 300);

  const hospital = await loadHospital(slug);
  if (!hospital) throw new HttpsError('not-found', 'Hospital not found.');
  const tSnap = await db.doc(`hospitals/${slug}/tokens/${tokenId}`).get();
  if (!tSnap.exists) throw new HttpsError('not-found', 'Token not found.');
  const t = tSnap.data();
  if (normalizeStatus(t.status) !== 'completed') {
    throw new HttpsError('failed-precondition', 'Feedback is available after the consultation completes.');
  }
  const dup = await db.collection(`hospitals/${slug}/feedback`)
    .where('tokenId', '==', tokenId).get();
  if (!dup.empty) throw new HttpsError('already-exists', 'Feedback already submitted for this visit.');

  let doctorName = '';
  if (t.doctorId) {
    const dSnap = await db.doc(`hospitals/${slug}/doctors/${t.doctorId}`).get();
    if (dSnap.exists) doctorName = dSnap.data().name || '';
  }
  const fbId = db.collection(`hospitals/${slug}/feedback`).doc().id;
  await db.doc(`hospitals/${slug}/feedback/${fbId}`).set({
    id: fbId,
    tokenId,
    doctorId: t.doctorId || '',
    doctorName,
    date: t.date || todayInZone(getHospitalTz(hospital)),
    rating: r,
    comment: cleanComment,
    createdAt: new Date(),
  });
  await audit(request.auth && request.auth.uid, slug, 'feedback:submit', tokenId, 'ok', { rating: r });
  return { ok: true, feedbackId: fbId, doctorName };
});

// Desk/admin feed of today's feedback (code-gated, sanitized — no
// patient names/phones; feedback docs never carry them).
exports.listFeedback = onCall({ rateLimiting: RL.analytics }, async (request) => {
  const { code } = request.data || {};
  if (!code) throw new HttpsError('invalid-argument', 'code required.');
  const slug = await slugForCode(code);
  if (!slug) throw new HttpsError('permission-denied', 'Invalid hospital code.');
  const hospital = await loadHospital(slug);
  const date = todayInZone(getHospitalTz(hospital));
  const docs = await db.collection(`hospitals/${slug}/feedback`).where('date', '==', date).get();
  const rows = [];
  docs.forEach((d) => {
    const f = d.data();
    rows.push({
      id: d.id,
      doctorName: f.doctorName || '',
      rating: f.rating || 0,
      comment: f.comment || '',
      createdAt: f.createdAt ? f.createdAt.toMillis() : null,
    });
  });
  rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return { date, rows };
});

// Admin daily analytics roll-up: core counts, source split, hourly
// volume, per-doctor performance (waiting/served + avg serve + EWT
// accuracy + avg rating), and feedback summary. Server-computed so the
// admin page needs no direct token reads in functions mode.
exports.getAnalytics = onCall({ rateLimiting: RL.analytics }, async (request) => {
  const { slug } = request.data || {};
  const hospital = await assertAdmin(request, slug);
  const date = todayInZone(getHospitalTz(hospital));

  const tokDocs = await db.collection(`hospitals/${slug}/tokens`).where('date', '==', date).get();
  const counts = { total: 0, waiting: 0, called: 0, completed: 0, skipped: 0, canceled: 0 };
  const source = { appointment: 0, walkin: 0, self: 0, online: 0 };
  const hourly = Array(24).fill(0);
  const perDoctor = {};
  const servedAll = [];

  tokDocs.forEach((d) => {
    const t = d.data();
    counts.total++;
    const st = normalizeStatus(t.status);
    if (st === 'waiting') counts.waiting++;
    else if (st === 'called') counts.called++;
    else if (st === 'completed') counts.completed++;
    else if (st === 'skipped') counts.skipped++;
    else if (st === 'canceled') counts.canceled++;

    const src = String(t.source || 'walkin');
    if (source[src] !== undefined) source[src]++;
    else source.walkin++;

    if (t.createdAt && t.createdAt.toDate) {
      const h = t.createdAt.toDate().getHours();
      if (h >= 0 && h < 24) hourly[h]++;
    }

    const docId = String(t.doctorId || 'unassigned');
    perDoctor[docId] = perDoctor[docId] || { waiting: 0, called: 0, completed: 0, skipped: 0, canceled: 0, served: [], estErrSum: 0, estErrCount: 0 };
    const pd = perDoctor[docId];
    if (st === 'waiting') pd.waiting++;
    else if (st === 'called') pd.called++;
    else if (st === 'completed') pd.completed++;
    else if (st === 'skipped') pd.skipped++;
    else if (st === 'canceled') pd.canceled++;

    if (t.createdAt && t.calledAt && t.createdAt.toDate && t.calledAt.toDate &&
        (st === 'completed' || st === 'skipped')) {
      const actualMin = (t.calledAt.toDate().getTime() - t.createdAt.toDate().getTime()) / 60000;
      servedAll.push(actualMin);
      pd.served.push(actualMin);
      if (Number.isFinite(Number(t.estWaitMinutes))) {
        pd.estErrSum += Math.abs(Number(t.estWaitMinutes) - actualMin);
        pd.estErrCount++;
      }
    }
  });

  // Doctor names for the table.
  const docDocs = await db.collection(`hospitals/${slug}/doctors`).get();
  const names = {};
  docDocs.forEach((d) => { names[d.id] = d.data().name || d.id; });

  // Feedback roll-up per doctor + overall.
  const fbDocs = await db.collection(`hospitals/${slug}/feedback`).where('date', '==', date).get();
  const fbByDoctor = {};
  let fbCount = 0;
  let fbSum = 0;
  fbDocs.forEach((d) => {
    const f = d.data();
    const r = Number(f.rating) || 0;
    fbCount++;
    fbSum += r;
    const docId = String(f.doctorId || 'unassigned');
    fbByDoctor[docId] = fbByDoctor[docId] || { sum: 0, count: 0 };
    fbByDoctor[docId].sum += r;
    fbByDoctor[docId].count++;
  });

  const doctorRows = Object.keys(perDoctor).map((docId) => {
    const pd = perDoctor[docId];
    const avgServe = pd.served.length ? pd.served.reduce((a, b) => a + b, 0) / pd.served.length : null;
    const fb = fbByDoctor[docId];
    return {
      id: docId,
      name: names[docId] || docId,
      waiting: pd.waiting,
      called: pd.called,
      completed: pd.completed,
      skipped: pd.skipped,
      canceled: pd.canceled,
      served: pd.served.length,
      avgServeMinutes: avgServe === null ? null : Math.round(avgServe * 10) / 10,
      estErrorMinutes: pd.estErrCount ? Math.round((pd.estErrSum / pd.estErrCount) * 10) / 10 : null,
      avgRating: fb && fb.count ? Math.round((fb.sum / fb.count) * 10) / 10 : null,
    };
  });
  doctorRows.sort((a, b) => (b.waiting + b.called + b.completed) - (a.waiting + a.called + a.completed));

  const avgWaitAll = servedAll.length ? servedAll.reduce((a, b) => a + b, 0) / servedAll.length : null;
  const peakHour = hourly.reduce((best, v, i) => (v > hourly[best] ? i : best), 0);

  return {
    date,
    counts,
    source,
    hourly,
    peakHour: counts.total ? peakHour : null,
    avgWaitMinutes: avgWaitAll === null ? null : Math.round(avgWaitAll * 10) / 10,
    doctorRows,
    feedback: { count: fbCount, avgRating: fbCount ? Math.round((fbSum / fbCount) * 10) / 10 : null },
  };
});

// Queue handover: move every *waiting* token of one doctor to another
// for today (called/active tokens stay where they are). Desk code-gated.
exports.transferQueue = onCall({ rateLimiting: RL.handover }, async (request) => {
  const { code, fromDoctorId, toDoctorId } = request.data || {};
  if (!code || !fromDoctorId || !toDoctorId) throw new HttpsError('invalid-argument', 'code + fromDoctorId + toDoctorId required.');
  if (fromDoctorId === toDoctorId) throw new HttpsError('invalid-argument', 'Pick a different target doctor.');
  const slug = await slugForCode(code);
  if (!slug) throw new HttpsError('permission-denied', 'Invalid hospital code.');
  const hospital = await loadHospital(slug);
  const date = todayInZone(getHospitalTz(hospital));
  const docs = await db.collection(`hospitals/${slug}/tokens`)
    .where('doctorId', '==', fromDoctorId).where('date', '==', date).get();
  let moved = 0;
  await Promise.all(docs.docs.map(async (d) => {
    const t = d.data();
    if (normalizeStatus(t.status) !== 'waiting') return;
    await d.ref.update({ doctorId: toDoctorId, transferredAt: new Date(), transferredFrom: fromDoctorId });
    moved++;
  }));
  await audit(request.auth && request.auth.uid, slug, 'queue:transfer', fromDoctorId, 'ok', { toDoctorId, moved });
  return { moved };
});

// ------------------------------------------------------------------
//  listAuditEvents — admin-only accountability feed
// ------------------------------------------------------------------
exports.listAuditEvents = onCall({ rateLimiting: RL.audit }, async (request) => {
  const { slug, limit } = request.data || {};
  await assertAdmin(request, slug);
  const max = Math.min(Number(limit) || 50, 100);
  const docs = await db.collection('auditLog')
    .where('slug', '==', slug).orderBy('at', 'desc').limit(max).get();
  const rows = [];
  docs.forEach((d) => {
    const e = d.data();
    rows.push({
      id: d.id,
      action: e.action,
      targetId: e.targetId || null,
      outcome: e.outcome || 'ok',
      actorUid: e.actorUid || null,
      detail: e.detail || {},
      at: e.at ? e.at.toMillis() : null,
    });
  });
  return { rows };
});

// ------------------------------------------------------------------
//  getMyDoctorProfile — self-service profile for the signed-in doctor.
//  Used by doctor-login.html / doctor.html in functions mode so no
//  client-side doctor subcollection reads are needed.
// ------------------------------------------------------------------
exports.getMyDoctorProfile = onCall({ rateLimiting: RL.myProfile }, async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');
  const slug = String(request.data && request.data.slug || '');
  if (!slug) throw new HttpsError('invalid-argument', 'slug required.');
  const hospital = await loadHospital(slug);
  if (!hospital) throw new HttpsError('not-found', 'Hospital not found.');

  const docs = await db.collection(`hospitals/${slug}/doctors`)
    .where('authUid', '==', uid).limit(1).get();
  if (docs.size !== 1) throw new HttpsError('permission-denied', 'No doctor profile is linked to this account.');
  const d = docs.docs[0].data();
  if (d.status === 'inactive' || d.status === 'revoked') {
    throw new HttpsError('permission-denied', 'This doctor account is deactivated.');
  }
  return {
    id: docs.docs[0].id,
    name: d.name || '',
    department: d.department || '',
    room: d.room || d.counter || d.department || 'Consultation Room',
    dailyLimit: d.dailyLimit ? Number(d.dailyLimit) : 0,
    hospitalSlug: slug,
    hospitalName: hospital.name || slug,
    hospitalCode: hospital.hospitalCode || '',
  };
});

// ------------------------------------------------------------------
//  registerPushToken — patient device token under the hospital
// ------------------------------------------------------------------
exports.registerPushToken = onCall({ rateLimiting: RL.pushToken }, async (request) => {
  const { slug, token, tokenId } = request.data || {};
  if (!slug || !token || token.length < 20) throw new HttpsError('invalid-argument', 'slug + token required.');
  if (!tokenId) throw new HttpsError('invalid-argument', 'tokenId required.');
  const uid = request.auth && request.auth.uid;

  // The device is bound to ONE queue token, not to the hospital. Sending
  // to every device registered at the hospital would buzz every patient's
  // phone whenever any patient's number was called, and would disclose one
  // patient's token number to all the others.
  await db.doc(`hospitals/${slug}/pushTokens/${token}`).set({
    uid: uid || 'anonymous',
    // Which queue token this device is watching. tokenCalledNotify
    // filters on it, so a device only ever hears about its own token.
    tokenId: String(tokenId),
    registeredAt: new Date(),
    ua: (request.headers && request.headers['user-agent']) || null,
  }, { merge: true });
  return { ok: true };
});

// ------------------------------------------------------------------
//  provisionDoctor / revokeDoctor — no PINs, ever
// ------------------------------------------------------------------
exports.provisionDoctor = onCall({ rateLimiting: RL.provision }, async (request) => {
  const { slug, doctorId, email, name, department, room, dailyLimit } = request.data || {};
  await assertAdmin(request, slug);
  if (!email || !doctorId) throw new HttpsError('invalid-argument', 'email + doctorId required.');

  let limitValue = 0;
  if (dailyLimit !== undefined && dailyLimit !== null && dailyLimit !== '') {
    limitValue = Math.floor(Number(dailyLimit));
    if (!Number.isFinite(limitValue) || limitValue < 0 || limitValue > 999) {
      throw new HttpsError('invalid-argument', 'dailyLimit must be a whole number 0-999 (0 = unlimited).');
    }
  }

  let user;
  try {
    user = await auth.createUser({ email, displayName: name || doctorId, emailVerified: true });
    await auth.setCustomUserClaims(user.uid, { role: 'doctor', hospitalSlug: slug });
  } catch (err) {
    throw new HttpsError('already-exists', `Auth provisioning failed: ${err.message}`);
  }

  await db.doc(`hospitals/${slug}/doctors/${doctorId}`).set({
    authUid: user.uid, email, name: name || doctorId, department: department || '',
    room: room || '', status: 'active', hospitalSlug: slug, dailyLimit: limitValue,
    updatedAt: new Date(),
  }, { merge: true });

  await audit(request.auth.uid, slug, 'doctor:provision', doctorId, 'ok', { authUid: user.uid });
  return { authUid: user.uid };
});

exports.revokeDoctor = onCall({ rateLimiting: RL.provision }, async (request) => {
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
//  flushSmsOutbox — admin-triggered processing of pending SMS rows.
//  Plug a provider adapter (Twilio / Msg91 / Troop / WhatsApp) into
//  the loop below; until then rows are marked sent with a console log.
// ------------------------------------------------------------------
exports.flushSmsOutbox = onCall({ rateLimiting: RL.smsFlush }, async (request) => {
  const { slug } = request.data || {};
  await assertAdmin(request, slug);
  const pending = await db.collection('sms_queue')
    .where('slug', '==', slug).where('status', '==', 'pending').limit(30).get();
  const smsRows = pending.docs.filter((d) => (d.data().channel || 'sms') === 'sms').slice(0, 20);
  let sent = 0;
  // NOTE: provider adapter goes here (validate/format phone, call API,
  // record provider message id). The console stub keeps the pipeline
  // testable end-to-end without external credentials.
  smsRows.forEach((d) => {
    const row = d.data();
    console.log('[sms-outbox:stub] would send', row.phone, '=>', row.body);
  });
  await Promise.all(smsRows.map((d) =>
    d.ref.update({ status: 'sent', provider: 'console-stub', sentAt: new Date(), attempts: (d.data().attempts || 0) + 1 })));
  sent = smsRows.length;
  await audit(request.auth.uid, slug, 'sms:flush', null, 'ok', { sent });
  return { sent };
});

// ------------------------------------------------------------------
//  flushWhatsAppOutbox — admin-triggered processing of pending
//  WhatsApp rows (channel === 'whatsapp'). Plug a Meta Cloud API /
//  Twilio WhatsApp adapter into the loop below; until then rows are
//  marked sent with a console log. Hospital enables the channel via
//  `notifyChannels: ['sms','whatsapp']`.
// ------------------------------------------------------------------
exports.flushWhatsAppOutbox = onCall({ rateLimiting: RL.smsFlush }, async (request) => {
  const { slug } = request.data || {};
  await assertAdmin(request, slug);
  const pending = await db.collection('sms_queue')
    .where('slug', '==', slug).where('status', '==', 'pending').where('channel', '==', 'whatsapp').limit(20).get();
  let sent = 0;
  // NOTE: Meta Cloud API adapter goes here (to: 91XXXXXXXXXX, template:
  // token number + hospital + room). Console stub keeps it testable.
  pending.forEach((d) => {
    const row = d.data();
    console.log('[whatsapp-outbox:stub] would send', row.phone, '=>', row.body);
  });
  await Promise.all(pending.docs.map((d) =>
    d.ref.update({ status: 'sent', provider: 'whatsapp-console-stub', sentAt: new Date(), attempts: (d.data().attempts || 0) + 1 })));
  sent = pending.size;
  await audit(request.auth.uid, slug, 'whatsapp:flush', null, 'ok', { sent });
  return { sent };
});

// ------------------------------------------------------------------
//  flushEmailOutbox — admin-triggered processing of pending email
//  reminder rows (channel 'email'). Plug a provider adapter (Resend /
//  SendGrid / SES) into the loop below; until then rows are marked
//  sent with a console log so the pipeline stays testable end-to-end.
// ------------------------------------------------------------------
exports.flushEmailOutbox = onCall({ rateLimiting: RL.smsFlush }, async (request) => {
  const { slug } = request.data || {};
  await assertAdmin(request, slug);
  const pending = await db.collection('email_queue')
    .where('slug', '==', slug).where('status', '==', 'pending').limit(30).get();
  let sent = 0;
  // NOTE: email provider adapter goes here (Resend/SendGrid/SES send,
  // record provider message id). The console stub keeps it testable.
  pending.forEach((d) => {
    const row = d.data();
    console.log('[email-outbox:stub] would send to', row.to, '=>', row.subject);
  });
  await Promise.all(pending.docs.map((d) =>
    d.ref.update({ status: 'sent', provider: 'email-console-stub', sentAt: new Date(), attempts: (d.data().attempts || 0) + 1 })));
  sent = pending.size;
  await audit(request.auth.uid, slug, 'email:flush', null, 'ok', { sent });
  return { sent };
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
    const tokenId = event.params.tokenId;

    // ONLY the devices watching this exact queue token. Devices
    // registered before the tokenId field existed, or for a different
    // token, are deliberately skipped rather than sent a message about
    // someone else's number.
    const snap = await db.collection(`hospitals/${slug}/pushTokens`).get();
    const targets = [];
    snap.forEach((d) => {
      const rec = d.data() || {};
      if (String(rec.tokenId || '') === String(tokenId)) targets.push(d.id);
    });

    if (!targets.length) {
      console.log('push: no devices subscribed to token', tokenId);
      return;
    }

    const message = {
      notification: {
        title: 'Your turn!',
        body: `Token #${after.number} is now called at ${after.counter || 'Counter A'}.`,
      },
      data: { slug, tokenId, number: String(after.number || '') },
      tokens: targets,
    };
    const res = await getMessaging().sendEachForMulticast(message);

    // Drop devices FCM reports as unregistered so a reinstalled browser
    // does not keep accumulating dead tokens.
    const dead = [];
    res.responses.forEach((r, i) => {
      const code = r.error && r.error.code;
      if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
        dead.push(targets[i]);
      }
    });
    await Promise.all(dead.map((t) => db.doc(`hospitals/${slug}/pushTokens/${t}`).delete().catch(() => {})));
    console.log('push results', res.successCount, res.failureCount, 'pruned', dead.length);
  }
);

// ------------------------------------------------------------------
//  appointmentReminderRunner — scheduled sweep every 30 minutes across
//  every hospital. Sends day-before + 2-hour-before appointment
//  reminders (via the SMS/WhatsApp outbox) and auto-marks overdue
//  un-checked-in bookings as no-show. Idempotent flags prevent repeats.
// ------------------------------------------------------------------
exports.appointmentReminderRunner = onSchedule({ schedule: 'every 30 minutes', timeZone: DEFAULT_TZ }, async () => {
  const hospitals = await db.collection('hospitals').get();
  let remindersSent = 0;
  let noShowsMarked = 0;
  await Promise.all(hospitals.docs.map(async (h) => {
    try {
      const r = await runAppointmentSweep(h.id, h.data());
      remindersSent += r.remindersSent;
      noShowsMarked += r.noShowsMarked;
    } catch (e) {
      console.error('reminder sweep failed', h.id, e.message);
    }
  }));
  console.log('appointment reminder sweep complete', JSON.stringify({ remindersSent, noShowsMarked }));
});

// ------------------------------------------------------------------
//  retentionRunner — daily data-minimization job. Tokens older than
//  RETENTION_TOKEN_DAYS, audit log older than RETENTION_AUDIT_DAYS and
//  SMS rows older than RETENTION_SMS_DAYS are deleted in batches.
//  Run at 04:30 IST (clinic idle window).
// ------------------------------------------------------------------
const RETENTION_TOKEN_DAYS = 90;
const RETENTION_AUDIT_DAYS = 365;
const RETENTION_SMS_DAYS = 30;
const RETENTION_FEEDBACK_DAYS = 365;

async function deleteWhereOlderThan(refGetter, field, cutoff, limit) {
  let total = 0;
  for (let pass = 0; pass < 50; pass++) {
    const docs = await refGetter().where(field, '<', cutoff).limit(limit).get();
    if (docs.size === 0) break;
    const batch = db.batch();
    docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    total += docs.size;
    if (docs.size < limit) break;
  }
  return total;
}

exports.retentionRunner = onSchedule({ schedule: '30 4 * * *', timeZone: 'Asia/Kolkata' }, async () => {
  const t = Date.now();
  const results = {};

  results.tokens = await deleteWhereOlderThan(
    () => db.collectionGroup('tokens'), 'date', daysAgoIso(RETENTION_TOKEN_DAYS, t), 400);
  results.audit = await deleteWhereOlderThan(
    () => db.collection('auditLog'), 'at', new Date(t - RETENTION_AUDIT_DAYS * 864e5), 400);
  results.sms = await deleteWhereOlderThan(
    () => db.collection('sms_queue'), 'createdAt', new Date(t - RETENTION_SMS_DAYS * 864e5), 400);
  results.email = await deleteWhereOlderThan(
    () => db.collection('email_queue'), 'createdAt', new Date(t - RETENTION_SMS_DAYS * 864e5), 400);
  // Feedback rows are date-keyed strings, so purge by the date field.
  results.feedback = await deleteWhereOlderThan(
    () => db.collectionGroup('feedback'), 'date', daysAgoIso(RETENTION_FEEDBACK_DAYS, t), 400);

  console.log('retention run complete', JSON.stringify(results));
});