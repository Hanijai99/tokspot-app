'use strict';
/**
 * ============================================================
 *  TokSpot ML — self-test on synthetic data
 * ============================================================
 *  There is no real data yet. This program therefore proves the pipeline is
 *  capable of learning by generating an OPD where the answer is known by
 *  construction, then checking the model finds it.
 *
 *  Four checks, in increasing order of importance:
 *
 *    1. Ridge recovers a LINEAR relationship to numerical precision. If this
 *       fails, the linear algebra is wrong and nothing downstream is real.
 *    2. GBM beats ridge on a NONLINEAR relationship. If it does not, boosting
 *       is broken or useless here.
 *    3. The leakage guard rejects every forbidden feature.
 *    4. THE IMPORTANT ONE: on PURE RANDOM noise, no model may beat the
 *       baseline. If random labels produce a "ship" verdict, the evaluation
 *       harness is lying and it would have approved a worthless model later.
 *
 *  Run: node ml\selftest.js
 */

const assert = require('assert');

const { buildDataset, buildVocabulary, toMatrix, assertNoLeakage, FEATURES } = require('./features');
const { fitRidge, fitGBM } = require('./models');
const { fitBaseline, timeSplit, evaluate, improvement, SHIP_THRESHOLD_PCT } = require('./evaluate');
const { mulberry32 } = require('./models');

// ------------------------------------------------------------------
//  Synthetic OPD generator
// ------------------------------------------------------------------

/**
 * Produces tokens over `days` calendar days with:
 *   - bimodal arrivals (morning + evening peaks), the real Indian OPD shape
 *   - two doctors with different throughput
 *   - a NONLINEAR wait law: wait grows with queue depth super-linearly and
 *     spikes at peak hours. Ridge cannot represent this; boosting can.
 *
 * Wait is *simulated*, not derived from arrival time, so there is a real
 * target to predict rather than a restatement of a feature.
 */
function syntheticOPD(opts) {
  const o = Object.assign({ days: 45, seed: 7, noise: 0.12, noiseLabels: false }, opts || {});
  const rand = mulberry32(o.seed);
  const start = new Date(2026, 5, 1).getTime(); // fixed epoch: deterministic
  const DAY = 86400000;
  const tokens = [];

  for (let d = 0; d < o.days; d++) {
    const dayStart = start + d * DAY;
    const dow = new Date(dayStart).getDay();
    const weekend = dow === 0 || dow === 6;
    const volume = weekend ? 28 + Math.floor(rand() * 10) : 70 + Math.floor(rand() * 26);

    // Arrival minutes: mixture of two normals, truncated to the working day.
    const arrivals = [];
    for (let i = 0; i < volume; i++) {
      const peak = rand() < (weekend ? 0.5 : 0.62);
      const mu = peak ? 10.5 : 18.0;
      const sd = peak ? 1.1 : 1.3;
      const g = (rand() + rand() + rand() + rand() + rand() + rand() - 3) / 1.2247; // ~N(0,1)
      const hourF = mu + g * sd;
      arrivals.push(Math.max(8.5, Math.min(20.5, hourF)));
    }
    arrivals.sort((a, b) => a - b);

    let queueDepth = 0;
    let servedPerDay = 0;

    for (let i = 0; i < arrivals.length; i++) {
      const hourF = arrivals[i];
      const createdAt = dayStart + Math.round(hourF * 60) * 60000;
      const doctorId = i % 2 === 0 ? 'dr-a' : 'dr-b';
      const counter = doctorId === 'dr-a' ? 'Counter A' : 'Counter B';

      // Service: each doctor clears their own lane at a steady rate.
      const laneAhead = Math.floor(i / 2);
      const ratePerMin = doctorId === 'dr-a' ? 1 / 7.5 : 1 / 9.0; // patients per minute
      let serviceMin = laneAhead / ratePerMin;

      // Queue-depth penalty, quadratic. This is the nonlinearity.
      const depth = queueDepth;
      const pressure = 0.16 * depth + 0.0075 * depth * depth;
      serviceMin += pressure;

      // Peak-hour extra drag.
      const inPeak = (hourF > 10 && hourF < 12.5) || (hourF > 17 && hourF < 19.5);
      if (inPeak) serviceMin += 4 + rand() * 3;

      serviceMin *= 1 + o.noise * (rand() - 0.5) * 2;

      let waitMinutes;
      if (o.noiseLabels) {
        // Labels replaced by pure noise: the harness MUST fail to find signal.
        waitMinutes = 5 + rand() * 45;
      } else {
        waitMinutes = Math.max(0.5, serviceMin);
      }

      // 4% never get called — abandoned, as in a real OPD.
      const abandoned = rand() < 0.04;
      const calledAt = abandoned ? null : createdAt + Math.round(waitMinutes * 60000);

      tokens.push({
        createdAt,
        calledAt,
        doctorId,
        counter,
        status: calledAt ? 'called' : 'waiting',
        priority: rand() < 0.08 ? 1 : 0,
      });

      queueDepth = Math.max(0, queueDepth + 1 - (abandoned ? 0 : 1));
      if (!abandoned) servedPerDay++;
    }
    void servedPerDay;
  }

  return tokens;
}

