/**
 * js/api.js prototype-mode tests: the adapter's default mode must
 * reproduce exactly what the pages did before the migration — counter
 * allocation inside the transaction, unguessable ids, room for
 * page-specific extra fields, server-side-flavoured transition
 * semantics via the shared queue-domain — and the functions-mode read
 * guards must fail loudly when someone uses them without the backend.
 */
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const queue = require('../js/queue-domain.js');

function createMemoryFirestore(initialDocuments) {
  const documents = new Map(Object.entries(initialDocuments));
  const fsApi = {
    doc(_db, ...segments) { return segments.join('/'); },
    serverTimestamp() { return new Date(123456789); },
    async runTransaction(_db, callback) {
      const writes = [];
      const transaction = {
        async get(ref) {
          const value = documents.get(ref);
          return { exists: () => value !== undefined, data: () => value };
        },
        update(ref, data) { writes.push({ type: 'update', ref, data }); },
        set(ref, data) { writes.push({ type: 'set', ref, data }); }
      };
      const result = await callback(transaction);
      for (const write of writes) {
        documents.set(write.ref, { ...(documents.get(write.ref) || {}), ...write.data });
      }
      return result;
    },
    async getDoc(ref) {
      const value = documents.get(ref);
      return { exists: () => value !== undefined, data: () => value };
    },
    async updateDoc(ref, data) {
      if (!documents.has(ref)) throw new Error('Document does not exist: ' + ref);
      documents.set(ref, { ...documents.get(ref), ...data });
    }
  };
  return { fsApi, documents };
}

function setupGlobals(documents) {
  const { fsApi, documents: docs } = createMemoryFirestore(documents);
  global.TokspotQueue = queue;
  global._fs = fsApi;
  global._db = {};
  global.pad3 = (n) => String(n).padStart(3, '0');
  global.todayStr = () => '2026-09-29';
  global._auth = { currentUser: null };
  let signedIn = false;
  global._useAuth = {
    signInAnonymously: async () => { signedIn = true; global._auth.currentUser = { uid: 'anon-test' }; },
  };
  return { docs, isSignedIn: () => signedIn };
}

test('issueToken allocates the next number atomically and never reuses ids', async () => {
  const { docs } = setupGlobals({});
  const api = require('../js/api.js');

  const first = await api.issueToken({ slug: 'demo', doctorId: 'd1', doctorName: 'Dr One', name: 'Patient A', phone: '9999999999', source: 'desk' });
  const second = await api.issueToken({ slug: 'demo', doctorId: 'd1', name: 'Patient B', phone: '8888888888', priority: true, counter: 'Counter B', source: 'self', extra: { bookedFrom: 'online', hospitalSlug: 'demo' } });

  assert.equal(first.tokenNum, '001');
  assert.equal(second.tokenNum, '002');
  assert.notEqual(first.tokenId, second.tokenId);

  const docA = docs.get('hospitals/demo/tokens/' + first.tokenId);
  assert.equal(docA.status, 'waiting');
  assert.equal(docA.patientName, 'Patient A');
  assert.equal(docA.counter, 'Counter A'); // default when omitted
  const docB = docs.get('hospitals/demo/tokens/' + second.tokenId);
  assert.equal(docB.priority, true);
  assert.equal(docB.bookedFrom, 'online'); // extra merged
  assert.equal(docs.get('hospitals/demo/counters/2026-09-29').count, 2);

  // unguessable: not derivable from date+doctor+counter
  assert.doesNotMatch(first.tokenId, /^2026-09-29-d1-/);
  assert.match(first.tokenId, /^[0-9a-f-]{36}$/);
});

test('transition enforces the active-token lock exactly like the server', async () => {
  const { docs } = setupGlobals({});
  const api = require('../js/api.js');

  const a = await api.issueToken({ slug: 'demo', doctorId: 'd1', name: 'A' });
  const b = await api.issueToken({ slug: 'demo', doctorId: 'd1', name: 'B' });

  await api.transition({ slug: 'demo', tokenId: a.tokenId, nextStatus: 'called', changes: { doctorId: 'd1', counter: 'Room 1' } });
  await assert.rejects(
    api.transition({ slug: 'demo', tokenId: b.tokenId, nextStatus: 'called' }),
    /already has an active patient/
  );
  await api.transition({ slug: 'demo', tokenId: a.tokenId, nextStatus: 'completed' });
  await api.transition({ slug: 'demo', tokenId: b.tokenId, nextStatus: 'called' });

  assert.equal(docs.get('hospitals/demo/tokens/' + b.tokenId).status, 'called');
  assert.equal(docs.get('hospitals/demo/queueState/2026-09-29_d1').activeTokenId, b.tokenId);
});

test('cancelToken requires the exact phone stored on the token', async () => {
  const { docs } = setupGlobals({});
  const api = require('../js/api.js');

  const a = await api.issueToken({ slug: 'demo', doctorId: 'd1', name: 'A', phone: '9999999999' });

  await assert.rejects(
    api.cancelToken({ slug: 'demo', tokenId: a.tokenId, phone: '0000000000' }),
    /does not match/
  );
  await api.cancelToken({ slug: 'demo', tokenId: a.tokenId, phone: '9999999999' });
  assert.equal(docs.get('hospitals/demo/tokens/' + a.tokenId).status, 'canceled');

  // terminal tokens cannot be canceled
  await assert.rejects(
    api.cancelToken({ slug: 'demo', tokenId: a.tokenId, phone: '9999999999' }),
    /can no longer be canceled/
  );
});

test('functions-mode read feeds fail loudly in prototype mode', () => {
  const api = require('../js/api.js');
  assert.equal(api.mode(), 'prototype');
  return Promise.all([
    assert.rejects(api.getTokenStatus({ slug: 'demo', tokenId: 'x' }), /requires functions mode/),
    assert.rejects(api.getDoctorQueue({ slug: 'demo', doctorId: 'd1' }), /requires functions mode/),
    assert.rejects(api.getTvFeed({ slug: 'demo' }), /requires functions mode/),
  ]);
});