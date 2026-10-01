'use strict';
/**
 * Every callable the client can invoke must exist in functions/index.js.
 *
 * The API adapter is the single place where the browser decides between
 * prototype mode and the trusted backend. In functions mode a typo in a
 * callable name — or a callable that was never deployed — fails at the
 * moment a patient books a token, not at review time. This suite reads
 * both sides and fails the build instead.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..');
const apiSrc = fs.readFileSync(path.join(dir, 'js', 'api.js'), 'utf8');
const fnSrc = fs.readFileSync(path.join(dir, 'functions', 'index.js'), 'utf8');

const serverCallables = new Set(
  [...fnSrc.matchAll(/^exports\.(\w+)\s*=\s*onCall\(/gm)].map((m) => m[1])
);
const clientCallables = new Set(
  [...apiSrc.matchAll(/callFunction\('(\w+)'/g)].map((m) => m[1])
);

test('the backend exposes a real set of callables', () => {
  assert.ok(serverCallables.size >= 30, `expected 30+ callables, found ${serverCallables.size}`);
});

test('every callable the client can invoke exists on the backend', () => {
  const missing = [...clientCallables].filter((n) => !serverCallables.has(n)).sort();
  assert.deepEqual(
    missing,
    [],
    `client calls callables the backend does not export: ${missing.join(', ')}`
  );
});

test('the callable adapter covers every core queue workflow', () => {
  // The paths a hospital cannot run without. If one of these is renamed
  // on one side only, the queue stops working in production.
  const core = [
    'issueToken',      // patient booking
    'transitionToken', // call / skip / complete
    'getTokenStatus',  // patient pass
    'getDoctorQueue',  // doctor desk
    'getDeskQueue',    // front desk
    'getTvFeed',       // public board
    'getPharmacyQueue',
    'pharmacyAction',
    'savePrescription',
    'routeToPharmacy',
    'createHospital',  // signup (migrated in round 9.12)
    'createAppointment',
    'submitFeedback',
    'provisionDoctor',
    'getMyDoctorProfile',
    'resolveHospitalByCode',
  ];
  for (const name of core) {
    assert.ok(serverCallables.has(name), `backend must export ${name}`);
    assert.ok(clientCallables.has(name), `client must be able to call ${name}`);
  }
});

test('client callables are rate limited server-side', () => {
  // Every callable that takes no per-caller cap is a bot target.
  const bodies = [...fnSrc.matchAll(
    /^exports\.(\w+)\s*=\s*onCall\(\{([^}]*)\}/gm
  )];
  assert.ok(bodies.length > 25, `expected to parse the callables, found ${bodies.length}`);
  const uncapped = bodies
    .filter(([, , opts]) => !/rateLimiting\s*:/.test(opts))
    .map(([, name]) => name)
    .sort();
  assert.deepEqual(uncapped, [], `callables without a rate limit: ${uncapped.join(', ')}`);
});

test('every rate limit is a sane, explicit number', () => {
  const rlBlock = fnSrc.slice(fnSrc.indexOf('const RL = {'), fnSrc.indexOf('};', fnSrc.indexOf('const RL = {')));
  const entries = [...rlBlock.matchAll(/(\w+):\s*\{\s*maxCalls:\s*(\d+),\s*periodSeconds:\s*(\d+)\s*\}/g)];
  assert.ok(entries.length >= 25, `expected 25+ RL entries, found ${entries.length}`);
  for (const [full, key, max, period] of entries) {
    assert.ok(Number(max) > 0, `${key} must allow at least one call`);
    assert.ok(Number(period) >= 60, `${key} period must be at least a minute`);
    assert.ok(
      Number(max) / Number(period) <= 5,
      `${key} allows ${max}/${period}s = more than 5 calls/sec sustained`
    );
    assert.ok(full.includes('maxCalls'), `${key} must set maxCalls`);
  }
});

test('write callables audit their actions', () => {
  // Any callable that mutates a token/hospital/appointment must leave an
  // audit trail — that is what makes the log useful during an incident.
  const mustAudit = [
    'issueToken', 'transitionToken', 'cancelToken', 'routeToPharmacy',
    'pharmacyAction', 'savePrescription', 'createHospital', 'createAppointment',
    'checkInAppointment', 'markNoShow', 'provisionDoctor', 'revokeDoctor',
    'submitFeedback', 'transferQueue',
  ];
  for (const name of mustAudit) {
    const start = fnSrc.indexOf(`exports.${name} = onCall(`);
    assert.ok(start !== -1, `${name} must exist`);
    // find the next top-level callable (or end of the file) as the body
    const rest = fnSrc.slice(start + 1);
    const nextIdx = rest.search(/\nexports\.\w+\s*=\s*(onCall|onRequest|onSchedule)/);
    const body = nextIdx === -1 ? rest : rest.slice(0, nextIdx);
    assert.match(
      body,
      /await audit\(/,
      `${name} mutates state but never calls audit()`
    );
  }
});