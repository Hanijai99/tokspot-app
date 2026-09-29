/**
 * ============================================================
 *  Legacy data migration / cleanup (Admin SDK — server only)
 * ============================================================
 *  Run AFTER a verified Firestore backup and BEFORE deploying the
 *  secure rules, so old credential/clinical fields are removed and
 *  no rules-safety decision depends on them.
 *
 *  Usage:
 *    set GOOGLE_APPLICATION_CREDENTIALS=<service-account.json>
 *    node scripts/migrate-legacy-data.js            # dry run (default)
 *    node scripts/migrate-legacy-data.js --commit   # apply changes
 *
 *  What it removes / normalizes:
 *    - doctors:  pin, pinHash  (replaced by Firebase Auth provisioning)
 *    - hospitals: recoveryKey, recoverySecret
 *    - tokens:   doctorNotes   (clinical notes are out of scope)
 *    - root /doctors mirror docs (authorization should not live there)
 *    - tokens:   status 'serving' → 'called' (aligns the status model)
 * ============================================================
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { initializeApp, applicationDefault } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

initializeApp({ credential: applicationDefault() });
const db = getFirestore();

const COMMIT = process.argv.includes('--commit');
const DRY = !COMMIT;
const stats = { hospitals: 0, doctors: 0, tokens: 0, mirrors: 0 };

async function patchRef(ref, fieldNames, value) {
  const snap = await ref.get();
  if (!snap.exists) return;
  const data = snap.data();
  const updates = {};
  for (const f of fieldNames) if (f in data) updates[f] = value;
  if (updates.status === 'serving') updates.status = 'called';
  if (!Object.keys(updates).length) return;
  const verb = DRY ? 'WOULD-REMOVE' : 'REMOVED';
  stats[fieldNames[0] === 'pin' ? 'doctors' : 'hospitals']++;
  console.log(`[${verb}] ${ref.path}`, JSON.stringify(updates));
  if (COMMIT) await ref.update(updates);
}

async function main() {
  console.log(DRY ? 'DRY RUN — no writes. Pass --commit to apply.' : 'APPLYING CHANGES...');

  // 1) Hospitals: strip recovery secrets.
  const hospitals = await db.collection('hospitals').get();
  for (const h of hospitals.docs) {
    await patchRef(h.ref, ['recoveryKey', 'recoverySecret'], require('firebase-admin/firestore').FieldValue.delete());
    stats.hospitals++;
  }

  // 2) Doctors: strip PIN credentials; root mirror docs deleted.
  for (const h of hospitals.docs) {
    const docs = await db.collection(`hospitals/${h.id}/doctors`).get();
    for (const d of docs.docs) {
      await patchRef(d.ref, ['pin', 'pinHash'], require('firebase-admin/firestore').FieldValue.delete());
    }
  }
  const mirror = await db.collection('doctors').get();
  for (const d of mirror.docs) {
    stats.mirrors++;
    console.log(`[${DRY ? 'WOULD-DELETE' : 'DELETED'}] ${d.ref.path}`);
    if (COMMIT) await d.ref.delete();
  }

  // 3) Tokens: strip clinical notes, align legacy status.
  for (const h of hospitals.docs) {
    const tokens = await db.collection(`hospitals/${h.id}/tokens`).get();
    for (const t of tokens.docs) {
      const data = t.data();
      const updates = {};
      if ('doctorNotes' in data) updates.doctorNotes = require('firebase-admin/firestore').FieldValue.delete();
      if (data.status === 'serving') updates.status = 'called';
      if (Object.keys(updates).length) {
        stats.tokens++;
        console.log(`[${DRY ? 'WOULD-REMOVE' : 'REMOVED'}] ${t.ref.path}`, JSON.stringify(updates));
        if (COMMIT) await t.ref.update(updates);
      }
    }
  }

  console.log('\nSummary:', stats);
  if (DRY) console.log('\nReview above, then re-run with --commit after backup.');
}

main().catch((err) => { console.error(err); process.exit(1); });