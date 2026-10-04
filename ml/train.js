'use strict';
/**
 * ============================================================
 *  TokSpot ML — training CLI
 * ============================================================
 *  Usage:
 *     node ml\train.js path\to\tokens.jsonl
 *     type tokens.jsonl | node ml\train.js -
 *
 *  Expected input — ONE JSON TOKEN PER LINE, exported PHI-free by
 *  ml\export.js. Only these keys are read:
 *
 *     { createdAt, calledAt, doctorId, counter, status, priority }
 *
 *  createdAt / calledAt are EPOCH MILLIS. Firestore Timestamps must be
 *  converted at export time — a raw {_seconds,_nanoseconds} object would
 *  silently yield NaN features.
 *
 *  WHAT THIS PROGRAM REFUSES TO DO
 *  -------------------------------
 *  1. Run a random split. Rows are split by issuance time, future held out.
 *  2. Report a number without the heuristic it beat. A model with no
 *     baseline next to it is indistinguishable from a model that learned
 *     nothing.
 *  3. Exit 0 when the model does not earn its place. If the best model fails
 *     to beat the persistence heuristic by the ship threshold, this exits
 *     NON-ZERO. A training run that quietly produces a bad model is the
 *     single most expensive thing in an ML pipeline.
 */

const fs = require('fs');
const path = require('path');

const { buildDataset, buildVocabulary, toMatrix, rowsWithTarget, assertNoLeakage, FEATURES, CATEGORICALS } = require('./features');
const { fitRidge, fitGBM } = require('./models');
const { fitBaseline, timeSplit, evaluate, improvement, report, mean, SHIP_THRESHOLD_PCT } = require('./evaluate');

// ------------------------------------------------------------------

function parseArgs(argv) {
  const o = { file: null, testFraction: 0.25, nTrees: 300, maxDepth: 2, seed: 1337, alpha: 1, save: null, minRows: 200 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file' || a === '-f') o.file = argv[++i];
    else if (a === '--test-fraction') o.testFraction = Number(argv[++i]);
    else if (a === '--trees') o.nTrees = Number(argv[++i]);
    else if (a === '--depth') o.maxDepth = Number(argv[++i]);
    else if (a === '--seed') o.seed = Number(argv[++i]);
    else if (a === '--alpha') o.alpha = Number(argv[++i]);
    else if (a === '--save') o.save = argv[++i];
    else if (a === '--min-rows') o.minRows = Number(argv[++i]);
    else if (!a.startsWith('-') && !o.file) o.file = a;
  }
  return o;
}

function readJsonl(file) {
  const raw = file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(file, 'utf8');
  const out = [];
  let bad = 0;
  raw.split(/\r?\n/).forEach((line, n) => {
    const s = line.trim();
    if (!s) return;
    try {
      out.push(JSON.parse(s));
    } catch (e) {
      bad++;
      if (bad <= 3) console.error(`  ! skipping line ${n + 1}: ${e.message}`);
    }
  });
  if (bad) console.error(`  ! skipped ${bad} unparseable line(s)`);
  return out;
}

function fmt(v, d) { return Number(v).toFixed(d == null ? 2 : d); }

function printMetrics(label, m, indent) {
  const p = indent || '  ';
  console.log(`${p}${label}`);
  console.log(`${p}  n=${m.n}  MAE=${fmt(m.mae)}m  RMSE=${fmt(m.rmse)}m  medAE=${fmt(m.medianAbsErr)}m  p90AE=${fmt(m.p90AbsErr)}m`);
  console.log(`${p}  actual mean=${fmt(m.actualMean)}m   predicted mean=${fmt(m.predMean)}m`);
}

