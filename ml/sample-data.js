'use strict';
/**
 * ============================================================
 *  TokSpot ML — synthetic sample data generator
 * ============================================================
 *  Writes a JSONL file in EXACTLY the format ml\export.js produces, so the
 *  training path can be exercised end-to-end before any real data exists.
 *
 *      node ml\sample-data.js                      # 45 days, default shape
 *      node ml\sample-data.js --days 90 --out f.jsonl
 *
 *  READ THIS BEFORE TRUSTING ANY OUTPUT
 *  ------------------------------------
 *  A model trained on this file learns NOTHING about real patients. It is
 *  useful for exactly three things:
 *
 *    1. Proving the format is right, so real data drops straight in.
 *    2. Seeing what a training report looks like before betting on one.
 *    3. Timing the trainer on a realistic row count.
 *
 *  It is NOT useful for:
 *    - showing a predicted wait time to a doctor
 *    - validating that the features are the right ones
 *    - anything at all that touches a patient
 *
 *  The filename is deliberately prefixed SYNTHETIC-DEMO so it is impossible to
 *  mistake for a real extract at a glance.
 *
 *  The wait law is deliberately not simple. Real OPD flow is bimodal, has a
 *  queue-depth penalty that grows faster than linearly, doctors with
 *  different throughput, abandoned tokens, and a slow drift across weeks. A
 *  generator that made wait a straight line would let a broken trainer look
 *  correct.
 */

const fs = require('fs');
const path = require('path');
const { mulberry32 } = require('./models');

function parseArgs(argv) {
  const o = { days: 45, seed: 20261004, out: null, volume: 1, start: '2026-06-01' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--days') o.days = Number(argv[++i]);
    else if (a === '--seed') o.seed = Number(argv[++i]);
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--volume') o.volume = Number(argv[++i]);
    else if (a === '--start') o.start = argv[++i];
  }
  return o;
}

/**
 * @param {object} o
 * @returns {Array<object>} token records in export.js field order
 */
function generate(o) {
  const rand = mulberry32(o.seed);
  const start = new Date(o.start + 'T00:00:00').getTime();
  const DAY = 86400000;

  // Three doctors with different throughput, as a real OPD has.
  const DOCTORS = [
    { id: 'dr-subramanian', counter: 'Room 1', dept: 'General', perMin: 1 / 6.5 },
    { id: 'dr-lakshmi', counter: 'Room 2', dept: 'General', perMin: 1 / 8.0 },
    { id: 'dr-pediatrics', counter: 'Room 3', dept: 'Paediatrics', perMin: 1 / 10.0 },
  ];

  const records = [];

  for (let d = 0; d < o.days; d++) {
    const dayStart = start + d * DAY;
    const dow = new Date(dayStart).getDay();
    const isWeekend = dow === 0 || dow === 6;

    // Weekends are quieter. Mondays are the worst day in every OPD I have
    // seen — people who could not come Saturday all pile in on Monday.
    let base = isWeekend ? 26 : 74;
    if (dow === 1) base *= 1.22;
    const volume = Math.max(4, Math.round((base + rand() * 22) * o.volume));

    // Arrivals: mixture of two normals (late-morning peak, evening peak),
    // truncated to a working day.
    const arrivals = [];
    for (let i = 0; i < volume; i++) {
      const isMorning = rand() < (isWeekend ? 0.5 : 0.63);
      const mu = isMorning ? 10.6 : 17.9;
      const sd = isMorning ? 1.15 : 1.35;
      // Irwin-Hall approximation to N(0,1)
      const g = (rand() + rand() + rand() + rand() + rand() + rand() - 3) / 1.2247;
      arrivals.push(Math.max(8.5, Math.min(20.6, mu + g * sd)));
    }
    arrivals.sort((a, b) => a - b);

    // Assignment: paediatrics pulls a slice of the morning traffic.
    const assign = [];
    for (let i = 0; i < volume; i++) {
      const r = rand();
      assign.push(r < 0.16 ? DOCTORS[2] : (r < 0.58 ? DOCTORS[0] : DOCTORS[1]));
    }

    const laneDepth = [0, 0, 0];
    let seq = 0;

    for (let i = 0; i < arrivals.length; i++) {
      const doc = assign[i];
      const lane = DOCTORS.indexOf(doc);
      const hourF = arrivals[i];

      const createdAt = dayStart + Math.round(hourF * 60) * 60000;

      // People drifting later across weeks — a slow seasonal drift that a
      // model with no month feature cannot see.
      const drift = (d / o.days) * 4;

      // Service: this patient's own lane backlog, plus the cross-lane pressure
      // of the department (nobody cares which room you are in when the OPD
      // is full).
      const ownLane = laneDepth[lane] * doc.perMin;
      const deptDepth = (arrivals.length - i) * 0.11;
      const quadratic = 0.0055 * Math.pow(arrivals.length - i, 2) * 0.35;
      let waitMin = ownLane + deptDepth + quadratic + drift;

      const inPeak = (hourF > 10 && hourF < 12.5) || (hourF > 17 && hourF < 19.5);
      if (inPeak) waitMin += 4 + rand() * 3.5;

      // Measurement noise: real clocks, real human timing.
      waitMin *= 1 + 0.11 * (rand() - 0.5) * 2;

      seq++;
      const priority = rand() < 0.07;

      // Priority patients are pulled forward, which is the point of priority.
      if (priority) waitMin = Math.max(0.5, waitMin * 0.35);

      const abandoned = rand() < 0.045;
      const calledAt = abandoned ? null : createdAt + Math.round(waitMin * 60000);

      records.push({
        createdAt,
        calledAt,
        doctorId: doc.id,
        counter: doc.counter,
        status: calledAt ? 'completed' : 'waiting',
        priority,
      });

      laneDepth[lane] = Math.max(0, laneDepth[lane] + (abandoned ? 1 : 0));
    }
  }

  records.sort((a, b) => a.createdAt - b.createdAt);
  return records;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const records = generate(args);

  const out = args.out
    || path.join(__dirname, 'data', 'SYNTHETIC-DEMO-tokens.jsonl');

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, records.map((r) => JSON.stringify(r)).join('\n') + '\n');

  const called = records.filter((r) => r.calledAt != null).length;
  const days = new Set(records.map((r) => Math.floor(r.createdAt / 86400000))).size;
  const waits = records.filter((r) => r.calledAt != null)
    .map((r) => (r.calledAt - r.createdAt) / 60000).sort((a, b) => a - b);
  const p = (q) => waits[Math.min(waits.length - 1, Math.floor(q * waits.length))];

  console.log('='.repeat(64));
  console.log('SYNTHETIC DEMO DATA — NOT REAL PATIENTS');
  console.log('='.repeat(64));
  console.log(`file        ${path.resolve(out)}`);
  console.log(`records     ${records.length}`);
  console.log(`called      ${called}  (wait target usable on these)`);
  console.log(`pending     ${records.length - called}`);
  console.log(`days        ${days}`);
  console.log(`doctors     3`);
  console.log('');
  console.log(`wait minutes  p10=${p(0.1).toFixed(1)}  median=${p(0.5).toFixed(1)}  p90=${p(0.9).toFixed(1)}  max=${p(0.999).toFixed(1)}`);
  console.log('');
  console.log('This proves the FORMAT and the pipeline. A model fitted to it has');
  console.log('learned nothing about real patients and must never be shown to one.');
  console.log('');
  console.log('Next:');
  console.log('  node ml\\train.js "' + path.relative(process.cwd(), out) + '" --save ml\\data\\DEMO-model.json');
  console.log('='.repeat(64));
}

if (require.main === module) main();

module.exports = { generate };