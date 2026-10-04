# TokSpot ML — patient-flow prediction

Predicts how long a patient will wait, from information available **at the
moment their token is issued**.

```
node ml\selftest.js                        # prove the pipeline works (synthetic data)
node ml\export.js --slug <hospital>        # Firestore -> PHI-free JSONL
node ml\train.js ml\data\x.jsonl --save ml\data\model.json
```

## Current state: NO DATA, NO TRAINED MODEL

This directory contains the pipeline, not a model. Nothing here has been fitted
to real hospital traffic, because **the live database is empty** — zero
hospitals, zero tokens. `ml\train.js` exits non-zero rather than producing a
model from nothing, which is the correct behaviour and not a bug.

The pipeline is proven end-to-end on synthetic data where the answer is known
by construction (`ml\selftest.js`, all checks passing). That proves the maths,
the leakage guard, and — the one that matters — that the evaluation harness
**refuses to approve a model fitted to noise**.

## Why this model and not the doctor copilot

Of everything in the product brief, wait-time and volume prediction is the only
AI that can be built with what TokSpot already records:

| AI feature | Needs clinical records? | Status |
|---|---|---|
| Wait-time prediction | No — timestamps only | **Pipeline built, needs data** |
| Busy-hour / staffing forecast | No — timestamps only | Same pipeline, second target |
| Doctor copilot (history, labs, medicines) | Yes | Blocked: no patient records exist |
| Medical scribe / medication safety | Yes | Blocked, and needs clinical validation |

Wait prediction touches **no patient identity**. No names, no phones, no
prescriptions. That means no consent surface, no DPDP exposure, and nothing
leaves the hospital — which is the constraint that makes it shippable at all.

## Why Node, not Python

Python is not installed on this build machine (the `python` on PATH is a
Microsoft Store stub), and adding a Python runtime to a Firebase-only
deployment to fit a 20-feature tabular model would be absurd. `ml\models.js` is
~200 lines of hand-written ridge regression and gradient-boosted trees. No
dependencies, no install step, trains in about a second, CPU only.

There is no neural network here on purpose. Wait prediction on 20 tabular
features is a boosted-tree problem. A network would be slower, more
data-hungry, and — in a clinic — unanswerable when a doctor asks why the
number was 40 minutes.

## The rules the code enforces

**1. No leakage.** Every feature is computable at issuance. If a future edit
adds something only knowable after the patient is served,
`assertNoLeakage()` throws at the start of training. This is the single most
expensive mistake available in this domain: the model scores beautifully
offline, ships, and is worthless in the clinic. `medianWaitSoFar` averages
only waits that had **already completed** when that token was printed — pinned
by a test.

**2. Time-ordered splits only.** Never random. Shuffling puts tomorrow's
behaviour into the training set and reports a number that will never happen
again. `timeSplit()` sorts by issuance time and holds the future out,
regardless of the order rows arrive in.

**3. A baseline or it doesn't ship.** `ml\train.js` always prints a persistence
heuristic (median wait for this time-of-day × weekday/weekend) beside the
models. A model that cannot beat a two-line whiteboard calculation is not
worth showing a doctor. Best model must beat it by ≥5% MAE or the CLI
**exits 1**.

**4. PHI-free by construction.** `ml\export.js` projects tokens onto an
allowlist of six operational fields. Names and phones are never read, so they
cannot leak. `assertNoPhi()` re-checks the written file, and a test asserts the
denylist covers every identifying field `js\api.js` actually writes. Real
extracts live in `ml\data/`, which is gitignored.

**5. Honest slicing.** A model can look good overall and be wrong every
evening. OPD load is bimodal, so the CLI prints per-time-band MAE for every
run, and no model ships on an overall number alone.

## Files

| File | What it is |
|---|---|
| `features.js` | Feature extraction, dataset builder, leakage guard |
| `models.js` | Ridge + gradient-boosted trees, hand-written |
| `evaluate.js` | Baselines, metrics, time-ordered split, per-slice reporting |
| `train.js` | CLI. Trains, compares to baseline, **exits non-zero if it fails** |
| `export.js` | Firestore → PHI-free JSONL |
| `selftest.js` | Synthetic-OPD proof, including the noise rejection test |

Tests: `tests\ml-pipeline.test.cjs` (30).

## When real data arrives

1. Export with `ml\export.js`. It will warn if you have under 5 distinct days.
2. Train. If it exits 3, there is not enough completed traffic yet — that is
   the honest answer, not a failure to debug.
3. Read the per-time-band table before believing anything.
4. Do not surface a number to a patient until it has beaten the baseline on
   the evening band specifically.

Minimum viable signal is roughly 200 completed waits across 5+ days. A
trustworthy number wants 3–4 weeks, because a time-ordered split over two
weeks cannot separate "recurring pattern" from "last Tuesday was weird".