(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.TokspotQueue = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const ALLOWED_TRANSITIONS = {
    waiting: ['called', 'canceled'],
    called: ['completed', 'skipped'],
    skipped: ['waiting', 'canceled'],
    completed: [],
    canceled: []
  };

  // Legacy records created before the status model was finalized can carry
  // `status === 'serving'`. Treat it as `called` so old rows validate against
  // the same transition matrix, honour the active-token lock, and are not
  // silently stuck in a state the state machine does not know about.
  function normalizeStatus(status) {
    return status === 'serving' ? 'called' : status;
  }

  function canTransition(fromStatus, toStatus) {
    return Boolean(ALLOWED_TRANSITIONS[normalizeStatus(fromStatus)]?.includes(toStatus));
  }

  function nextTokenNumber(currentCount) {
    const count = Number(currentCount);
    if (!Number.isSafeInteger(count) || count < 0 || count >= Number.MAX_SAFE_INTEGER) {
      throw new Error('Invalid token counter value.');
    }
    return count + 1;
  }

  function timestampMillis(value) {
    if (value && typeof value.toMillis === 'function') return value.toMillis();
    if (value instanceof Date) return value.getTime();
    return Number.isFinite(value) ? value : null;
  }

  function averageWaitMinutes(tokens) {
    const waits = tokens.map((token) => {
      const created = timestampMillis(token.createdAt);
      const called = timestampMillis(token.calledAt);
      return created !== null && called !== null && called >= created
        ? (called - created) / 60000
        : null;
    }).filter((minutes) => minutes !== null);

    if (!waits.length) return null;
    return Math.round(waits.reduce((total, minutes) => total + minutes, 0) / waits.length);
  }

  function isHospitalAdmin(user, hospital) {
    return Boolean(user && hospital && hospital.adminUid && user.uid === hospital.adminUid);
  }

  async function transitionToken(fs, db, hospitalSlug, tokenId, nextStatus, changes) {
    const tokenRef = fs.doc(db, 'hospitals', hospitalSlug, 'tokens', tokenId);

    return fs.runTransaction(db, async (transaction) => {
      const tokenSnap = await transaction.get(tokenRef);
      if (!tokenSnap.exists()) throw new Error('Token does not exist.');

      const token = tokenSnap.data();
      const previousStatus = normalizeStatus(token.status);
      if (!canTransition(previousStatus, nextStatus)) {
        throw new Error(`Invalid queue transition: ${previousStatus} to ${nextStatus}.`);
      }

      const doctorId = String((changes && changes.doctorId) || token.doctorId || 'unassigned');
      const date = String(token.date || 'unknown-date');
      const lockId = `${encodeURIComponent(date)}_${encodeURIComponent(doctorId)}`;
      const lockRef = fs.doc(db, 'hospitals', hospitalSlug, 'queueState', lockId);
      const lockSnap = await transaction.get(lockRef);
      const activeTokenId = lockSnap.exists() ? lockSnap.data().activeTokenId : null;

      if (nextStatus === 'called' && activeTokenId && activeTokenId !== tokenId) {
        throw new Error('This doctor already has an active patient. Complete or skip that token first.');
      }
      if ((nextStatus === 'completed' || nextStatus === 'skipped') &&
          activeTokenId && activeTokenId !== tokenId) {
        throw new Error('This token is not the active patient for this doctor.');
      }

      const timestamp = fs.serverTimestamp();
      const update = { ...(changes || {}), status: nextStatus, updatedAt: timestamp };
      if (nextStatus === 'called') update.calledAt = timestamp;
      if (nextStatus === 'completed') update.completedAt = timestamp;
      if (nextStatus === 'skipped') update.skippedAt = timestamp;
      if (nextStatus === 'canceled') update.canceledAt = timestamp;

      transaction.update(tokenRef, update);
      if (nextStatus === 'called') {
        transaction.set(lockRef, { doctorId, date, activeTokenId: tokenId, updatedAt: timestamp });
      } else if ((nextStatus === 'completed' || nextStatus === 'skipped') && activeTokenId === tokenId) {
        transaction.set(lockRef, { doctorId, date, activeTokenId: null, updatedAt: timestamp });
      }

      return { previousStatus, nextStatus, token };
    });
  }

  return { canTransition, nextTokenNumber, averageWaitMinutes, isHospitalAdmin, transitionToken, normalizeStatus };
});
