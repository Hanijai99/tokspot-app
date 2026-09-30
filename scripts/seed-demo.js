/**
 * Demo hospital + day-seed data (dry-run by default).
 *
 * Targets the Firestore emulator (set FIRESTORE_EMULATOR_HOST) or a live
 * project with GOOGLE_APPLICATION_CREDENTIALS set. Nothing is written
 * unless --commit is passed.
 *
 * Usage:
 *   # emulator (rules + functions local)
 *   $env:FIRESTORE_EMULATOR_HOST='127.0.0.1:8080'
 *   node scripts/seed-demo.js --commit
 *
 *   # dry run first (default)
 *   node scripts/seed-demo.js
 *
 * Note: doctor authUid fields are placeholders here — in production,
 * create real Firebase Auth accounts via the provisionDoctor callable.
 */
'use strict';

const { initializeApp, applicationDefault } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const COMMIT = process.argv.includes('--commit');
const EMULATOR = !!(process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_EMULATOR_HOST);

if (!EMULATOR && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.error('✗  No target configured.');
  console.error('   Emulator : set FIRESTORE_EMULATOR_HOST (or start `npm run emulators`).');
  console.error('   Live     : set GOOGLE_APPLICATION_CREDENTIALS to a service-account key.');
  process.exit(1);
}

initializeApp({ credential: applicationDefault() });
const db = getFirestore();

const HOSPITAL_SLUG = 'demo-hospital';
const HOSPITAL_CODE = 'HOSP-DEMO';
const TZ = 'Asia/Kolkata';

function todayInZone(tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const get = (type) => (parts.find((p) => p.type === type) || { value: '' }).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

const TODAY = todayInZone(TZ);
const DOCTORS = [
  { id: 'dr-1', name: 'Anitha Rao', department: 'General Medicine', room: 'Room 1', accessCode: 'D101', authUid: 'demo-doctor-1' },
  { id: 'dr-2', name: 'Vikram Menon', department: 'Cardiology', room: 'Room 2', accessCode: 'D102', authUid: 'demo-doctor-2' },
  { id: 'dr-3', name: 'Sara Philip', department: 'Pediatrics', room: 'Room 3', accessCode: 'D103', authUid: 'demo-doctor-3' },
];

// seeded tokens — 2 called, 6 waiting, 1 completed (kept out of PII feeds)
const TOKENS = [
  { id: 't-001', number: '001', doctorId: 'dr-1', status: 'completed', complete: true },
  { id: 't-002', number: '002', doctorId: 'dr-1', status: 'called', called: true },
  { id: 't-003', number: '003', doctorId: 'dr-2', status: 'called', called: true },
  { id: 't-004', number: '004', doctorId: 'dr-1', status: 'waiting' },
  { id: 't-005', number: '005', doctorId: 'dr-2', status: 'waiting' },
  { id: 't-006', number: '006', doctorId: 'dr-2', status: 'waiting', priority: true },
  { id: 't-007', number: '007', doctorId: 'dr-3', status: 'waiting' },
  { id: 't-008', number: '008', doctorId: 'dr-3', status: 'waiting' },
  { id: 't-009', number: '009', doctorId: 'dr-3', status: 'waiting' },
];

async function main() {
  const plan = [];
  const wr = (label) => { plan.push(label); console.log(`  ${COMMIT ? '✓' : '·'} ${label}`); };

  console.log(`\nTokSpot demo seed (${COMMIT ? 'COMMIT' : 'DRY-RUN'}) — ${EMULATOR ? 'Firestore emulator' : 'live project'}`);
  console.log(`Hospital ${HOSPITAL_SLUG} (${HOSPITAL_CODE}) · day ${TODAY} · tz ${TZ}\n`);

  const hospitalRef = db.doc(`hospitals/${HOSPITAL_SLUG}`);
  wr(`hospitals/${HOSPITAL_SLUG} (adminUid 'demo-admin', timezone ${TZ})`);

  DOCTORS.forEach((d) => {
    wr(`hospitals/${HOSPITAL_SLUG}/doctors/${d.id} (${d.name}, authUid ${d.authUid})`);
  });

  wr(`auditLog seed events (doctor:provision ×${DOCTORS.length})`);

  TOKENS.forEach((t) => {
    wr(`hospitals/${HOSPITAL_SLUG}/tokens/${t.id} (#${t.number} · ${t.status})`);
  });
  wr(`hospitals/${HOSPITAL_SLUG}/counters/${TODAY} (count ${TOKENS.length})`);
  wr(`hospitals/${HOSPITAL_SLUG}/queueState/${TODAY}_dr-1 (activeTokenId t-002)`);
  wr(`hospitals/${HOSPITAL_SLUG}/queueState/${TODAY}_dr-2 (activeTokenId t-003)`);

  if (!COMMIT) {
    console.log('\nDry run complete — pass --commit to write these documents.\n');
    return;
  }

  const now = new Date();
  await hospitalRef.set({
    name: 'TokSpot Demo Hospital',
    hospitalCode: HOSPITAL_CODE,
    adminUid: 'demo-admin',
    adminEmail: 'admin@demo.test',
    timezone: TZ,
    createdAt: now,
  });

  for (const d of DOCTORS) {
    await db.doc(`hospitals/${HOSPITAL_SLUG}/doctors/${d.id}`).set({
      authUid: d.authUid,
      email: `${d.authUid}@demo.test`,
      name: d.name,
      department: d.department,
      room: d.room,
      counter: d.room,
      status: 'active',
      hospitalSlug: HOSPITAL_SLUG,
      accessCode: d.accessCode,
      createdAt: now,
      updatedAt: now,
    });
    await db.collection('auditLog').add({
      slug: HOSPITAL_SLUG, action: 'doctor:provision', targetId: d.id,
      outcome: 'ok', actorUid: 'demo-admin', at: now,
    });
  }

  const pad = (n) => String(n).padStart(3, '0');
  TOKENS.forEach((t, i) => {
    const token = {
      id: t.id, number: t.number, patientName: `Demo Patient ${pad(i + 1)}`,
      phone: t.complete ? '' : `98${pad(i + 1)}00000`,
      doctorId: t.doctorId, hospitalId: HOSPITAL_SLUG, date: TODAY,
      status: t.status, source: 'desk', priority: Boolean(t.priority),
      counter: DOCTORS.find((d) => d.id === t.doctorId).room || 'Room 1',
      createdAt: now,
    };
    if (t.called) token.calledAt = new Date(now.getTime() + 1000 * 60 * i);
    if (t.complete) token.completedAt = new Date(now.getTime() + 1000 * 60 * (i + 1));
    db.doc(`hospitals/${HOSPITAL_SLUG}/tokens/${t.id}`).set(token);
  });

  await db.doc(`hospitals/${HOSPITAL_SLUG}/counters/${TODAY}`).set({ count: TOKENS.length });
  await db.doc(`hospitals/${HOSPITAL_SLUG}/queueState/${TODAY}_dr-1`).set({ doctorId: 'dr-1', date: TODAY, activeTokenId: 't-002', updatedAt: now });
  await db.doc(`hospitals/${HOSPITAL_SLUG}/queueState/${TODAY}_dr-2`).set({ doctorId: 'dr-2', date: TODAY, activeTokenId: 't-003', updatedAt: now });

  console.log('\nCommanded — demo hospital is seeded.\n');
}

main().catch((err) => { console.error('\nSeed failed:', err.message); process.exit(1); });