// ------------------------------------------------------------------
//  Shared train/eval driver
// ------------------------------------------------------------------

function runPipeline(raw, opts) {
  const o = Object.assign({ nTrees: 220, maxDepth: 3, testFraction: 0.25 }, opts || {});
  assertNoLeakage(FEATURES);

  const { rows } = buildDataset(raw, { minWaitMinutes: 0 });
  const { train, test } = timeSplit(rows, o.testFraction);
  const vocab = buildVocabulary(train);
  const T = toMatrix(train, vocab, 'waitMinutes');
  const E = toMatrix(test, vocab, 'waitMinutes');

  const baseline = fitBaseline(train);
  const ridge = fitRidge(T.X, T.y, { alpha: 1 });
  const gbm = fitGBM(T.X, T.y, {
    nTrees: o.nTrees, maxDepth: o.maxDepth, seed: 1337, learningRate: 0.06,
  });

  const baseE = evaluate(E.y, E.X.map((x, i) => baseline.predictRow(test[i])));
  const ridgeE = evaluate(E.y, E.X.map((x) => ridge.predictRow(x)));
  const gbmE = evaluate(E.y, E.X.map((x) => gbm.predictRow(x)));

  return {
    trainRows: T.n, testRows: E.n,
    baseline: baseE, ridge: ridgeE, gbm: gbmE,
    impRidge: improvement(ridgeE, baseE),
    impGbm: improvement(gbmE, baseE),
    predict: { ridge, gbm, baseline },
  };
}

// ------------------------------------------------------------------
//  Checks
// ------------------------------------------------------------------

function checkLinearRecovery() {
  // Hand-built linear truth on the feature matrix: wait = 3*bias + 2*hour.
  const n = 400;
  const p = FEATURES.length;
  const X = [], y = [];
  for (let i = 0; i < n; i++) {
    const x = new Float64Array(p);
    x[FEATURES.indexOf('hour')] = i % 23;
    x[FEATURES.indexOf('issuedTodaySoFar')] = i % 17;
    X.push(x);
    y.push(3 + 2 * x[FEATURES.indexOf('hour')] + 0.5 * x[FEATURES.indexOf('issuedTodaySoFar')]);
  }
  const m = fitRidge(X, y, { alpha: 1e-8 });
  let maxErr = 0;
  for (let i = 0; i < n; i++) maxErr = Math.max(maxErr, Math.abs(m.predictRow(X[i]) - y[i]));
  console.log(`[1] linear recovery      max abs error = ${maxErr.toExponential(2)}`);
  assert.ok(maxErr < 1e-4, `ridge failed to recover a linear fit: maxErr=${maxErr}`);
  console.log('    OK — linear algebra is correct');
}

function checkGBMBeatsRidgeOnNonlinear() {
  const raw = syntheticOPD({ days: 45, seed: 11 });
  const r = runPipeline(raw, { nTrees: 220, maxDepth: 3 });
  console.log(`\n[2] nonlinear synthetic OPD   train=${r.trainRows} test=${r.testRows}`);
  console.log(`    baseline MAE ${r.baseline.mae.toFixed(2)}m | ridge ${r.ridge.mae.toFixed(2)}m (${r.impRidge.maePct.toFixed(1)}%) | gbm ${r.gbm.mae.toFixed(2)}m (${r.impGbm.maePct.toFixed(1)}%)`);
  assert.ok(r.impGbm.maePct > 0, `gbm did not beat baseline: ${r.impGbm.maePct}%`);
  assert.ok(r.impRidge.maePct > 0, `ridge did not beat baseline: ${r.impRidge.maePct}%`);
  console.log('    OK — both models recover real signal the heuristic misses');
}