// ------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.file) {
    console.error('Usage: node ml\\train.js <tokens.jsonl|-> [--save model.json] [--trees N] [--depth D]');
    process.exit(2);
  }

  console.log('TokSpot ML — training patient-flow wait model');
  console.log('='.repeat(64));

  // ---- load -----------------------------------------------------
  const raw = readJsonl(args.file);
  console.log(`\n[load] ${raw.length} token record(s) from ${args.file}`);

  if (!raw.length) {
    console.error('\nNo data. Nothing to train. Export real tokens first.');
    process.exit(2);
  }

  // A Firestore Timestamp that made it through unconverted is the single
  // most likely cause of a silently-broken dataset, so check before building.
  const sample = raw.find((r) => r && r.createdAt != null);
  if (sample && typeof sample.createdAt !== 'number') {
    console.error(`\ncreatedAt must be epoch millis, got ${typeof sample.createdAt}: ${JSON.stringify(sample.createdAt).slice(0, 80)}`);
    console.error('Convert Firestore Timestamps at export time. Refusing to train on unconvertible data.');
    process.exit(2);
  }

  // ---- guard ----------------------------------------------------
  assertNoLeakage(FEATURES.concat(CATEGORICALS));

  // ---- features -------------------------------------------------
  const { rows, stats } = buildDataset(raw, { minWaitMinutes: 0 });
  console.log('\n[dataset]');
  for (const [k, v] of Object.entries(stats)) console.log(`  ${k.padEnd(16)} ${v}`);
  if (stats.tokensIn !== stats.rowsOut) {
    console.log(`  (${stats.tokensIn - stats.rowsOut} token(s) dropped for a missing createdAt)`);
  }

  const usable = rows.filter((r) => Number.isFinite(r.waitMinutes));
  console.log(`\n[target] waitMinutes available on ${usable.length} row(s); ` +
    `${rows.length - usable.length} pending (issued, not yet called — expected at the end of a day)`);

  if (usable.length < args.minRows) {
    console.error(`\nNOT ENOUGH DATA. ${usable.length} completed waits, need >= ${args.minRows}.`);
    console.error('This is the honest failure, not a bug. Flow prediction needs weeks of');
    console.error('real OPD traffic before it means anything. Keep collecting tokens.');
    process.exit(3);
  }

  const days = new Set(rows.map((r) => Math.floor(r.issuedAtMs / 86400000))).size;
  if (days < 5) {
    console.warn(`\n[warn] only ${days} distinct day(s) of history. A time-ordered split over`);
    console.warn(`       <5 days cannot separate "recurring weekly pattern" from "today".`);
  }

  // ---- time-ordered split ---------------------------------------
  // Filter to rows that actually have a target BEFORE splitting. toMatrix
  // drops null-target rows internally; splitting first would leave `test`
  // longer than `E.y` and silently pair every row with the wrong target —
  // including the baseline's score, which is what gates the ship decision.
  const usableRows = rowsWithTarget(rows, 'waitMinutes');
  const { train, test } = timeSplit(usableRows, args.testFraction);
  const vocab = buildVocabulary(train);          // vocab from TRAIN only
  const T = toMatrix(train, vocab, 'waitMinutes');
  const E = toMatrix(test, vocab, 'waitMinutes');

  // Alignment is now an invariant, not an assumption. Assert it rather than
  // trusting it: a future edit that reintroduces the filter-late bug should
  // stop here with a clear message instead of reporting a plausible number.
  if (train.length !== T.n || test.length !== E.n) {
    console.error(
      '\nMISALIGNED SPLIT — train rows ' + train.length + ' vs targets ' + T.n +
      ', test rows ' + test.length + ' vs targets ' + E.n + '.'
    );
    console.error('Row metadata and targets must be filtered together. Refusing to report scores.');
    process.exit(4);
  }

  if (!T.n || !E.n) {
    console.error(`\nSplit produced train=${T.n} / test=${E.n} usable rows. Widen the date range.`);
    process.exit(3);
  }

  const spanDays = (train[train.length - 1].issuedAtMs - train[0].issuedAtMs) / 86400000;
  console.log(`\n[split] TIME-ORDERED — train ${T.n} rows (${fmt(spanDays, 1)}d) ` +
    `| test ${E.n} rows (the future)`);
  console.log(`        categorical vocabulary built from train only: ` +
    Object.keys(vocab).map((k) => `${k}=${vocab[k].__size}`).join(' '));

  // ---- fit ------------------------------------------------------
  console.log('\n[fit]');
  const baseline = fitBaseline(train);
  const ridge = fitRidge(T.X, T.y, { alpha: args.alpha });
  const gbm = fitGBM(T.X, T.y, {
    nTrees: args.nTrees, maxDepth: args.maxDepth, seed: args.seed, learningRate: 0.05,
  });
  console.log(`  ridge  alpha=${args.alpha}`);
  console.log(`  gbm    trees=${args.nTrees} depth=${args.maxDepth} lr=0.05 seed=${args.seed}`);

  // ---- evaluate on the held-out future --------------------------
  console.log('\n[test-set performance]  (future tokens, never seen in training)');

  const baseE = evaluate(E.y, E.X.map((x, i) => baseline.predictRow(test[i])));
  const ridgeE = evaluate(E.y, E.X.map((x) => ridge.predictRow(x)));
  const gbmE = evaluate(E.y, E.X.map((x) => gbm.predictRow(x)));

  printMetrics('BASELINE  persistence (median wait for this time band)', baseE);
  printMetrics('MODEL     ridge regression', ridgeE);
  printMetrics('MODEL     gradient boosted trees', gbmE);

  const impRidge = improvement(ridgeE, baseE);
  const impGbm = improvement(gbmE, baseE);

  console.log('\n[verdict vs baseline]');
  console.log(`  ridge : ${impRidge.maePct == null ? 'n/a' : fmt(impRidge.maePct) + '% MAE reduction'} — ${impRidge.verdict}`);
  console.log(`  gbm   : ${impGbm.maePct == null ? 'n/a' : fmt(impGbm.maePct) + '% MAE reduction'} — ${impGbm.verdict}`);

  // Slices. Bimodal OPD load means an evening-only failure hides inside a
  // good overall number, so every band carries its own baseline. Printing the
  // baseline is not optional — a band where the model beats the overall MAE
  // but loses to the heuristic in that band is exactly the case that gets
  // shipped by accident.
  const predFns = {
    baseline: (x, r) => baseline.predictRow(r),
    ridge: (x) => ridge.predictRow(x),
    gbm: (x) => gbm.predictRow(x),
  };
  const slices = {};
  for (const [name, predict] of Object.entries(predFns)) {
    // In-sample fit is only meaningful for the fitted models, and only they
    // can be evaluated without row metadata. The baseline is a lookup keyed
    // on the row, so asking for its in-sample score would hand it undefined
    // rows and crash. Median heuristics have no train/test gap by definition.
    const fitted = name === 'ridge' || name === 'gbm';
    slices[name] = report({
      rows: test, X: E.X, y: E.y, predict, label: name,
      trainX: fitted ? T.X : undefined,
      trainY: fitted ? T.y : undefined,
    });
  }

  console.log('\n[by time band]  0=pre-OPD 1=morning peak 2=lull 3=evening peak 4=late');
  console.log('  band        n   baseline   ridge     gbm    ridge vs base   gbm vs base');
  const bands = slices.gbm.byTimeBand.map((b) => b.slice);
  for (const key of slices.ridge.byTimeBand.map((b) => b.slice)) {
    if (bands.indexOf(key) === -1) bands.push(key);
  }
  for (const key of bands) {
    const pick = (src) => src.byTimeBand.find((x) => x.slice === key);
    const bB = pick(slices.baseline), bR = pick(slices.ridge), bG = pick(slices.gbm);
    if (!bB || !bR || !bG) continue;
    const pct = (m) => (bB.mae ? (((bB.mae - m.mae) / bB.mae) * 100).toFixed(0) + '%' : 'n/a');
    console.log(
      `  ${key.padEnd(8)} ${String(bG.n).padStart(4)}   ` +
      `${fmt(bB.mae).padStart(6)}m ${fmt(bR.mae).padStart(6)}m ${fmt(bG.mae).padStart(6)}m` +
      `     ${pct(bR).padStart(8)}   ${pct(bG).padStart(8)}`
    );
  }

  // A model that wins overall but loses a band has not earned the number.
  const losingBands = [];
  for (const key of bands) {
    const bB = slices.baseline.byTimeBand.find((x) => x.slice === key);
    const bG = slices.gbm.byTimeBand.find((x) => x.slice === key);
    const bR = slices.ridge.byTimeBand.find((x) => x.slice === key);
    if (!bB || (!bG && !bR)) continue;
    const best = Math.min(bR ? bR.mae : Infinity, bG ? bG.mae : Infinity);
    if (Number.isFinite(best) && best > bB.mae) losingBands.push(key);
  }
  if (losingBands.length) {
    console.log(`\n  ! the model LOSES to the plain heuristic in: ${losingBands.join(', ')}`);
    console.log('    Do not show a predicted wait time to a patient in those bands.');
  }

  // ---- save -----------------------------------------------------
  let outPath = null;
  if (args.save) {
    const payload = {
      version: 1,
      trainedAt: new Date().toISOString(),
      target: 'waitMinutes',
      features: FEATURES,
      categoricals: CATEGORICALS,
      vocab,
      ridge: { kind: ridge.kind, alpha: ridge.alpha, meanX: ridge.meanX, meanY: ridge.meanY, w: ridge.w },
      gbm: {
        kind: gbm.kind, base: gbm.base, learningRate: gbm.learningRate,
        trees: gbm.trees, params: gbm.params,
      },
      eval: { baseline: baseE, ridge: ridgeE, gbm: gbmE, improvement: { ridge: impRidge, gbm: impGbm } },
      trainRows: T.n,
      testRows: E.n,
      stats,
    };
    fs.writeFileSync(args.save, JSON.stringify(payload));
    outPath = path.resolve(args.save);
    console.log(`\n[save] ${outPath}`);
  }

  // ---- exit status ----------------------------------------------
  const best = impGbm.maePct > (impRidge.maePct == null ? -Infinity : impRidge.maePct) ? impGbm : impRidge;
  const ship = best.maePct != null && best.maePct >= SHIP_THRESHOLD_PCT;

  console.log('\n' + '='.repeat(64));
  if (!ship) {
    console.log(`RESULT: do NOT ship. Best model is ${best.maePct == null ? 'unscored' : fmt(best.maePct) + '%'} vs the`);
    console.log(`        heuristic, below the ${SHIP_THRESHOLD_PCT}% threshold. Predicting the`);
    console.log('        time-band median is honest and probably better.');
    console.log('='.repeat(64));
    process.exit(1);
  }

  console.log(`RESULT: best model beats the heuristic by ${fmt(best.maePct)}% MAE.`);
  console.log('        Still verify the time-band slices above before showing this to a doctor.');
  console.log('='.repeat(64));
  process.exit(0);
}

main();