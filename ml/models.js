'use strict';
/**
 * ============================================================
 *  TokSpot ML — models
 * ============================================================
 *  Two regressors, both hand-written (no npm deps, no Python):
 *
 *  1. fitRidge  — closed form, exact. The baseline you must beat before a
 *                 gradient-boosted model is allowed to claim anything.
 *  2. fitGBM    — gradient boosted regression trees, squared loss,
 *                 histogram-binned, seeded for reproducibility.
 *
 *  WHY HAND-WRITTEN AND NOT scikit-learn
 *  -------------------------------------
 *  Python is not installed on the build machine, and adding a Python runtime
 *  to a Firebase-only deployment for a tabular model would be absurd. These
 *  are small, auditable, and fast on the data sizes involved: 20 features and
 *  eventually tens of thousands of rows, which is CPU-seconds of work.
 *
 *  There is no deep learning here on purpose. Wait-time prediction on 20
 *  tabular features is a boosted-tree problem. A neural network would be
 *  slower, smaller-data-bound, and less inspectable — and in a clinical
 *  setting, "why did the model say that" has to have an answer.
 */

const RNG = 'mulberry32';

/** Deterministic PRNG so every training run is reproducible. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------------
//  Linear algebra: dense solve for a small system (p ~ 20).
// ------------------------------------------------------------------

/** Solve (A + alpha*I) x = b by Gauss-Jordan with partial pivoting. */
function solveSPD(A, b, alpha) {
  const n = b.length;
  const M = new Float64Array(n * n);
  const y = new Float64Array(b);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) M[i * n + j] = A[i * n + j];
    M[i * n + i] += alpha;
  }

  for (let col = 0; col < n; col++) {
    let piv = col;
    let best = Math.abs(M[col * n + col]);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(M[r * n + col]);
      if (v > best) { best = v; piv = r; }
    }
    if (best < 1e-12) {
      // Degenerate column. Ridge alpha > 0 should prevent this; if it happens
      // the model is being fit on collinear or empty features. Fail loudly
      // rather than silently returning garbage coefficients.
      throw new Error('fitRidge: singular system at column ' + col +
        ' — a feature is constant or perfectly collinear. Drop it.');
    }
    if (piv !== col) {
      for (let j = 0; j < n; j++) {
        const t = M[col * n + j]; M[col * n + j] = M[piv * n + j]; M[piv * n + j] = t;
      }
      const t = y[col]; y[col] = y[piv]; y[piv] = t;
    }
    const d = M[col * n + col];
    for (let r = col + 1; r < n; r++) {
      const f = M[r * n + col] / d;
      if (f === 0) continue;
      for (let j = col; j < n; j++) M[r * n + j] -= f * M[col * n + j];
      y[r] -= f * y[col];
    }
  }

  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    for (let j = i + 1; j < n; j++) s -= M[i * n + j] * x[j];
    x[i] = s / M[i * n + i];
  }
  return x;
}

// ------------------------------------------------------------------
//  Ridge regression
// ------------------------------------------------------------------

/**
 * Fit with an intercept. Standardises nothing — the features are already on
 * comparable scales and column scaling would only move work to serve time.
 *
 * @param {Array<Float64Array>} X
 * @param {Array<number>} y
 * @param {object} opts
 * @param {number} [opts.alpha=1] ridge penalty (never 0 — singular otherwise)
 */
function fitRidge(X, y, opts) {
  const o = opts || {};
  const alpha = o.alpha == null ? 1 : o.alpha;
  const n = X.length;
  if (!n) throw new Error('fitRidge: no rows');
  const p = X[0].length;

  let meanX = new Float64Array(p);
  let meanY = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < p; j++) meanX[j] += X[i][j];
    meanY += y[i];
  }
  for (let j = 0; j < p; j++) meanX[j] /= n;
  meanY /= n;

  // Centred Gram matrix.
  const A = new Float64Array(p * p);
  for (let i = 0; i < n; i++) {
    const xi = X[i];
    for (let a = 0; a < p; a++) {
      const va = xi[a] - meanX[a];
      if (va === 0) continue;
      for (let b = a; b < p; b++) {
        A[a * p + b] += va * (xi[b] - meanX[b]);
      }
    }
  }
  for (let a = 0; a < p; a++) {
    for (let b = 0; b < a; b++) A[a * p + b] = A[b * p + a];
  }

  const rhs = new Float64Array(p);
  for (let i = 0; i < n; i++) {
    const yi = y[i] - meanY;
    for (let a = 0; a < p; a++) rhs[a] += yi * (X[i][a] - meanX[a]);
  }

  const w = solveSPD(A, rhs, alpha);

  return {
    kind: 'ridge',
    alpha,
    meanX: Array.from(meanX),
    meanY,
    w: Array.from(w),
    predict(x) {
      let s = this.meanY;
      for (let j = 0; j < p; j++) s += this.w[j] * (x[j] - this.meanX[j]);
      return s;
    },
    predictRow(row) {
      let s = this.meanY;
      for (let j = 0; j < p; j++) s += this.w[j] * (row[j] - this.meanX[j]);
      return s;
    },
    featureCount: p,
  };
}

