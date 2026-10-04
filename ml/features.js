'use strict';
/**
 * ============================================================
 *  TokSpot ML — feature pipeline (patient-flow prediction)
 * ============================================================
 *  What this predicts
 *  ------------------
 *  Primary target  : `waitMinutes` — minutes from a token being issued to it
 *                    being called. Regressed.
 *  Secondary target: `tokensNextHour` — how many tokens will be issued in the
 *                    hour after this one. Count.
 *
 *  Why flow and not the doctor copilot
 *  ----------------------------------
 *  Wait/volume prediction needs only token issuance timestamps, which TokSpot
 *  already writes (`tokens/{id}.createdAt`). It carries NO patient identity, so
 *  it needs no consent surface and nothing leaves the hospital. Every other
 *  AI use case in the product brief needs clinical records that do not exist.
 *
 *  THE ONE RULE THAT MATTERS: LEAKAGE
 *  ----------------------------------
 *  Every feature below is computed using ONLY information available at the
 *  moment the token was issued. If a feature can only be known after the
 *  patient was called, the model will "work" brilliantly offline and be
 *  worthless in production — and worse, it will look validated.
 *
 *  Concretely, forbidden inputs: the token's own call time, the token's final
 *  queue position, the number of tokens called after this one, or today's
 *  FINAL wait statistics. `assertNoLeakage()` is the runtime guard, and
 *  tests/ml-pipeline.test.cjs pins it by trying to sneak each one in.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/** India-observed holiday/weekend proxy. Replace with a real calendar later. */
const HOLIDAYS_ISO = new Set([]);

// ------------------------------------------------------------------
//  Time helpers. All take epoch millis (Firestore Timestamp.toDate()).
// ------------------------------------------------------------------

/** Local-midnight-aligned day index. Local matters: an OPD is not a UTC thing. */
function dayIndex(ms) {
  const d = new Date(ms);
  return Math.floor(
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / DAY_MS
  );
}

