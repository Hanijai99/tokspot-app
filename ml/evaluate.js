'use strict';
/**
 * ============================================================
 *  TokSpot ML — evaluation harness
 * ============================================================
 *  A model that does not beat a two-line heuristic has no business being
 *  predicted to a doctor. So this module is mostly about NOT being fooled:
 *
 *  1. Baselines. Persistence heuristics, not a trained model. If GBM cannot
 *     beat "the average wait for this time of day", it is dead weight.
 *
 *  2. TIME-ORDERED splits. Never a random split. Tokens issued this morning
 *     are correlated with tokens issued this morning; shuffling puts
 *     tomorrow's behaviour into the training set and reports a number that
 *     will never happen again. Hold the future out.
 *
 *  3. Slice reporting. A model can look good overall while being wrong every
 *     evening.OPD load is bimodal, so per-time-band error is the metric that
 *     matters.
 */

const { median } = require('./features');

// ------------------------------------------------------------------
//  Metrics
// ------------------------------------------------------------------

function mae(actual, pred) { return mean(actual.map((a, i) => Math.abs(a - pred[i]))); }
function rmse(actual, pred) { return Math.sqrt(mean(actual.map((a, i) => (a - pred[i]) ** 2))); }
function medianAbsErr(actual, pred) { return median(actual.map((a, i) => Math.abs(a - pred[i]))); }

function mean(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }

function p90AbsErr(actual, pred) {
  if (!actual.length) return 0;
  const s = actual.map((a, i) => Math.abs(a - pred[i])).sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(0.9 * s.length))];
}

function evaluate(actual, pred) {
  return {
    n: actual.length,
    mae: mae(actual, pred),
    rmse: rmse(actual, pred),
    medianAbsErr: medianAbsErr(actual, pred),
    p90AbsErr: p90AbsErr(actual, pred),
    actualMean: mean(actual),
    predMean: mean(pred),
  };
}

/** Percentage error reduction of `model` against `base`. Positive = better. */
function improvement(modelM, baseM) {
  if (!baseM.mae) {
    return { maePct: null, rmsePct: null, verdict: 'baseline is degenerate' };
  }
  const maePct = ((baseM.mae - modelM.mae) / baseM.mae) * 100;
  const rmsePct = baseM.rmse
    ? ((baseM.rmse - modelM.rmse) / baseM.rmse) * 100
    : null;
  return {
    maePct,
    rmsePct,
    verdict:
      maePct >= SHIP_THRESHOLD_PCT ? 'ship'
        : maePct > 0 ? 'below threshold — do not ship'
          : 'no better than the heuristic',
  };
}

/** A boosted model must beat the best heuristic by this much MAE to ship. */
const SHIP_THRESHOLD_PCT = 5;

// ------------------------------------------------------------------
//  Baselines — heuristics only, no fitting on the test set.
// ------------------------------------------------------------------

/**
 * Build a baseline from TRAIN rows only, then it may be applied to test rows.
 * The medians are keyed by time band and weekend flag because those are the
 * two things an OPD manager themselves tracks on a whiteboard.
 */
function fitBaseline(rows) {
  const keys = (r) => `${r.timeBand}|${r.isWeekend}`;
  const buckets = new Map();
  for (const r of rows) {
    if (!Number.isFinite(r.waitMinutes)) continue;
    const k = keys(r);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(r.waitMinutes);
  }
  const table = new Map();
  for (const [k, v] of buckets) table.set(k, median(v));

  const all = rows.filter((r) => Number.isFinite(r.waitMinutes)).map((r) => r.waitMinutes);
  const globalMedian = all.length ? median(all) : 0;
  const globalMean = all.length ? mean(all) : 0;

  return {
    kind: 'persistence',
    keys,
    globalMedian,
    globalMean,
    predictRow(r) {
      const v = table.get(keys(r));
      return v == null ? globalMedian : v;
    },
  };
}

// ------------------------------------------------------------------
//  Time-ordered split
// ------------------------------------------------------------------

/**
 * Split on issuance time, not row order — rows may arrive unsorted.
 * @param {Array<object>} rows
 * @param {number} testFraction
 */
function timeSplit(rows, testFraction) {
  const sorted = rows.slice().sort((a, b) => a.issuedAtMs - b.issuedAtMs);
  const cut = Math.floor(sorted.length * (1 - (testFraction || 0.25)));
  return { train: sorted.slice(0, cut), test: sorted.slice(cut) };
}

// ------------------------------------------------------------------
//  Full report
// ------------------------------------------------------------------

function sliceReport(rows, actual, pred, keyFn) {
  const buckets = new Map();
  rows.forEach((r, i) => {
    const k = keyFn(r);
    if (!buckets.has(k)) buckets.set(k, { a: [], p: [] });
    buckets.get(k).a.push(actual[i]);
    buckets.get(k).p.push(pred[i]);
  });
  const out = [];
  for (const [k, v] of buckets) {
    if (v.a.length < 5) continue; // too small to mean anything
    out.push({ slice: k, ...evaluate(v.a, v.p) });
  }
  return out.sort((x, y) => y.n - x.n);
}

/**
 * @param {object} p
 * @param {Array<object>} p.rows        rows carrying `issuedAtMs`
 * @param {Array<Float64Array>} p.X
 * @param {Array<number>} p.y
 * @param {Function} p.predict  (x, row) -> number
 * @param {string} [p.label]
 * @param {Array<Float64Array>} [p.trainX]  for an honest overfit check
 * @param {Array<number>} [p.trainY]
 */
function report({ rows, X, y, predict, label, trainX, trainY }) {
  const pred = X.map((x, i) => predict(x, rows[i]));
  const overall = evaluate(y, pred);

  // In-sample fit on a separate set, when supplied. A large gap against the
  // held-out number is overfitting — with 20 features and a few thousand rows
  // that is the default outcome, not the exception.
  const inSample = trainX && trainY
    ? evaluate(trainY, trainX.map((x) => predict(x)))
    : null;

  return {
    label: label || 'model',
    overall,
    inSample,
    byTimeBand: sliceReport(rows, y, pred, (r) => `band${r.timeBand}`),
    byWeekend: sliceReport(rows, y, pred, (r) => (r.isWeekend ? 'weekend' : 'weekday')),
  };
}

module.exports = {
  evaluate,
  improvement,
  fitBaseline,
  timeSplit,
  sliceReport,
  mae,
  rmse,
  mean,
  medianAbsErr,
  SHIP_THRESHOLD_PCT,
};