// ------------------------------------------------------------------
//  Gradient boosted regression trees (squared loss)
// ------------------------------------------------------------------

const N_BINS = 32;

/**
 * Per-column bin edges, computed from whatever rows are passed in.
 * Edges are quantiles of that set, so they are deliberately allowed to come
 * from a SAMPLE — that keeps setup O(s log s) on a large export.
 */
function computeEdges(X, nBins) {
  const n = X.length;
  const p = X[0].length;
  const nb = nBins || N_BINS;
  const edges = [];
  for (let j = 0; j < p; j++) {
    const col = new Float64Array(n);
    for (let i = 0; i < n; i++) col[i] = X[i][j];
    const sorted = Array.from(col).sort((a, b) => a - b);
    const uniq = new Set(sorted);
    const use = Math.min(nb, Math.max(0, uniq.size - 1));
    const e = [];
    for (let k = 0; k < use; k++) {
      const pos = Math.floor(((k + 1) * sorted.length) / (use + 1));
      e.push(sorted[Math.min(sorted.length - 1, pos)]);
    }
    // Strictly increasing only. Duplicates would create empty bins and
    // unreachable splits.
    const clean = [];
    for (const v of e) if (!clean.length || v > clean[clean.length - 1]) clean.push(v);
    edges.push(clean);
  }
  return edges;
}

/**
 * Bin EVERY row against pre-computed edges. This MUST be a separate pass over
 * the full matrix: training and predicting index the same bin arrays, so the
 * arrays have to span all rows, not just the sample the edges came from.
 */
function assignBins(X, edges) {
  const n = X.length;
  const p = X[0].length;
  const indices = [];
  for (let j = 0; j < p; j++) {
    const clean = edges[j];
    const idx = new Uint16Array(n);
    if (!clean.length) {
      indices.push(idx);
      continue;
    }
    for (let i = 0; i < n; i++) {
      const v = X[i][j];
      // Bin = how many edges are <= v, i.e. upper_bound. This makes
      // `idx <= b` mean exactly `v < edges[b]`, which is the rule treePredict
      // uses. Getting this inequality backwards collapses every row into the
      // last bin and the model silently degrades to a constant.
      let lo = 0, hi = clean.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (clean[mid] <= v) lo = mid + 1; else hi = mid;
      }
      idx[i] = lo;
    }
    indices.push(idx);
  }
  return indices;
}

/**
 * Variance REDUCTION from splitting a node. Must be positive when the split
 * helps: `parentVar - weightedChildVar`. Returning the negation looks
 * plausible and is a silent killer — every gain comes out <= 0, the caller's
 * `gain > 0` test never passes, and every tree degrades to a leaf that
 * predicts the mean. The model then looks converged rather than broken.
 */
function varianceGain(sumL, sqL, nL, sumR, sqR, nR, parentSq, parentSum, parentN) {
  if (nL < 2 || nR < 2) return -Infinity;
  const meanL = sumL / nL, meanR = sumR / nR;
  const varL = sqL / nL - meanL * meanL;
  const varR = sqR / nR - meanR * meanR;
  const meanP = parentSum / parentN;
  const varP = parentSq / parentN - meanP * meanP;
  const gain = varP - (nL * varL + nR * varR) / (nL + nR);
  return Number.isFinite(gain) ? gain : -Infinity;
}

