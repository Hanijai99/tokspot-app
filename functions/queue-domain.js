/**
 * ============================================================
 *  TokSpot queue domain — SERVER side (pure JS, no Firebase deps)
 * ============================================================
 *  Mirrors js/queue-domain.js (client UMD build). Both files MUST
 *  stay in sync — tests/domain-sync.test.cjs fails on drift.
 *  Import from Functions/scripts; never put Admin SDK in browser code.
 *
 *  Keep the transition matrix + status normalization identical here:
 *  the active-token lock and transition rules are the P0 integrity
 *  boundary, so they are enforced server-side (see index.js).
 * ============================================================
 */
'use strict';

const ALLOWED_TRANSITIONS = {
  waiting: ['called', 'canceled'],
  called: ['completed', 'skipped'],
  skipped: ['waiting', 'canceled'],
  completed: [],
  canceled: [],
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

module.exports = {
  ALLOWED_TRANSITIONS,
  canTransition,
  nextTokenNumber,
  normalizeStatus,
  timestampMillis,
  averageWaitMinutes,
};