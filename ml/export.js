'use strict';
/**
 * ============================================================
 *  TokSpot ML — Firestore export
 * ============================================================
 *  Turns live token history into the PHI-free JSONL that ml\train.js reads.
 *
 *      node ml\export.js --slug kk-hospital [--out data\tokens.jsonl]
 *                        [--since 2026-01-01] [--project tokenonspot]
 *
 *  Requires a service-account key with Viewer on Firestore:
 *
 *      node ml\export.js --cred C:\path\to\service-account.json ...
 *
 *  or GOOGLE_APPLICATION_CREDENTIALS in the environment. Without credentials
 *  this exits non-zero and tells you so — it will not silently export nothing.
 *
 *  WHAT IS DELIBERATELY NOT EXPORTED
 *  ---------------------------------
 *  patientName, phone, and anything else identifying a person is stripped at
 *  the source, not filtered afterwards. Wait-time modelling does not need it,
 *  and a training file that has never contained a phone number cannot leak
 *  one. Build the allowlist into the writer, so the next person to extend this
 *  script has to think about it.
 */

const fs = require('fs');
const path = require('path');

const ALLOWED_FIELDS = ['createdAt', 'calledAt', 'doctorId', 'counter', 'status', 'priority'];

// Fields that must never reach disk. Asserted after writing as a backstop, so
// a future edit that widens ALLOWED_FIELDS trips this instead of a privacy
// incident going unnoticed.
const FORBIDDEN_FIELDS = [
  'patientName', 'name', 'phone', 'patientPhone', 'email', 'adminEmail',
  'address', 'aadhaar', 'dob', 'age', 'prescription', 'feedback',
];

function parseArgs(argv) {
  const o = {
    slug: null, out: null, since: null, project: 'tokenonspot',
    cred: null, limit: 0, dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--slug') o.slug = argv[++i];
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--since') o.since = argv[++i];
    else if (a === '--project') o.project = argv[++i];
    else if (a === '--cred') o.cred = argv[++i];
    else if (a === '--limit') o.limit = Number(argv[++i]);
    else if (a === '--dry-run') o.dryRun = true;
    else if (!a.startsWith('-') && !o.slug) o.slug = a;
  }
  return o;
}

function toMillis(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  // Firestore Timestamp
  if (typeof v === 'object') {
    if (typeof v._seconds === 'number') return v._seconds * 1000;
    if (typeof v.toMillis === 'function') {
      const ms = v.toMillis();
      return Number.isFinite(ms) ? ms : null;
    }
    if (typeof v.toDate === 'function') {
      const ms = v.toDate().getTime();
      return Number.isFinite(ms) ? ms : null;
    }
  }
  return null;
}

/**
 * Project a raw token doc onto the allowlist. Returns null when the record
 * cannot be used (no issuance time).
 */
function projectToken(doc) {
  const d = doc.data ? doc.data() : doc;
  const createdAt = toMillis(d.createdAt);
  if (createdAt == null) return null;

  const calledRaw = d.calledAt != null ? d.calledAt
    : (d.status === 'called' ? d.calledAt : null);

  return {
    createdAt,
    calledAt: toMillis(calledRaw),
    doctorId: String(d.doctorId || 'unknown'),
    counter: String(d.counter || 'Counter A'),
    status: String(d.status || 'waiting'),
    priority: d.priority ? 1 : 0,
  };
}

function assertNoPhi(records, where) {
  const keys = new Set();
  for (const r of records) for (const k of Object.keys(r)) keys.add(k);
  const bad = Array.from(keys).filter((k) => FORBIDDEN_FIELDS.includes(k));
  if (bad.length) {
    throw new Error(
      `PHI GUARD tripped in ${where}: refusing to write ${bad.join(', ')}. ` +
      'Training data must never contain identifying fields.'
    );
  }
  return true;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.slug) {
    console.error('Usage: node ml\\export.js --slug <hospital> [--out f.jsonl] [--since YYYY-MM-DD] [--cred key.json]');
    process.exit(2);
  }

  // Belt-and-braces before anything is read.
  for (const f of ALLOWED_FIELDS) {
    if (FORBIDDEN_FIELDS.includes(f)) {
      console.error(`Configuration error: "${f}" is on both the allowlist and the PHI denylist.`);
      process.exit(2);
    }
  }

  let admin;
  try {
    // Resolved from functions/ so this reuses the installed dependency.
    admin = require(path.join(__dirname, '..', 'functions', 'node_modules', 'firebase-admin'));
  } catch (e) {
    console.error('firebase-admin not found. Run `npm install` inside functions/ first.');
    process.exit(2);
  }

  if (args.cred) {
    admin.initializeApp({ credential: admin.credential.cert(require(path.resolve(args.cred))), projectId: args.project });
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    admin.initializeApp({ projectId: args.project });
  } else {
    console.error('No credentials. Pass --cred <service-account.json> or set');
    console.error('GOOGLE_APPLICATION_CREDENTIALS. Refusing to export an empty file.');
    process.exit(2);
  }

  const db = admin.firestore();
  let ref = db.collection('hospitals').doc(args.slug).collection('tokens');
  if (args.since) {
    const d = new Date(args.since + 'T00:00:00');
    if (isNaN(d.getTime())) {
      console.error(`--since "${args.since}" is not a date. Use YYYY-MM-DD.`);
      process.exit(2);
    }
    ref = ref.where('createdAt', '>=', d);
  }

  const out = args.out || path.join(__dirname, 'data', `${args.slug}-tokens.jsonl`);

  console.log(`Exporting tokens for slug="${args.slug}" from project "${args.project}"`);
  const snap = await ref.get();
  console.log(`  read ${snap.size} token doc(s)`);

  let records = snap.docs.map(projectToken).filter(Boolean);
  records.sort((a, b) => a.createdAt - b.createdAt);
  if (args.limit) records = records.slice(0, args.limit);

  assertNoPhi(records, 'export');

  const called = records.filter((r) => r.calledAt != null).length;
  const days = new Set(records.map((r) => Math.floor(r.createdAt / 86400000))).size;
  console.log(`  usable records : ${records.length}`);
  console.log(`  with calledAt  : ${called}`);
  console.log(`  distinct days  : ${days}`);
  console.log(`  fields written : ${ALLOWED_FIELDS.join(', ')} (no PHI)`);

  if (!records.length) {
    console.error('\nNothing exported. The database has no tokens for this slug.');
    process.exit(3);
  }
  if (days < 5) {
    console.warn(`\n  ! only ${days} distinct day(s) of history. ml\\train.js needs weeks of real`);
    console.warn('    traffic before a model means anything.');
  }

  if (args.dryRun) {
    console.log('\n--dry-run: nothing written.');
    console.log('first record:', JSON.stringify(records[0]));
    process.exit(0);
  }

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, records.map((r) => JSON.stringify(r)).join('\n') + '\n');

  // Re-read from disk and re-check. The written artefact is what matters, not
  // the in-memory copy.
  const onDisk = fs.readFileSync(out, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
  assertNoPhi(onDisk, out);

  console.log(`\nWrote ${onDisk.length} record(s) -> ${path.resolve(out)}`);
  console.log('Next: node ml\\train.js "' + out + '" --save ml\\data\\model.json');
}

main().catch((e) => {
  console.error('Export failed:', e && e.message ? e.message : e);
  process.exit(1);
});