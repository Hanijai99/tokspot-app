/**
 * ============================================================
 *  TokSpot API adapter — one switch between prototype mode
 *  (direct Firestore client writes, current behaviour) and the
 *  trusted Functions backend (server-enforced rules).
 * ============================================================
 *  mode selection:
 *    default  -> 'prototype' : exact behaviour the pages use today
 *    window.TOKSPOT_API_MODE = 'functions' : calls the deployed
 *               callables (issueToken, transitionToken, cancelToken,
 *               getTokenStatus, getDoctorQueue, getTvFeed) via the
 *               Firebase Functions SDK.
 *
 *  Flip the flag at pilot time — every write path on book.html,
 *  frontdesk.html and doctor.html moves to the server API at once.
 *
 *  This file is intentionally free of DOM/UI code so it can run in
 *  Node for tests (see tests/api-adapter.test.cjs).
 * ============================================================
 */
(function (root, factory) {
  const api = factory(typeof window !== 'undefined' ? window : root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.TokSpotAPI = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (win) {

  const FUNCTIONS_CDN = 'https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js';

  function apiMode() {
    return win.TOKSPOT_API_MODE === 'functions' ? 'functions' : 'prototype';
  }

  function todayStr() {
    if (win.todayStr) return win.todayStr();
    return new Date().toISOString().slice(0, 10);
  }

  function pad3(n) {
    return (win.pad3 || ((v) => String(v).padStart(3, '0')))(n);
  }

  function newTokenId() {
    // Never derive the tracking URL from date + doctor + counter, which
    // would let anyone enumerate patients' live pass pages for the day.
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }

  function ensureAuth() {
    if (!win._auth || !win._useAuth) return Promise.resolve();
    if (win._auth.currentUser) return Promise.resolve();
    return win._useAuth.signInAnonymously(win._auth).catch(() => {});
  }

  function requireFs() {
    if (!win._fs || !win._db) throw new Error('Firestore not initialised yet.');
  }

  // ---- Functions (secure) mode -------------------------------------

  async function callFunction(name, data) {
    const { getFunctions, httpsCallable } = await import(FUNCTIONS_CDN);
    if (!win._app) throw new Error('Firebase app not initialised yet.');
    const fn = httpsCallable(getFunctions(win._app), name);
    const res = await fn(data);
    return res.data;
  }

  // ---- issueToken ---------------------------------------------------

  function generateIdempotencyKey() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }

  /**
   * @param {object} opts { slug, doctorId, doctorName, name, phone,
   *   priority, counter, source, extra, idempotencyKey } — extra
   *   fields are merged into the token document (prototype mode only).
   * @returns {Promise<{tokenId: string, tokenNum: string, reused?: boolean}>}
   */
  async function issueToken(opts) {
    const { slug, doctorId, doctorName, name, phone, priority, counter, source, extra, idempotencyKey } = opts || {};
    if (!slug || !doctorId || !name) {
      throw new Error('Hospital, doctor and patient name are required.');
    }
    if (apiMode() === 'functions') {
      const res = await callFunction('issueToken', {
        slug, doctorId, name,
        phone: String(phone || '').replace(/\D/g, '').slice(-10),
        priority: Boolean(priority), counter: counter || 'Counter A',
        source: source || 'desk',
        idempotencyKey: idempotencyKey || generateIdempotencyKey(),
      });
      return { tokenId: res.tokenId, tokenNum: res.number, reused: Boolean(res.reused) };
    }

    // prototype mode — identical semantics to the inline page transactions
    await ensureAuth();
    requireFs();
    const date = todayStr();
    const counterRef = win._fs.doc(win._db, 'hospitals', slug, 'counters', date);
    let tokenId = '';
    let tokenNum = '';
    await win._fs.runTransaction(win._db, async (transaction) => {
      // Doctor's daily token limit (0/unset = unlimited) — mirrors the
      // server-side check so prototype mode behaves identically.
      const doctorSnap = await transaction.get(win._fs.doc(win._db, 'hospitals', slug, 'doctors', doctorId));
      const dailyLimit = doctorSnap.exists() ? Number(doctorSnap.data().dailyLimit || 0) : 0;
      if (dailyLimit > 0) {
        const daySnap = await transaction.get(win._fs.query(
          win._fs.collection(win._db, 'hospitals', slug, 'tokens'),
          win._fs.where('doctorId', '==', doctorId),
          win._fs.where('date', '==', date)
        ));
        let issuedToday = 0;
        daySnap.docs.forEach((dd) => {
          const s = String(dd.data().status || '').toLowerCase();
          if (s !== 'canceled') issuedToday++;
        });
        if (issuedToday >= dailyLimit) {
          throw new Error('This doctor\'s daily token limit of ' + dailyLimit + ' has been reached. Please try again tomorrow.');
        }
      }

      const counterDoc = await transaction.get(counterRef);
      const nextCount = win.TokspotQueue.nextTokenNumber(
        counterDoc.exists() ? (counterDoc.data().count || 0) : 0
      );
      if (counterDoc.exists()) transaction.update(counterRef, { count: nextCount });
      else transaction.set(counterRef, { count: nextCount });

      tokenNum = pad3(nextCount);
      tokenId = newTokenId();
      transaction.set(win._fs.doc(win._db, 'hospitals', slug, 'tokens', tokenId), {
        id: tokenId,
        number: tokenNum,
        patientName: String(name).trim(),
        phone: String(phone || '').replace(/\D/g, '').slice(-10),
        doctorId,
        doctorName: doctorName || '',
        hospitalId: slug,
        date,
        department: 'consultation',
        status: 'waiting',
        source: source || (extra && extra.bookedFrom ? 'self' : 'desk'),
        createdAt: win._fs.serverTimestamp(),
        priority: Boolean(priority),
        counter: counter || 'Counter A',
        ...(extra || {}),
      });
    });
    return { tokenId, tokenNum };
  }

  // ---- transition ---------------------------------------------------

  /**
   * @param {object} opts { slug, tokenId, nextStatus, changes }
   * @returns {Promise<object>} { previousStatus, nextStatus }
   */
  async function transition(opts) {
    const { slug, tokenId, nextStatus, changes } = opts || {};
    if (!slug || !tokenId || !nextStatus) {
      throw new Error('slug, tokenId and nextStatus are required.');
    }
    if (apiMode() === 'functions') {
      await ensureAuth();
      const res = await callFunction('transitionToken', { slug, tokenId, nextStatus, changes });
      return { previousStatus: res.from, nextStatus: res.nextStatus };
    }
    await ensureAuth();
    requireFs();
    return win.TokspotQueue.transitionToken(win._fs, win._db, slug, tokenId, nextStatus, changes);
  }

  // ---- cancelToken (patient self-cancel, verified by phone) ---------

  async function cancelToken(opts) {
    const { slug, tokenId, phone } = opts || {};
    if (!slug || !tokenId) throw new Error('slug and tokenId are required.');
    if (apiMode() === 'functions') {
      return callFunction('cancelToken', { slug, tokenId, phone: String(phone || '') });
    }
    requireFs();
    const snap = await win._fs.getDoc(win._fs.doc(win._db, 'hospitals', slug, 'tokens', tokenId));
    if (!snap.exists()) throw new Error('Token not found.');
    const t = snap.data();
    if (String(t.phone || '') !== String(phone || '').replace(/\D/g, '').slice(-10)) {
      throw new Error('Phone number does not match this token.');
    }
    if (!win.TokspotQueue.canTransition(t.status, 'canceled')) {
      throw new Error(`Token with status ${t.status} can no longer be canceled.`);
    }
    await win._fs.updateDoc(win._fs.doc(win._db, 'hospitals', slug, 'tokens', tokenId), {
      status: 'canceled',
      canceledAt: win._fs.serverTimestamp(),
      updatedAt: win._fs.serverTimestamp(),
    });
    return { ok: true };
  }

  // ---- Read paths ----------------------------------------------------
  // track.html / token.html / display.html still use Firestore
  // snapshots in prototype mode. In functions mode they must switch to
  // the sanitized callables below (TV/boarding stays PII-free).

  function readNeedsFunctions(name) {
    throw new Error(
      `${name} requires functions mode (window.TOKSPOT_API_MODE='functions'). ` +
      'In prototype mode the read paths use Firestore snapshots directly.'
    );
  }

  async function getTokenStatus(opts) {
    const { slug, tokenId } = opts || {};
    if (!slug || !tokenId) throw new Error('slug + tokenId required.');
    if (apiMode() !== 'functions') return readNeedsFunctions('getTokenStatus');
    return callFunction('getTokenStatus', { slug, tokenId });
  }

  async function getDoctorQueue(opts) {
    const { slug, doctorId } = opts || {};
    if (!slug || !doctorId) throw new Error('slug + doctorId required.');
    if (apiMode() !== 'functions') return readNeedsFunctions('getDoctorQueue');
    return callFunction('getDoctorQueue', { slug, doctorId });
  }

  // Front-desk staff feed — hospital-code gated, no doctor auth needed.
  async function getDeskQueue(opts) {
    const { code, doctorId } = opts || {};
    if (!code || !doctorId) throw new Error('code + doctorId required.');
    if (apiMode() !== 'functions') return readNeedsFunctions('getDeskQueue');
    return callFunction('getDeskQueue', { code, doctorId });
  }

  async function getTvFeed(opts) {
    const { slug } = opts || {};
    if (!slug) throw new Error('slug required.');
    if (apiMode() !== 'functions') return readNeedsFunctions('getTvFeed');
    return callFunction('getTvFeed', { slug });
  }

  // Public token lookup scoped to one hospital code (no cross-tenant scan).
  async function getTokenByNumber(opts) {
    const { code, number } = opts || {};
    if (!code || !number) throw new Error('code + number required.');
    if (apiMode() !== 'functions') return readNeedsFunctions('getTokenByNumber');
    return callFunction('getTokenByNumber', { code, number });
  }

  // Public hospital code → slug lookup (TV + doctor login).
  async function resolveHospitalByCode(opts) {
    const { code } = opts || {};
    if (!code) throw new Error('code required.');
    if (apiMode() !== 'functions') return readNeedsFunctions('resolveHospitalByCode');
    return callFunction('resolveHospitalByCode', { code });
  }

  // Sanitized doctor options for the booking form / front desk.
  async function listDoctorsPublic(opts) {
    const { slug } = opts || {};
    if (!slug) throw new Error('slug required.');
    if (apiMode() !== 'functions') return readNeedsFunctions('listDoctorsPublic');
    return callFunction('listDoctorsPublic', { slug });
  }

  // Doctor/admin break toggle — reflects on the TV board + desk feeds.
  async function setDoctorBreak(opts) {
    const { slug, doctorId, onBreak, breakNote } = opts || {};
    if (!slug || !doctorId) throw new Error('slug + doctorId required.');
    if (apiMode() !== 'functions') return readNeedsFunctions('setDoctorBreak');
    return callFunction('setDoctorBreak', { slug, doctorId, onBreak: Boolean(onBreak), breakNote: breakNote || '' });
  }

  // Advance appointments (functions mode).
  async function listAvailableSlots(opts) {
    const { slug, doctorId, date } = opts || {};
    if (!slug || !doctorId || !date) throw new Error('slug + doctorId + date required.');
    if (apiMode() !== 'functions') return readNeedsFunctions('listAvailableSlots');
    return callFunction('listAvailableSlots', { slug, doctorId, date });
  }

  async function createAppointment(opts) {
    const { slug, doctorId, date, slotStart, name, phone, email } = opts || {};
    if (!slug || !doctorId || !date || !slotStart) throw new Error('slug + doctorId + date + slotStart required.');
    if (apiMode() !== 'functions') return readNeedsFunctions('createAppointment');
    return callFunction('createAppointment', { slug, doctorId, date, slotStart, name, phone, email });
  }

  // Doctor self-service or admin: cap how many tokens the doctor accepts
  // per day (0 = unlimited). Works in both modes; every change is audited
  // server-side in functions mode.
  async function setDoctorDailyLimit(opts) {
    const { slug, doctorId, dailyLimit } = opts || {};
    if (!slug || !doctorId) throw new Error('Hospital and doctor are required.');
    const n = Math.floor(Number(dailyLimit));
    if (!Number.isFinite(n) || n < 0 || n > 999) {
      throw new Error('Daily limit must be a whole number 0-999 (0 = unlimited).');
    }
    if (apiMode() === 'functions') {
      const res = await callFunction('setDoctorDailyLimit', { slug, doctorId, dailyLimit: n });
      return { ok: Boolean(res.ok), dailyLimit: res.dailyLimit };
    }
    await ensureAuth();
    requireFs();
    await win._fs.updateDoc(
      win._fs.doc(win._db, 'hospitals', slug, 'doctors', doctorId),
      {
        dailyLimit: n,
        dailyLimitUpdatedAt: win._fs.serverTimestamp ? win._fs.serverTimestamp() : new Date().toISOString(),
      }
    );
    return { ok: true, dailyLimit: n };
  }

  async function listTodayAppointments(opts) {
    const { code, doctorId } = opts || {};
    if (!code || !doctorId) throw new Error('code + doctorId required.');
    if (apiMode() !== 'functions') return readNeedsFunctions('listTodayAppointments');
    return callFunction('listTodayAppointments', { code, doctorId });
  }

  async function checkInAppointment(opts) {
    const { code, appointmentId } = opts || {};
    if (!code || !appointmentId) throw new Error('code + appointmentId required.');
    if (apiMode() !== 'functions') return readNeedsFunctions('checkInAppointment');
    return callFunction('checkInAppointment', { code, appointmentId });
  }

  // Admin accountability feed.
  async function listAuditEvents(opts) {
    const { slug, limit } = opts || {};
    if (!slug) throw new Error('slug required.');
    if (apiMode() !== 'functions') return readNeedsFunctions('listAuditEvents');
    return callFunction('listAuditEvents', { slug, limit: Number(limit) || 50 });
  }

  // Self-service doctor profile (functions mode — no client doc reads).
  async function getMyDoctorProfile(opts) {
    const { slug } = opts || {};
    if (!slug) throw new Error('slug required.');
    if (apiMode() !== 'functions') return readNeedsFunctions('getMyDoctorProfile');
    return callFunction('getMyDoctorProfile', { slug });
  }

  // Admin — provision/revoke Auth-backed doctor accounts.
  async function provisionDoctor(opts) {
    const { slug, doctorId, email, name, department, room, dailyLimit } = opts || {};
    if (!slug || !doctorId || !email) throw new Error('slug, doctorId and email required.');
    if (apiMode() !== 'functions') return readNeedsFunctions('provisionDoctor');
    return callFunction('provisionDoctor', { slug, doctorId, email, name, department, room, dailyLimit });
  }

  async function revokeDoctor(opts) {
    const { slug, doctorId } = opts || {};
    if (!slug || !doctorId) throw new Error('slug + doctorId required.');
    if (apiMode() !== 'functions') return readNeedsFunctions('revokeDoctor');
    return callFunction('revokeDoctor', { slug, doctorId });
  }

  // Admin — drain the pending SMS outbox through the provider adapter.
  async function flushSmsOutbox(opts) {
    const { slug } = opts || {};
    if (!slug) throw new Error('slug required.');
    if (apiMode() !== 'functions') return readNeedsFunctions('flushSmsOutbox');
    return callFunction('flushSmsOutbox', { slug });
  }

  // Admin — drain the pending WhatsApp outbox (channel === 'whatsapp').
  async function flushWhatsAppOutbox(opts) {
    const { slug } = opts || {};
    if (!slug) throw new Error('slug required.');
    if (apiMode() !== 'functions') return readNeedsFunctions('flushWhatsAppOutbox');
    return callFunction('flushWhatsAppOutbox', { slug });
  }

  // Admin — drain the pending email outbox (appointment reminders).
  async function flushEmailOutbox(opts) {
    const { slug } = opts || {};
    if (!slug) throw new Error('slug required.');
    if (apiMode() !== 'functions') return readNeedsFunctions('flushEmailOutbox');
    return callFunction('flushEmailOutbox', { slug });
  }

  // Desk — run the reminder + no-show sweep for the station's hospital.
  async function appointmentReminderScan(opts) {
    const { code } = opts || {};
    if (!code) throw new Error('code required.');
    if (apiMode() !== 'functions') return readNeedsFunctions('appointmentReminderScan');
    return callFunction('appointmentReminderScan', { code });
  }

  // Desk — manually mark a single overdue booking as no-show.
  async function markNoShow(opts) {
    const { code, appointmentId } = opts || {};
    if (!code || !appointmentId) throw new Error('code + appointmentId required.');
    if (apiMode() !== 'functions') return readNeedsFunctions('markNoShow');
    return callFunction('markNoShow', { code, appointmentId });
  }

  // Patient — submit feedback for a completed token. Works in both
  // modes: prototype writes the feedback doc client-side (mirroring the
  // server doc shape), functions mode uses the callable.
  async function submitFeedback(opts) {
    const { slug, tokenId, rating, comment } = opts || {};
    if (!slug || !tokenId || !rating) throw new Error('slug + tokenId + rating required.');
    if (apiMode() === 'functions') {
      return callFunction('submitFeedback', {
        slug, tokenId, rating: Math.floor(Number(rating)), comment: String(comment || '').trim().slice(0, 300),
      });
    }
    await ensureAuth();
    requireFs();
    let tokenData = null;
    try {
      const snap = await win._fs.getDoc(win._fs.doc(win._db, 'hospitals', slug, 'tokens', tokenId));
      if (snap.exists()) tokenData = snap.data();
    } catch (_) { tokenData = null; }
    if (!tokenData) throw new Error('Token not found.');
    if (win.TokspotQueue && win.TokspotQueue.normalizeStatus) {
      if (win.TokspotQueue.normalizeStatus(tokenData.status) !== 'completed') {
        throw new Error('Feedback is available after the consultation completes.');
      }
    }
    const dup = await win._fs.getDocs(win._fs.query(
      win._fs.collection(win._db, 'hospitals', slug, 'feedback'),
      win._fs.where('tokenId', '==', tokenId)
    ));
    if (!dup.empty) throw new Error('Feedback already submitted for this visit.');
    const fbId = win._fs.collection(win._db, 'hospitals', slug, 'feedback').doc().id;
    await win._fs.setDoc(win._fs.doc(win._db, 'hospitals', slug, 'feedback', fbId), {
      id: fbId,
      tokenId,
      doctorId: tokenData.doctorId || '',
      doctorName: tokenData.doctorName || '',
      date: tokenData.date || todayStr(),
      rating: Math.floor(Number(rating)),
      comment: String(comment || '').trim().slice(0, 300),
      createdAt: win._fs.serverTimestamp ? win._fs.serverTimestamp() : new Date(),
    });
    return { ok: true, feedbackId: fbId, doctorName: tokenData.doctorName || '' };
  }

  // Desk — today's feedback rows (sanitized, functions mode).
  async function listFeedback(opts) {
    const { code } = opts || {};
    if (!code) throw new Error('code required.');
    if (apiMode() !== 'functions') return readNeedsFunctions('listFeedback');
    return callFunction('listFeedback', { code });
  }

  // Admin — daily analytics roll-up (functions mode only; prototype
  // analytics.html computes equivalent stats client-side).
  async function getAnalytics(opts) {
    const { slug } = opts || {};
    if (!slug) throw new Error('slug required.');
    if (apiMode() !== 'functions') return readNeedsFunctions('getAnalytics');
    return callFunction('getAnalytics', { slug });
  }

  // Desk — move waiting tokens from one doctor to another (handover).
  async function transferQueue(opts) {
    const { code, fromDoctorId, toDoctorId } = opts || {};
    if (!code || !fromDoctorId || !toDoctorId) throw new Error('code + fromDoctorId + toDoctorId required.');
    if (apiMode() !== 'functions') return readNeedsFunctions('transferQueue');
    return callFunction('transferQueue', { code, fromDoctorId, toDoctorId });
  }

  return {
    mode: apiMode,
    newTokenId,
    generateIdempotencyKey,
    issueToken,
    transition,
    cancelToken,
    getTokenStatus,
    getDoctorQueue,
    getDeskQueue,
    setDoctorBreak,
    listAvailableSlots,
    createAppointment,
    listTodayAppointments,
    checkInAppointment,
    getTvFeed,
    getTokenByNumber,
    resolveHospitalByCode,
    listDoctorsPublic,
    setDoctorDailyLimit,
    flushEmailOutbox,
    listAuditEvents,
    getMyDoctorProfile,
    provisionDoctor,
    revokeDoctor,
    flushSmsOutbox,
    flushWhatsAppOutbox,
    appointmentReminderScan,
    markNoShow,
    submitFeedback,
    listFeedback,
    getAnalytics,
    transferQueue,
  };
});