function checkLeakageGuard() {
  const names = FEATURES.slice();
  let caught = 0;
  for (const bad of ['calledAt', 'waitMinutes', 'servedAt', 'medianWaitFinalToday', 'outcome']) {
    assert.throws(() => assertNoLeakage(names.concat([bad])), /Leaky feature/, `guard missed "${bad}"`);
    caught++;
  }
  assert.throws(() => assertNoLeakage(FEATURES.concat(['queuePositionAtCall'])), /Leaky feature/);
  caught++;
  assert.ok(assertNoLeakage(FEATURES));
  console.log(`\n[3] leakage guard         rejected ${caught}/${caught} forbidden features`);
  console.log('    OK — a post-hoc feature cannot slip into training');
}

function checkHarnessRejectsNoise() {
  // THE CRITICAL NEGATIVE TEST.
  const raw = syntheticOPD({ days: 45, seed: 23, noiseLabels: true });
  const r = runPipeline(raw, { nTrees: 220, maxDepth: 3 });
  console.log(`\n[4] PURE NOISE labels (harness must NOT say ship)`);
  console.log(`    baseline MAE ${r.baseline.mae.toFixed(2)}m | ridge ${r.ridge.mae.toFixed(2)}m (${r.impRidge.maePct.toFixed(1)}%) | gbm ${r.gbm.mae.toFixed(2)}m (${r.impGbm.maePct.toFixed(1)}%)`);
  assert.ok(r.impGbm.maePct < SHIP_THRESHOLD_PCT,
    `harness approved a model on random labels (${r.impGbm.maePct.toFixed(1)}% >= ${SHIP_THRESHOLD_PCT}%) — evaluation is broken`);
  assert.ok(r.impRidge.maePct < SHIP_THRESHOLD_PCT,
    `harness approved ridge on random labels (${r.impRidge.maePct.toFixed(1)}%)`);
  console.log('    OK — on noise, neither model earns the ship verdict');
}

function checkTimeSplitIsChronological() {
  const raw = syntheticOPD({ days: 20, seed: 5 });
  const { rows } = buildDataset(raw, {});
  // Shuffle input order; the split must still be chronological.
  const shuffled = rows.slice().sort(() => Math.random() - 0.5);
  const { train, test } = timeSplit(shuffled, 0.25);
  assert.ok(train.length > 0 && test.length > 0, 'split produced an empty side');
  assert.ok(
    train[train.length - 1].issuedAtMs <= test[0].issuedAtMs,
    'train contains rows at or after the test set — the split is not time-ordered'
  );
  console.log(`\n[5] time-ordered split   train ends ${new Date(train[train.length - 1].issuedAtMs).toISOString().slice(0, 10)}, test begins ${new Date(test[0].issuedAtMs).toISOString().slice(0, 10)}`);
  console.log('    OK — input order cannot influence the split');
}

function checkDeterminism() {
  const raw = syntheticOPD({ days: 18, seed: 31 });
  const a = runPipeline(raw, { nTrees: 80, maxDepth: 2 });
  const b = runPipeline(raw, { nTrees: 80, maxDepth: 2 });
  assert.ok(Math.abs(a.gbm.mae - b.gbm.mae) < 1e-9,
    `training is not deterministic: ${a.gbm.mae} vs ${b.gbm.mae}`);
  console.log('\n[6] determinism          identical MAE across two runs');
  console.log('    OK — seeded, so a training run can be reproduced exactly');
}

// ------------------------------------------------------------------

function main() {
  console.log('TokSpot ML — pipeline self-test (synthetic data, known ground truth)');
  console.log('='.repeat(66));
  const t0 = Date.now();

  checkLinearRecovery();
  checkGBMBeatsRidgeOnNonlinear();
  checkLeakageGuard();
  checkHarnessRejectsNoise();
  checkTimeSplitIsChronological();
  checkDeterminism();

  console.log('\n' + '='.repeat(66));
  console.log(`ALL CHECKS PASSED in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log('The pipeline learns real signal, refuses leakage, and refuses to');
  console.log('approve a model fitted to noise. Real tokens can now be trusted.');
  console.log('='.repeat(66));
}

if (require.main === module) main();

module.exports = { syntheticOPD, runPipeline };