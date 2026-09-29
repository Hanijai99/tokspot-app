/**
 * Guards the P0 integrity boundary: the queue transition matrix and
 * status normalization used by the browser pages (js/queue-domain.js)
 * MUST match what the trusted Functions backend enforces
 * (functions/queue-domain.js). If an engineer edits one but not the
 * other, decisions that passed client-side would be rejected — or worse,
 * accepted — server-side.
 */
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const client = require('../js/queue-domain.js');
const server = require('../functions/queue-domain.js');

const STATUSES = ['waiting', 'called', 'serving', 'skipped', 'completed', 'canceled'];

test('client and server agree on every allowed transition', () => {
  for (const from of STATUSES) {
    for (const to of STATUSES) {
      assert.equal(
        client.canTransition(from, to),
        server.canTransition(from, to),
        `canTransition('${from}', '${to}') drifted between client and server`
      );
    }
  }
});

test('client and server normalize statuses identically', () => {
  for (const s of STATUSES.concat([undefined, '', null])) {
    assert.equal(client.normalizeStatus(s), server.normalizeStatus(s), `normalizeStatus(${s}) drifted`);
  }
});

test('client and server agree on the raw transition matrix', () => {
  assert.deepEqual(server.ALLOWED_TRANSITIONS, {
    waiting: ['called', 'canceled'],
    called: ['completed', 'skipped'],
    skipped: ['waiting', 'canceled'],
    completed: [],
    canceled: [],
  });
  // every server entry must be reachable from the client module too
  for (const from of Object.keys(server.ALLOWED_TRANSITIONS)) {
    for (const to of server.ALLOWED_TRANSITIONS[from]) {
      assert.equal(client.canTransition(from, to), true);
    }
  }
});

test('client and server compute the same token numbers and wait analytics', () => {
  for (const n of [0, 1, 2, 98, 7]) {
    assert.equal(client.nextTokenNumber(n), server.nextTokenNumber(n));
    assert.equal(server.nextTokenNumber(n), n + 1);
  }
  const samples = [
    { createdAt: new Date(0), calledAt: new Date(15 * 60000) },
    { createdAt: Date.now() - 3600000, calledAt: Date.now() - 2400000 },
    { createdAt: new Date(0) }, // incomplete — must be ignored by both
    { createdAt: { toMillis: () => 0 }, calledAt: { toMillis: () => 20 * 60000 } },
  ];
  assert.equal(client.averageWaitMinutes(samples), server.averageWaitMinutes(samples));
});

test('client and server estimate wait minutes identically', () => {
  const cases = [
    { waitingCount: 0, avgServeMinutes: null },
    { waitingCount: 3, avgServeMinutes: null },
    { waitingCount: 5, avgServeMinutes: 7 },
    { waitingCount: 1.5, avgServeMinutes: 10 },
    { waitingCount: -1, avgServeMinutes: 8 },
    { waitingCount: '4', avgServeMinutes: '6' },
    { waitingCount: NaN, avgServeMinutes: null },
  ];
  for (const c of cases) {
    assert.equal(client.estimateWaitMinutes(c), server.estimateWaitMinutes(c), `estimateWaitMinutes(${JSON.stringify(c)}) drifted`);
  }
});