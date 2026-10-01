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

// Default average per-patient service time (minutes) used when the
// measured average is not yet available (e.g. brand-new doctor/day).
const DEFAULT_AVG_SERVE_MIN = 8;

function estimateWaitMinutes({ waitingCount, avgServeMinutes = null }) {
  const waiting = Number(waitingCount);
  if (!Number.isFinite(waiting) || waiting < 0) return null;
  if (waiting === 0) return 0;
  const serve = Number.isFinite(Number(avgServeMinutes)) && Number(avgServeMinutes) > 0
    ? Number(avgServeMinutes)
    : DEFAULT_AVG_SERVE_MIN;
  return Math.max(1, Math.round(waiting * serve));
}

/**
 * Reduces pharmacy-stage rows to what the public TV board shows: the
 * token being served at a counter plus the number still waiting.
 * Mirrors js/queue-domain.js so the sanitized feed and the prototype
 * snapshot agree (see tests/domain-sync.test.cjs).
 * @param {Array<object>} rows tokens routed to the pharmacy
 * @returns {{active: object|null, waiting: number}}
 */
function pharmacyBoardView(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const served = list.filter((t) => String(t.pharmacyStatus || '') === 'called');
  const active = served.reduce((best, row) => {
    if (!best) return row;
    return (timestampMillis(row.pharmacyCalledAt) || 0) > (timestampMillis(best.pharmacyCalledAt) || 0) ? row : best;
  }, null) || null;
  const waiting = list.filter((t) => String(t.pharmacyStatus || '') === 'waiting').length;
  return { active, waiting };
}

module.exports = {
  ALLOWED_TRANSITIONS,
  canTransition,
  nextTokenNumber,
  normalizeStatus,
  timestampMillis,
  averageWaitMinutes,
  estimateWaitMinutes,
  pharmacyBoardView,
};