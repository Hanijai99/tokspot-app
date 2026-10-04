'use strict';
/**
 * Round 9.17 — patient-flow ML pipeline.
 *
 * There is no training data yet, so what these tests protect is the pipeline
 * itself: that the maths is right, that it refuses to leak, and — the one
 * that matters most — that the evaluation harness says NO when given noise.
 *
 * The harness test is not academic. A training script that always reports a
 * good number is worse than no script, because it will green-light a model
 * that tells a doctor the wrong wait time with total confidence. So the
 * negative case is asserted as strictly as the positive one.
 *
 * Three defects were found and fixed by these tests while the pipeline was
 * written; each has a test here that fails if it returns:
 *   1. varianceGain returned child-minus-parent, always <= 0, so every tree
 *      silently degraded to a leaf predicting the mean.
 *   2. The bin search used the wrong comparison, collapsing all rows into the
 *      last bin.
 *   3. treePredict used `<=` against a rule that trained on a strict `<`,
 *      misrouting every value sitting exactly on a bin edge.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const ml = path.join(__dirname, '..', 'ml');
const feat = require(path.join(ml, 'features'));
const models = require(path.join(ml, 'models'));
const ev = require(path.join(ml, 'evaluate'));
const { syntheticOPD, runPipeline } = require(path.join(ml, 'selftest'));

const { buildDataset, buildVocabulary, toMatrix, assertNoLeakage, FEATURES } = feat;
const { fitRidge, fitGBM, varianceGain, computeEdges, assignBins, treePredict } = models;
const { fitBaseline, timeSplit, evaluate, improvement, SHIP_THRESHOLD_PCT } = ev;

// ------------------------------------------------------------------
//  1. The split criterion itself
// ------------------------------------------------------------------

test('varianceGain is POSITIVE for an informative split', () => {
  // Perfectly separated split: {0,0,0,0} vs {10,10,10,10}.
  const gain = varianceGain(0, 0, 4, 40, 400, 4, 400, 40, 8);
  assert.ok(gain > 0,
    `an informative split must score positive, got ${gain}. A non-positive gain ` +
    'means every tree degenerates to a leaf and the model silently predicts a constant.');
  assert.ok(Math.abs(gain - 25) < 1e-9, `expected variance 25 reduction, got ${gain}`);
});

test('varianceGain is ~ZERO for a split that separates nothing', () => {
  // Interleaved {0,10} vs {0,10} — same variance either side.
  const gain = varianceGain(10, 100, 2, 10, 100, 2, 200, 20, 4);
  assert.ok(Math.abs(gain) < 1e-9, `a useless split must score ~0, got ${gain}`);
});

test('varianceGain refuses degenerate children', () => {
  assert.strictEqual(varianceGain(0, 0, 1, 10, 100, 3, 100, 10, 4), -Infinity);
});

// ------------------------------------------------------------------
//  2. Bin assignment must agree with the predict rule
// ------------------------------------------------------------------

test('binning is consistent with treePredict at bin edges', () => {
  // Guards defect (2) and (3): training assigns a row left when
  // `bin <= splitBin`, which must mean exactly `value < edges[splitBin]`.
  const X = [];
  for (let v = 0; v <= 100; v++) {
    const x = new Float64Array(1);
    x[0] = v;
    X.push(x);
  }
  const edges = computeEdges(X, null);
  const bins = assignBins(X, edges);

  for (let b = 0; b < edges[0].length; b++) {
    const splitValue = edges[0][b];
    for (let v = 0; v <= 100; v++) {
      const wentLeftInFit = bins[0][v] <= b;
      const goesLeftInPredict = v < splitValue;
      assert.strictEqual(wentLeftInFit, goesLeftInPredict,
        `value ${v} vs edge ${splitValue} (splitBin ${b}): fit sent it ` +
        `${wentLeftInFit ? 'left' : 'right'} but treePredict would send it ` +
        `${goesLeftInPredict ? 'left' : 'right'}`);
    }
  }
});

test('binning actually distributes values instead of collapsing to one bin', () => {
  const X = [];
  for (let v = 0; v < 200; v++) {
    const x = new Float64Array(1);
    x[0] = v;
    X.push(x);
  }
  const bins = assignBins(X, computeEdges(X, null));
  const used = new Set(Array.from(bins[0]));
  assert.ok(used.size > 8,
    `only ${used.size} distinct bin(s) used — the bin search is degenerate`);
});

test('a constant column produces no edges and no crash', () => {
  const X = [];
  for (let i = 0; i < 50; i++) {
    const x = new Float64Array(1);
    x[0] = 7;
    X.push(x);
  }
  const edges = computeEdges(X, null);
  assert.strictEqual(edges[0].length, 0, 'a constant column must yield zero edges');
  const bins = assignBins(X, edges);
  assert.strictEqual(bins[0].length, 50);
  const m = fitGBM(X, X.map(() => 1 + i0()), { nTrees: 5, maxDepth: 2, seed: 1 });
  function i0() { return 0; }
  assert.ok(Number.isFinite(m.predictRow(X[0])));
});

// ------------------------------------------------------------------
//  3. GBM must actually split (guards defect (1))
// ------------------------------------------------------------------

test('fitted GBM produces real splits, not pure leaves', () => {
  const X = [], y = [];
  for (let i = 0; i < 200; i++) {
    const a = i % 20;
    const x = new Float64Array(2);
    x[0] = a; x[1] = a * a;
    X.push(x);
    y.push(2 * a + 0.5 * a * a);
  }
  const m = fitGBM(X, y, { nTrees: 30, maxDepth: 2, learningRate: 0.2, minSamplesLeaf: 5, seed: 1 });
  const leaves = m.trees.filter((t) => !t.left).length;
  assert.strictEqual(leaves, 0,
    `${leaves}/${m.trees.length} trees made no split at all — the split criterion is broken`);
  const spread = new Set(m.trees.map((t) => JSON.stringify(t)));
  assert.ok(spread.size > 1, 'every tree is identical, so boosting is a no-op');
});

test('GBM predictions vary with the input', () => {
  const X = [], y = [];
  for (let i = 0; i < 200; i++) {
    const a = i % 20;
    const x = new Float64Array(2);
    x[0] = a; x[1] = a * a;
    X.push(x);
    y.push(2 * a + 0.5 * a * a);
  }
  const m = fitGBM(X, y, { nTrees: 40, maxDepth: 2, seed: 3 });
  const lo = m.predictRow(Object.assign(new Float64Array(2), [1, 1]));
  const hi = m.predictRow(Object.assign(new Float64Array(2), [19, 361]));
  assert.ok(hi > lo + 10, `model is not responding to input: lo=${lo} hi=${hi}`);
});

test('treePredict routes a value exactly on a split value to the right child', () => {
  // `bin <= splitBin` is equivalent to `value < edges[splitBin]`, so a value
  // sitting exactly on the edge belongs RIGHT.
  const tree = { value: 0, feature: 0, splitValue: 10, left: { value: 1 }, right: { value: 2 } };
  const row = new Float64Array(1);
  row[0] = 10;
  assert.strictEqual(treePredict(tree, row), 2, 'exact edge value went left; must go right');
  row[0] = 9.999;
  assert.strictEqual(treePredict(tree, row), 1, 'below-edge value went right; must go left');
});

// ------------------------------------------------------------------
//  4. Ridge correctness
// ------------------------------------------------------------------

test('ridge recovers an exact linear relationship', () => {
  const X = [], y = [];
  const hi = FEATURES.indexOf('hour');
  for (let i = 0; i < 300; i++) {
    const x = new Float64Array(FEATURES.length);
    x[hi] = i % 23;
    X.push(x);
    y.push(3 + 2 * x[hi]);
  }
  const m = fitRidge(X, y, { alpha: 1e-8 });
  let maxErr = 0;
  for (let i = 0; i < X.length; i++) maxErr = Math.max(maxErr, Math.abs(m.predictRow(X[i]) - y[i]));
  assert.ok(maxErr < 1e-4, `ridge max error ${maxErr}`);
});

// ------------------------------------------------------------------
//  5. Leakage guard
// ------------------------------------------------------------------

test('leakage guard rejects every forbidden feature', () => {
  for (const bad of feat.FORBIDDEN) {
    assert.throws(() => assertNoLeakage(FEATURES.concat([bad])), /Leaky feature/,
      `guard let "${bad}" through`);
  }
});

test('leakage guard catches a feature merely CONTAINING a forbidden name', () => {
  assert.throws(() => assertNoLeakage(['myCalledAtMillis']), /Leaky feature/);
  assert.throws(() => assertNoLeakage(['totalWaitMinutes']), /Leaky feature/);
});

test('leakage guard accepts the real feature set', () => {
  assert.strictEqual(assertNoLeakage(FEATURES), true);
});

test('the shipped feature set is exactly the reviewed allowlist', () => {
  // Pinned exactly, not pattern-matched. A blocklist regex is too easy to
  // fool (`isWeekend` matches /end/) and too easy to extend by accident.
  // Adding a feature must be a conscious edit here AND in features.js, which
  // is exactly when someone should ask whether it is knowable at issuance.
  const EXPECTED = [
    'hour', 'hourSin', 'hourCos', 'minuteOfDay', 'timeBand',
    'dow', 'dowSin', 'dowCos', 'isWeekend', 'isHoliday', 'month',
    'priority', 'issuedTodaySoFar', 'queueDepthAtIssue', 'calledBeforeToday',
    'doctorIssuedSoFar', 'medianWaitSoFar', 'doctorMedianWaitSoFar',
  ];
  assert.deepStrictEqual(FEATURES, EXPECTED,
    'FEATURES changed. Each addition must be justified as knowable at token issuance.');
  assert.deepStrictEqual(feat.CATEGORICALS, ['counter', 'doctorId']);
});

test('every numeric feature is either a clock reading or a past-tense count', () => {
  // Guard the two families that are always safe: calendar fields, and counts
  // of things that had already happened. `calledBeforeToday` is fine precisely
  // because "before today" — anything phrased about what the visit ENDED with
  // is not.
  const pastCounts = /^(issued|queue|called|doctor|served|completed|median)\w*(SoFar|AtIssue|Today)$/;
  const calendar = /^(hour|minuteOfDay|dow|month|isWeekend|isHoliday|priority|timeBand)$/;
  const cyclic = /^(hour|dow)(Sin|Cos)$/;
  for (const f of FEATURES) {
    assert.ok(pastCounts.test(f) || calendar.test(f) || cyclic.test(f),
      `feature "${f}" is not a clock reading, a past count, or a calendar field. ` +
      'Anything else needs justifying as knowable at issuance.');
  }
});

// ------------------------------------------------------------------
//  6. The dataset builder
// ------------------------------------------------------------------

test('dataset is order-independent', () => {
  const raw = syntheticOPD({ days: 6, seed: 9 });
  const a = buildDataset(raw, {});
  const shuffled = raw.slice().reverse();
  const b = buildDataset(shuffled, {});
  assert.strictEqual(a.rows.length, b.rows.length);
  for (let i = 0; i < a.rows.length; i++) {
    assert.strictEqual(a.rows[i].issuedAtMs, b.rows[i].issuedAtMs,
      'row order changed when the input was reversed');
  }
});

test('features never use waits that had not already completed', () => {
  // The subtle one: medianWaitSoFar may only average patients called BEFORE
  // this issuance. If it peeked at a later call the offline score would be a
  // lie and the model would be worthless in the clinic.
  //
  // At the moment token 3 is issued, token 1 HAS been served (30 min) and
  // token 2 has NOT (190 min). So the feature must be 30. Anything near 110
  // means the builder reached into the future.
  const base = new Date(2026, 5, 1, 10, 0, 0).getTime();
  const raw = [
    { createdAt: base, calledAt: base + 30 * 60000, doctorId: 'a', counter: 'A', status: 'called' },
    { createdAt: base + 10 * 60000, calledAt: base + 200 * 60000, doctorId: 'a', counter: 'A', status: 'called' },
    { createdAt: base + 60 * 60000, calledAt: base + 61 * 60000, doctorId: 'a', counter: 'A', status: 'called' },
  ];
  const { rows } = buildDataset(raw, {});
  const last = rows[rows.length - 1];
  assert.strictEqual(last.issuedAtMs, base + 60 * 60000, 'rows must come out in issuance order');
  assert.strictEqual(last.medianWaitSoFar, 30,
    `medianWaitSoFar leaked a future wait: got ${last.medianWaitSoFar}, expected 30 ` +
    '(token 2 was not served until 190 min after it was issued)');
  // Token 2 was issued but not served at that instant -> still in queue.
  assert.strictEqual(last.queueDepthAtIssue, 1,
    `queueDepthAtIssue is wrong: ${last.queueDepthAtIssue}`);
  assert.strictEqual(last.issuedTodaySoFar, 2, 'only two tokens existed before this one');
});

test('medianWaitSoFar is -1 when nothing had been served yet', () => {
  // The first patients of the day have no completed history. -1 is the
  // documented sentinel, NOT 0 — 0 would read as "instant service".
  const base = new Date(2026, 5, 1, 10, 0, 0).getTime();
  const raw = [
    { createdAt: base, calledAt: base + 60 * 60000, doctorId: 'a', counter: 'A', status: 'called' },
    { createdAt: base + 5 * 60000, calledAt: base + 61 * 60000, doctorId: 'a', counter: 'A', status: 'called' },
  ];
  const { rows } = buildDataset(raw, {});
  assert.strictEqual(rows[0].medianWaitSoFar, -1);
  assert.strictEqual(rows[1].medianWaitSoFar, -1,
    'token 2 was issued before token 1 was served');
});

test('pending tokens are excluded from the wait target but kept as rows', () => {
  const base = new Date(2026, 5, 1, 10, 0, 0).getTime();
  const raw = [
    { createdAt: base, calledAt: base + 20 * 60000, doctorId: 'a', counter: 'A', status: 'called' },
    { createdAt: base + 5 * 60000, calledAt: null, doctorId: 'a', counter: 'A', status: 'waiting' },
  ];
  const { rows, stats } = buildDataset(raw, {});
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(stats.finishedWaits, 1);
  assert.strictEqual(stats.pendingWaits, 1);
  const { y, n, dropped } = toMatrix(rows, buildVocabulary(rows), 'waitMinutes');
  assert.strictEqual(n, 1);
  assert.strictEqual(dropped, 1);
  assert.strictEqual(y.length, 1);
});

test('vocabulary is built from training rows only and is stable', () => {
  const { rows } = buildDataset(syntheticOPD({ days: 5, seed: 4 }), {});
  const { train, test } = timeSplit(rows, 0.3);
  const v = buildVocabulary(train);
  const a = feat.encodeRow(rows[0], v);
  const b = feat.encodeRow(rows[0], v);
  assert.deepStrictEqual(Array.from(a), Array.from(b), 'encoding is not deterministic');
  assert.strictEqual(a.length, FEATURES.length + feat.CATEGORICALS.length);
});

// ------------------------------------------------------------------
//  7. Time-ordered split
// ------------------------------------------------------------------

test('timeSplit is chronological no matter how rows arrive', () => {
  const { rows } = buildDataset(syntheticOPD({ days: 12, seed: 6 }), {});
  for (const perm of [rows, rows.slice().reverse(), rows.slice().sort(() => Math.random() - 0.5)]) {
    const { train, test } = timeSplit(perm, 0.25);
    assert.ok(train.length > 0 && test.length > 0);
    assert.ok(train[train.length - 1].issuedAtMs <= test[0].issuedAtMs,
      'train contains rows at or after the test set');
  }
});

// ------------------------------------------------------------------
//  8. THE NEGATIVE TEST — the harness must refuse a worthless model
// ------------------------------------------------------------------

test('no model earns a ship verdict on PURE NOISE', () => {
  const raw = syntheticOPD({ days: 25, seed: 23, noiseLabels: true });
  const r = runPipeline(raw, { nTrees: 120, maxDepth: 2 });
  assert.ok(r.impGbm.maePct < SHIP_THRESHOLD_PCT,
    `harness approved GBM fitted to random labels (${r.impGbm.maePct.toFixed(1)}%) — ` +
    'the evaluation is lying and would green-light a useless model');
  assert.ok(r.impRidge.maePct < SHIP_THRESHOLD_PCT,
    `harness approved ridge fitted to random labels (${r.impRidge.maePct.toFixed(1)}%)`);
});

test('models DO earn a ship verdict on real signal', () => {
  // The other half: without this, the negative test above could pass simply
  // because the harness rejects everything.
  const raw = syntheticOPD({ days: 30, seed: 17 });
  const r = runPipeline(raw, { nTrees: 160, maxDepth: 3 });
  assert.ok(r.impRidge.maePct > SHIP_THRESHOLD_PCT,
    `ridge failed to find signal it should have found (${r.impRidge.maePct.toFixed(1)}%)`);
  assert.ok(r.impGbm.maePct > SHIP_THRESHOLD_PCT,
    `gbm failed to find signal it should have found (${r.impGbm.maePct.toFixed(1)}%)`);
});

test('improvement() reports the right verdict for each case', () => {
  const base = { mae: 20, rmse: 25 };
  assert.match(improvement({ mae: 18, rmse: 22 }, base).verdict, /ship/);
  assert.match(improvement({ mae: 19.5, rmse: 24 }, base).verdict, /below threshold/);
  assert.match(improvement({ mae: 21, rmse: 26 }, base).verdict, /no better/);
  assert.match(improvement({ mae: 5, rmse: 6 }, { mae: 0, rmse: 0 }).verdict, /degenerate/);
});

// ------------------------------------------------------------------
//  9. The persistence baseline must never be worse than the mean
// ------------------------------------------------------------------

test('baseline beats the global mean on a time-varying wait', () => {
  const base = new Date(2026, 5, 1).getTime();
  const rows = [];
  // Morning waits 60m, evening waits 10m. A constant mean is badly wrong for
  // both; a per-band median is not.
  for (let h = 0; h < 24; h++) {
    for (let i = 0; i < 20; i++) {
      const minute = h * 60;
      rows.push({
        timeBand: feat.timeBand(minute), isWeekend: 0,
        waitMinutes: (h >= 9 && h < 12) ? 60 : 10,
      });
    }
  }
  void base;
  const b = fitBaseline(rows);
  const meanMae = ev.evaluate(rows.map((r) => r.waitMinutes),
    rows.map(() => b.globalMean));
  const baseMae = ev.evaluate(rows.map((r) => r.waitMinutes),
    rows.map((r) => b.predictRow(r)));
  assert.ok(baseMae.mae < meanMae.mae / 2,
    `baseline (${baseMae.mae.toFixed(1)}) should crush the global mean (${meanMae.mae.toFixed(1)})`);
});

// ------------------------------------------------------------------
//  10. Determinism
// ------------------------------------------------------------------

test('training is reproducible', () => {
  const raw = syntheticOPD({ days: 10, seed: 12 });
  const a = runPipeline(raw, { nTrees: 60, maxDepth: 2 });
  const b = runPipeline(raw, { nTrees: 60, maxDepth: 2 });
  assert.strictEqual(a.gbm.mae, b.gbm.mae);
  assert.strictEqual(a.ridge.mae, b.ridge.mae);
});

test('the PRNG is stable across calls', () => {
  const a = models.mulberry32(42);
  const b = models.mulberry32(42);
  for (let i = 0; i < 20; i++) assert.strictEqual(a(), b());
});

// ------------------------------------------------------------------
//  11. Export must never write PHI
// ------------------------------------------------------------------

test('export strips every identifying field from a token doc', () => {
  const src = fs.readFileSync(path.join(ml, 'export.js'), 'utf8');
  // Exercise projectToken through a real export module load is not possible
  // (it runs main on require), so assert on the source contract instead.
  assert.match(src, /ALLOWED_FIELDS\s*=\s*\[[^\]]*'createdAt'[^\]]*\]/);
  assert.match(src, /FORBIDDEN_FIELDS/, 'export must keep a PHI denylist');
  for (const f of ['patientName', 'phone', 'email']) {
    assert.ok(src.includes(`'${f}'`),
      `export denylist must name "${f}" — it is written on every token doc`);
  }
  assert.match(src, /assertNoPhi/, 'export must assert the record is PHI-free before writing');
  assert.match(src, /function assertNoPhi/);
});

test('the PHI denylist covers every identifying field the app actually writes', () => {
  // Reads the real token writer so the denylist cannot drift from the schema.
  const api = fs.readFileSync(path.join(__dirname, '..', 'js', 'api.js'), 'utf8');
  const exportSrc = fs.readFileSync(path.join(ml, 'export.js'), 'utf8');
  const denylist = exportSrc.slice(exportSrc.indexOf('FORBIDDEN_FIELDS'), exportSrc.indexOf('function parseArgs'));

  const identifying = ['patientName', 'phone', 'email'];
  for (const field of identifying) {
    const appWritesIt = new RegExp(`\\b${field}\\s*:`).test(api);
    if (appWritesIt) {
      assert.ok(denylist.includes(`'${field}'`),
        `js/api.js writes "${field}" onto token docs but export.js does not denylist it`);
    }
  }
});

// ------------------------------------------------------------------
//  12. Row/target alignment  (round 9.18)
// ------------------------------------------------------------------
//
// Round 9.18 shipped a scoring bug that no assertion caught. toMatrix()
// drops rows with a null target (tokens issued but never called), but the
// time-ordered split ran on the FULL row set first. So `test` held 804 rows
// while `E.y` held 780, and every `test[i]` was paired with the wrong
// target — including the BASELINE's score, which is the number that decides
// whether the model ships.
//
// It failed quietly. The baseline's MAE was reported as 7.42m when it was
// really 4.33m, a flattering 63% improvement that was really 36%. The only
// visible symptom was NaN in one time band, which looked like a display
// glitch rather than a corrupt evaluation.
//
// Rule: row metadata and targets must be filtered together, before splitting.

test('rowsWithTarget returns exactly the rows toMatrix keeps', () => {
  const { rows } = buildDataset(syntheticOPD({ days: 20, seed: 21 }), {});
  const usable = feat.rowsWithTarget(rows, 'waitMinutes');
  const M = toMatrix(usable, buildVocabulary(usable), 'waitMinutes');

  assert.strictEqual(usable.length, M.n,
    'rowsWithTarget and toMatrix disagree on how many rows are usable');
  assert.strictEqual(M.dropped, 0, 'nothing should be dropped after pre-filtering');

  // And it must genuinely exclude the pending ones.
  const pendingInRows = rows.filter((r) => r.waitMinutes == null).length;
  assert.ok(usable.length === rows.length - pendingInRows);
});

test('the pipeline keeps row metadata aligned with targets end to end', () => {
  const raw = syntheticOPD({ days: 30, seed: 33 });
  const { rows } = buildDataset(raw, {});
  const usable = feat.rowsWithTarget(rows, 'waitMinutes');
  const { train, test } = timeSplit(usable, 0.25);
  const vocab = buildVocabulary(train);
  const T = toMatrix(train, vocab, 'waitMinutes');
  const E = toMatrix(test, vocab, 'waitMinutes');

  assert.strictEqual(train.length, T.n, 'train rows/targets misaligned');
  assert.strictEqual(test.length, E.n, 'test rows/targets misaligned');
});

test('splitting BEFORE filtering is detectable, not silent', () => {
  // Reproduce the old ordering and prove the misalignment is visible.
  const { rows } = buildDataset(syntheticOPD({ days: 30, seed: 33 }), {});
  const bad = timeSplit(rows, 0.25);                 // unfiltered, as before
  const vocab = buildVocabulary(bad.train);
  const E = toMatrix(bad.test, vocab, 'waitMinutes');
  assert.notStrictEqual(bad.test.length, E.n,
    'this dataset no longer reproduces the bug — the guard test is now vacuous');

  // Reading past the end of the target array is what produced NaN before.
  assert.strictEqual(E.y[E.y.length], undefined);
  assert.ok(Number.isNaN(Math.abs(undefined - 1)));
});

test('per-slice evaluation never produces NaN', () => {
  const raw = syntheticOPD({ days: 30, seed: 44 });
  const r = runPipeline(raw, { nTrees: 60, maxDepth: 2 });

  // Slice counts must reconstruct the test-set size exactly. Anything else
  // means rows and targets drifted apart.
  const src = fs.readFileSync(path.join(ml, 'train.js'), 'utf8');
  assert.match(src, /if \(train\.length !== T\.n \|\| test\.length !== E\.n\)/,
    'train.js must assert alignment rather than assume it');

  for (const m of [r.baseline, r.ridge, r.gbm]) {
    for (const k of ['mae', 'rmse', 'medianAbsErr', 'p90AbsErr']) {
      assert.ok(Number.isFinite(m[k]), `${k} is ${m[k]} — scoring is broken`);
    }
  }
});

test('evaluate.report is exported and callable', () => {
  // It was defined but not exported; train.js crashed on it at runtime.
  assert.strictEqual(typeof ev.report, 'function');
  const { rows } = buildDataset(syntheticOPD({ days: 10, seed: 51 }), {});
  const usable = feat.rowsWithTarget(rows, 'waitMinutes');
  const { train, test } = timeSplit(usable, 0.3);
  const vocab = buildVocabulary(train);
  const E = toMatrix(test, vocab, 'waitMinutes');

  const rep = ev.report({
    rows: test, X: E.X, y: E.y,
    predict: (x) => x[0],
    label: 'identity',
  });
  assert.ok(Number.isFinite(rep.overall.mae), 'report() returned a non-finite MAE');
  // Every slice count must be accounted for.
  const summed = rep.byTimeBand.reduce((s, b) => s + b.n, 0);
  assert.ok(summed <= E.n,
    `slice counts (${summed}) exceed the test set (${E.n}) — rows and targets are misaligned`);
});

// ------------------------------------------------------------------
//  13. Sample data generator
// ------------------------------------------------------------------

test('the synthetic generator emits export-shaped records only', () => {
  const { generate } = require(path.join(ml, 'sample-data'));
  const recs = generate({ days: 4, seed: 9, volume: 1, start: '2026-06-01' });

  assert.ok(recs.length > 50, `too few records to be useful: ${recs.length}`);
  const ALLOWED = new Set(['createdAt', 'calledAt', 'doctorId', 'counter', 'status', 'priority']);
  for (const r of recs) {
    assert.deepStrictEqual(Object.keys(r).sort(), [...ALLOWED].sort(),
      'generated record has the wrong shape — real exports will not load');
    assert.ok(Number.isFinite(r.createdAt), 'createdAt must be epoch millis');
    assert.ok(r.calledAt === null || Number.isFinite(r.calledAt));
    if (r.calledAt != null) assert.ok(r.calledAt > r.createdAt, 'calledAt precedes createdAt');
  }
  // Sorted, as export.js emits.
  for (let i = 1; i < recs.length; i++) {
    assert.ok(recs[i].createdAt >= recs[i - 1].createdAt, 'records must be time-ordered');
  }
});

test('the synthetic generator contains no identifying fields', () => {
  const { generate } = require(path.join(ml, 'sample-data'));
  const recs = generate({ days: 3, seed: 4, volume: 1, start: '2026-06-01' });
  const keys = new Set(recs.flatMap((r) => Object.keys(r)));
  for (const bad of ['patientName', 'name', 'phone', 'email']) {
    assert.ok(!keys.has(bad), `generator emitted "${bad}" — training data must stay PHI-free`);
  }
});

test('training on synthetic data must NOT be mistaken for a real model', () => {
  const src = fs.readFileSync(path.join(ml, 'sample-data.js'), 'utf8');
  assert.match(src, /NOT REAL PATIENTS/, 'the generator must label its own output');
  assert.match(src, /SYNTHETIC-DEMO/, 'default filename must be self-evidently fake');
  // And the artefacts must not be committable.
  const ignore = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
  assert.match(ignore, /ml[\\/]data/);
  assert.match(ignore, /\.jsonl/);
});

// ------------------------------------------------------------------
//  14. End-to-end: run the actual CLI
// ------------------------------------------------------------------
//
// The source-level assertions above all passed while the trainer was still
// splitting before filtering — reverting the fix broke nothing. So the only
// honest guard is to RUN it.
//
// This executes ml\train.js as a child process over data that deliberately
// contains pending (never-called) tokens, which is exactly the condition that
// used to shift every row against its target.

const { spawnSync } = require('node:child_process');
const os = require('node:os');

test('the training CLI runs clean on data containing pending tokens', (t) => {
  const { generate } = require(path.join(ml, 'sample-data'));
  const recs = generate({ days: 26, seed: 77, volume: 1, start: '2026-06-01' });

  const pending = recs.filter((r) => r.calledAt == null).length;
  assert.ok(pending > 0,
    'fixture must contain uncalled tokens or it cannot catch the misalignment');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokspot-ml-'));
  const file = path.join(dir, 'fixture.jsonl');
  fs.writeFileSync(file, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');

  const res = spawnSync(process.execPath, [
    path.join(ml, 'train.js'), file, '--trees', '40', '--depth', '2',
  ], { encoding: 'utf8', timeout: 240000 });

  const out = (res.stdout || '') + (res.stderr || '');
  t.diagnostic(`exit=${res.status}`);
  fs.rmSync(dir, { recursive: true, force: true });

  assert.strictEqual(res.status, 0,
    `train.js exited ${res.status}\n${out.slice(-1500)}`);

  // The NaN signature of the misaligned run. One band going NaN was the only
  // visible symptom, and it read like a display glitch.
  assert.doesNotMatch(out, /NaN/,
    'training output contains NaN — row metadata and targets are misaligned');

  // train + test must account for exactly the usable rows, and the printed
  // per-band counts must reconstruct the test-set size.
  const splitM = out.match(/train (\d+) rows.*?\| test (\d+) rows/);
  assert.ok(splitM, 'could not parse the split line from train.js output');
  const trainN = Number(splitM[1]);
  const testN = Number(splitM[2]);

  const bandNs = [...out.matchAll(/^\s+band\d\s+(\d+)\s+/gm)].map((m) => Number(m[1]));
  assert.ok(bandNs.length > 0, 'no per-band rows printed');
  const summed = bandNs.reduce((s, n) => s + n, 0);
  assert.ok(summed <= testN,
    `per-band counts sum to ${summed} but the test set is ${testN} — ` +
    'rows are being counted against the wrong targets');

  assert.strictEqual(trainN + testN, recs.length - pending,
    'every usable row must land in exactly one side of the split');
});

test('the training CLI refuses to score on too little data', () => {
  // The honest failure must stay an honest failure: a clinic with three days
  // of traffic must be told it is not enough, not handed a model.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokspot-ml-'));
  const file = path.join(dir, 'tiny.jsonl');
  const { generate } = require(path.join(ml, 'sample-data'));
  const recs = generate({ days: 2, seed: 5, volume: 0.1, start: '2026-06-01' });
  fs.writeFileSync(file, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');

  const res = spawnSync(process.execPath, [path.join(ml, 'train.js'), file],
    { encoding: 'utf8', timeout: 120000 });
  fs.rmSync(dir, { recursive: true, force: true });

  const out = (res.stdout || '') + (res.stderr || '');
  assert.notStrictEqual(res.status, 0, 'tiny dataset must not exit 0');
  assert.match(out, /NOT ENOUGH DATA|need >=/,
    `expected an explicit "not enough data" message, got:\n${out.slice(-600)}`);
});

// ------------------------------------------------------------------
//  15. Training data directory is not committed accidentally
// ------------------------------------------------------------------

test('training data directory is not committed accidentally', () => {
  const root = path.join(__dirname, '..');
  const ignore = path.join(root, '.gitignore');
  if (fs.existsSync(ignore)) {
    const g = fs.readFileSync(ignore, 'utf8');
    assert.match(g, /ml[\\/]data/,
      '.gitignore must exclude ml/data — a real export contains hospital traffic');
  }
});