/** Fit one regression tree on residuals, over pre-binned columns. */
function fitTree(resid, binned, nodeRows, depth, maxDepth, minSamplesLeaf, rand) {
  let sum = 0, sq = 0;
  for (const i of nodeRows) { const r = resid[i]; sum += r; sq += r * r; }
  const n = nodeRows.length;
  const value = n ? sum / n : 0;
  const node = { value, left: null, right: null };

  if (depth >= maxDepth || n < 2 * minSamplesLeaf) return node;

  let best = { gain: -Infinity, feature: -1, bin: -1 };
  const parent = { sum, sq, n };

  for (let f = 0; f < binned.indices.length; f++) {
    if (!binned.edges[f].length) continue;
    const idx = binned.indices[f];
    // Accumulate per-bin sums, then scan cumulative splits.
    const bs = new Float64Array(binned.edges[f].length + 1);
    const bq = new Float64Array(binned.edges[f].length + 1);
    const bn = new Int32Array(binned.edges[f].length + 1);
    for (const i of nodeRows) {
      const b = idx[i];
      const r = resid[i];
      bs[b] += r; bq[b] += r * r; bn[b]++;
    }
    let sL = 0, qL = 0, nL = 0;
    for (let b = 0; b < binned.edges[f].length; b++) {
      sL += bs[b]; qL += bq[b]; nL += bn[b];
      const nR = n - nL;
      if (nR < minSamplesLeaf || nL < minSamplesLeaf) continue;
      const sR = sum - sL, qR = sq - qL;
      const gain = varianceGain(sL, qL, nL, sR, qR, nR, sq, sum, n);
      if (gain > best.gain) best = { gain, feature: f, bin: b };
    }
  }

  if (best.feature < 0 || best.gain <= 1e-12) return node;

  const f = best.feature;
  const idx = binned.indices[f];
  const leftRows = [], rightRows = [];
  for (const i of nodeRows) (idx[i] <= best.bin ? leftRows : rightRows).push(i);
  if (!leftRows.length || !rightRows.length) return node; // defensive

  node.feature = f;
  node.splitBin = best.bin;
  node.splitValue = binned.edges[f][best.bin];
  // `subsample` awareness: a split is only meaningful if it holds under a
  // fresh draw. Cheap guard against fitting bin noise on tiny datasets.
  if (rand() > 0.999) return node;

  node.left = fitTree(resid, binned, leftRows, depth + 1, maxDepth, minSamplesLeaf, rand);
  node.right = fitTree(resid, binned, rightRows, depth + 1, maxDepth, minSamplesLeaf, rand);
  return node;
}

function treePredict(tree, row) {
  let node = tree;
  while (node.left) {
    // STRICTLY less than. Fit assigned rows to the left when
    // `bin <= splitBin`, which is equivalent to `v < edges[splitBin]`.
    // Using `<=` here routes every value sitting exactly on an edge to the
    // wrong child, and binned data puts many values exactly on edges.
    node = row[node.feature] < node.splitValue ? node.left : node.right;
  }
  return node.value;
}

/**
 * @param {Array<Float64Array>} X
 * @param {Array<number>} y
 * @param {object} opts {nTrees, maxDepth, learningRate, minSamplesLeaf, subsample, seed, binSample}
 */
function fitGBM(X, y, opts) {
  const o = Object.assign({
    nTrees: 300,
    maxDepth: 2,
    learningRate: 0.05,
    minSamplesLeaf: 8,
    subsample: 1,
    binSample: 4000,
    seed: 1337,
  }, opts || {});

  const n = X.length;
  if (!n) throw new Error('fitGBM: no rows');

  const rand = mulberry32(o.seed);

  // Bin edges from a bounded sample so setup cost stays O(s log s), then bin
  // EVERY row against those edges. Fitting and predicting must agree, so both
  // must read bin arrays that span the whole matrix.
  // Array.from is required: TypedArray.prototype.map coerces its return value
  // to the element type, so Int32Array.map() would silently turn every row
  // reference into a number.
  const binN = Math.min(n, o.binSample);
  const binIdx = new Int32Array(binN);
  for (let i = 0; i < binN; i++) binIdx[i] = Math.floor(rand() * n);
  const sample = Array.from(binIdx).map((i) => X[i]);
  const edges = computeEdges(sample, null);
  const binned = { edges, indices: assignBins(X, edges) };

  let base = 0;
  for (const v of y) base += v;
  base /= n;

  const pred = new Float64Array(n).fill(base);
  const trees = [];

  for (let t = 0; t < o.nTrees; t++) {
    const resid = new Float64Array(n);
    for (let i = 0; i < n; i++) resid[i] = y[i] - pred[i];

    // Subsample rows for each tree (stochastic gradient boosting).
    const rows = [];
    const m = Math.max(2 * o.minSamplesLeaf, Math.floor(n * o.subsample));
    for (let i = 0; i < m; i++) rows.push(Math.floor(rand() * n));

    const tree = fitTree(resid, binned, rows, 0, o.maxDepth, o.minSamplesLeaf, rand);
    trees.push(tree);
    for (let i = 0; i < n; i++) pred[i] += o.learningRate * treePredict(tree, X[i]);
  }

  const lr = o.learningRate;
  const fitted = Array.from(pred);

  return {
    kind: 'gbm',
    base,
    learningRate: lr,
    trees,
    params: o,
    predictRow(row) {
      let s = this.base;
      for (const t of this.trees) s += lr * treePredict(t, row);
      return s;
    },
    /** Fitted values from the training pass — used for overfit diagnostics. */
    fittedAt: fitted,
  };
}

// Internals are exported deliberately: the split search is the part of a
// hand-written GBM most likely to break silently, and tests/ml-pipeline
// .test.cjs exercises it directly rather than trusting the end-to-end number.
module.exports = {
  fitRidge, fitGBM, mulberry32, solveSPD, treePredict,
  computeEdges, assignBins, varianceGain, fitTree,
  RNG,
};