function isHoliday(ms) {
  const d = new Date(ms);
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`;
  return HOLIDAYS_ISO.has(iso);
}

/** Minutes since local midnight — the single most predictive flow feature. */
function minuteOfDay(ms) {
  const d = new Date(ms);
  return d.getHours() * 60 + d.getMinutes();
}

/** OPD intensity buckets. Indian OPD load is bimodal: late morning + evening. */
function timeBand(min) {
  if (min < 9 * 60) return 0;          // before OPD
  if (min < 12 * 60) return 1;         // morning peak
  if (min < 16 * 60) return 2;         // post-lunch lull
  if (min < 20 * 60) return 3;         // evening peak
  return 4;                            // late
}

// ------------------------------------------------------------------
//  The dataset builder
// ------------------------------------------------------------------
//
// Input: an array of raw token records, in ANY order. Each record needs
//   { createdAt: <epoch ms>, calledAt: <epoch ms|null>,
//     doctorId, counter, status, priority }
//
// Output: one row per ISSUED token, with features + the target.
//
// This is deliberately order-independent: it sorts internally. A pipeline
// that depends on input order silently learns the caller's query ordering.

/**
 * @param {Array<object>} rawTokens
 * @param {object} opts
 * @param {number} [opts.minWaitMinutes] drop waits below this (data noise)
 * @returns {{rows: Array<object>, stats: object}}
 */
function buildDataset(rawTokens, opts) {
  const o = opts || {};
  const minWait = o.minWaitMinutes == null ? 0 : o.minWaitMinutes;

  if (!Array.isArray(rawTokens)) throw new Error('rawTokens must be an array');

  const toks = rawTokens
    .filter((t) => t && Number.isFinite(t.createdAt))
    .map((t) => ({
      createdAt: t.createdAt,
      calledAt: Number.isFinite(t.calledAt) ? t.calledAt : null,
      doctorId: String(t.doctorId || 'unknown'),
      counter: String(t.counter || 'Counter A'),
      priority: t.priority ? 1 : 0,
      status: String(t.status || 'waiting'),
    }))
    .sort((a, b) => a.createdAt - b.createdAt);

  // Bucket by local day once. Every same-day statistic then reads from here.
  const byDay = new Map();
  for (const t of toks) {
    const d = dayIndex(t.createdAt);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(t);
  }

  // Per doctor, per day.
  const byDoctorDay = new Map();
  for (const [d, list] of byDay) {
    for (const t of list) {
      const k = `${d}|${t.doctorId}`;
      if (!byDoctorDay.has(k)) byDoctorDay.set(k, []);
      byDoctorDay.get(k).push(t);
    }
  }

  const rows = [];

  for (const [day, list] of byDay) {
    const listSorted = list.slice().sort((a, b) => a.createdAt - b.createdAt);

    for (let i = 0; i < listSorted.length; i++) {
      const t = listSorted[i];

      // --- Everything below is bounded by `i`: only tokens that existed
      // --- before this one may contribute. That is the leakage guarantee.

      // Tokens issued earlier today (queue load building up).
      let issuedTodaySoFar = 0;
      // Tokens already served today -> gives the live pace of the department.
      const waitsSoFar = [];
      let calledBefore = 0;

      for (let j = 0; j < i; j++) {
        const p = listSorted[j];
        issuedTodaySoFar++;
        if (p.calledAt != null && p.calledAt <= t.createdAt) {
          calledBefore++;
          const w = (p.calledAt - p.createdAt) / MINUTE_MS;
          if (w >= minWait) waitsSoFar.push(w);
        }
      }

      // Tokens still WAITING at the instant this one was issued.
      let queueDepthAtIssue = 0;
      for (let j = 0; j < i; j++) {
        const p = listSorted[j];
        if (p.calledAt == null || p.calledAt > t.createdAt) queueDepthAtIssue++;
      }

      const docList = byDoctorDay.get(`${day}|${t.doctorId}`) || [];
      let doctorIssuedSoFar = 0;
      const doctorWaits = [];
      for (const p of docList) {
        if (p.createdAt >= t.createdAt) continue;
        doctorIssuedSoFar++;
        if (p.calledAt != null && p.calledAt <= t.createdAt) {
          const w = (p.calledAt - p.createdAt) / MINUTE_MS;
          if (w >= minWait) doctorWaits.push(w);
        }
      }

      const min = minuteOfDay(t.createdAt);
      const dow = new Date(t.createdAt).getDay();
      const hourF = min / 60;
      const dowF = dow / 6;

      // Target. `pending` = issued but not yet called: usable for the count
      // target (it really happened), NOT for the wait target (no answer yet).
      const waitMinutes =
        t.calledAt != null && t.calledAt >= t.createdAt
          ? (t.calledAt - t.createdAt) / MINUTE_MS
          : null;

      rows.push({
        // Issuance time itself. Not a model feature — it is the ordering key
        // for the time-ordered split. Safe: known the moment the token is
        // printed.
        issuedAtMs: t.createdAt,

        // ---- features: strictly knowable at issuance ----
        hour: new Date(t.createdAt).getHours(),
        hourSin: Math.sin((2 * Math.PI * hourF)),
        hourCos: Math.cos((2 * Math.PI * hourF)),
        minuteOfDay: min,
        timeBand: timeBand(min),
        dow,
        dowSin: Math.sin((2 * Math.PI * dowF)),
        dowCos: Math.cos((2 * Math.PI * dowF)),
        isWeekend: dow === 0 || dow === 6 ? 1 : 0,
        isHoliday: isHoliday(t.createdAt) ? 1 : 0,
        month: new Date(t.createdAt).getMonth(),
        priority: t.priority,
        issuedTodaySoFar,
        queueDepthAtIssue,
        calledBeforeToday: calledBefore,
        doctorIssuedSoFar,
        // Only waits already COMPLETED before this issuance.
        medianWaitSoFar: waitsSoFar.length ? median(waitsSoFar) : -1,
        doctorMedianWaitSoFar: doctorWaits.length ? median(doctorWaits) : -1,
        // Categorical, integer-encoded. Codes are stable per-dataset via the
        // category map built in train.js — never per-row.
        counter: t.counter,
        doctorId: t.doctorId,

        // ---- targets ----
        waitMinutes,
        pending: waitMinutes == null ? 1 : 0,
      });
    }
  }

  const finished = rows.filter((r) => r.waitMinutes != null);
  const stats = {
    tokensIn: toks.length,
    rowsOut: rows.length,
    finishedWaits: finished.length,
    pendingWaits: rows.length - finished.length,
    days: byDay.size,
    doctors: new Set(toks.map((t) => t.doctorId)).size,
    spanFirst: toks.length ? new Date(toks[0].createdAt).toISOString() : null,
    spanLast: toks.length ? new Date(toks[toks.length - 1].createdAt).toISOString() : null,
  };

  return { rows, stats };
}

// ------------------------------------------------------------------
//  Vectorisation. Categorical codes are assigned from a vocabulary built
//  over the WHOLE dataset, so a row's encoding never depends on its position
//  and train/serve agree as long as the same vocabulary is saved.
// ------------------------------------------------------------------

const FEATURES = [
  'hour', 'hourSin', 'hourCos', 'minuteOfDay', 'timeBand',
  'dow', 'dowSin', 'dowCos', 'isWeekend', 'isHoliday', 'month',
  'priority', 'issuedTodaySoFar', 'queueDepthAtIssue', 'calledBeforeToday',
  'doctorIssuedSoFar', 'medianWaitSoFar', 'doctorMedianWaitSoFar',
];

const CATEGORICALS = ['counter', 'doctorId'];

/** Build a stable integer vocabulary from observed categories. */
function buildVocabulary(rows, keys) {
  const cols = keys || CATEGORICALS;
  const vocab = {};
  for (const k of cols) {
    const seen = new Set();
    for (const r of rows) if (r[k] != null) seen.add(String(r[k]));
    const sorted = Array.from(seen).sort();
    vocab[k] = Object.create(null);
    sorted.forEach((v, i) => { vocab[k][v] = i + 1; });
    vocab[k].__unknown = 0;
    vocab[k].__size = sorted.length;
  }
  return vocab;
}

function encodeRow(row, vocab) {
  const x = new Float64Array(FEATURES.length + CATEGORICALS.length);
  FEATURES.forEach((f, i) => {
    const v = row[f];
    x[i] = typeof v === 'boolean' ? (v ? 1 : 0) : (Number.isFinite(v) ? v : 0);
  });
  CATEGORICALS.forEach((k, j) => {
    const m = vocab[k];
    const code = m[String(row[k])];
    x[FEATURES.length + j] = code === undefined ? m.__unknown : code;
  });
  return x;
}

/** Rows -> {X, y} with target rows dropped where the target is null. */
function toMatrix(rows, vocab, targetKey) {
  const key = targetKey || 'waitMinutes';
  const usable = rows.filter((r) => Number.isFinite(r[key]));
  return {
    X: usable.map((r) => encodeRow(r, vocab)),
    y: usable.map((r) => r[key]),
    n: usable.length,
    dropped: rows.length - usable.length,
  };
}

// ------------------------------------------------------------------
//  Leakage guard.
// ------------------------------------------------------------------
// Called by train.js before fitting. If a future edit adds a feature that is
// only knowable after the visit is over, this throws rather than shipping a
// model that validates perfectly and fails in the clinic.

const FORBIDDEN = [
  'calledAt', 'waitMinutes', 'servedAt', 'finishedAt', 'endReason',
  'queuePositionAtCall', 'calledRankToday', 'finalWaitToday',
  'medianWaitFinalToday', 'cancelled', 'noShow', 'outcome',
];

function assertNoLeakage(featureNames) {
  const names = featureNames || FEATURES.concat(CATEGORICALS);
  const bad = names.filter((f) =>
    FORBIDDEN.some((k) => f === k || f.toLowerCase().includes(k.toLowerCase()))
  );
  if (bad.length) {
    throw new Error(
      'Leaky feature(s) detected: ' + bad.join(', ') +
      '. These are only knowable AFTER the patient is served, so the model ' +
      'would validate offline and fail in the clinic. Remove them.'
    );
  }
  return true;
}

// ------------------------------------------------------------------

function median(arr) {
  if (!arr.length) return 0;
  const a = arr.slice().sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

module.exports = {
  buildDataset,
  buildVocabulary,
  encodeRow,
  toMatrix,
  assertNoLeakage,
  median,
  FEATURES,
  CATEGORICALS,
  FORBIDDEN,
  timeBand,
  dayIndex,
  minuteOfDay,
  MINUTE_MS,
};