'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..');
const displayHtml = fs.readFileSync(path.join(dir, 'display.html'), 'utf8');
const fnIndex = fs.readFileSync(path.join(dir, 'functions', 'index.js'), 'utf8');

test('the TV pharmacy panel renders in BOTH data modes (prototype + functions)', () => {
  // prototype: Firestore snapshot rows
  assert.match(
    displayHtml,
    /renderTvPharmacyPanel\(tvPharmacyView\(pharmacyRows\)\)/,
    'prototype snapshot path must render the pharmacy panel'
  );
  // functions: the sanitized TV feed poll
  const poll = displayHtml.slice(displayHtml.indexOf('function startTvFeedPolling'));
  assert.match(
    poll,
    /renderTvPharmacyPanel\(/,
    'functions-mode TV poll must render the pharmacy panel too'
  );
  assert.match(
    poll,
    /board\.pharmacy/,
    'functions-mode TV poll must read the pharmacy section of the feed'
  );
});

test('the functions TV feed ships a sanitized pharmacy section', () => {
  const feed = fnIndex.slice(fnIndex.indexOf('exports.getTvFeed'));
  const end = feed.indexOf('exports.getTokenByNumber');
  const body = end === -1 ? feed : feed.slice(0, end);

  assert.match(body, /const pharmacyRows = \[\]/, 'getTvFeed must collect pharmacy-stage rows');
  assert.match(body, /queueDomain\.pharmacyBoardView\(pharmacyRows\)/, 'getTvFeed must reduce them with the shared projection');
  assert.match(body, /board\.pharmacy = pharmacy/, 'getTvFeed must attach the pharmacy view to the board');
  assert.match(body, /\n\s*pharmacy,\n/, 'getTvFeed must return the pharmacy section');
  // only completed + routed tokens join the pharmacy stage on the TV
  assert.match(body, /t\.pharmacy !== true \|\| normalizeStatus\(t\.status\) !== 'completed'/, 'TV pharmacy must require completed + routed');
  // the projected row must stay sanitized
  assert.match(body, /counter: String\(t\.pharmacyCounter \|\| ''\)/, 'pharmacy row must expose only the counter label');
  // privacy: no names, phones or clinical data on a public board. Comments
  // are stripped first — this feed is allowed to *say* it avoids PII.
  const code = body
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');
  assert.doesNotMatch(code, /patientName|\.phone\b|prescription/i, 'getTvFeed must never expose patient identity or prescriptions');
  assert.doesNotMatch(code, /pushed\(\{[^}]*name/i, 'getTvFeed rows must not carry a name field');
});

test('tvPharmacyView is the single normalizer for both data modes', () => {
  assert.match(displayHtml, /function tvPharmacyView\(rows\)/, 'tvPharmacyView helper must exist');
  const helper = displayHtml.slice(displayHtml.indexOf('function tvPharmacyView'));
  assert.match(helper, /TokspotQueue\.pharmacyBoardView/, 'display.html must reuse the shared queue-domain projection');
  assert.match(displayHtml, /function renderTvPharmacyPanel\(view\)/, 'renderTvPharmacyPanel must take the normalized view');
  // the shared projection must actually be exported on both sides
  assert.match(fs.readFileSync(path.join(dir, 'js', 'queue-domain.js'), 'utf8'), /pharmacyBoardView[,\s}]*\};/, 'client queue-domain must export pharmacyBoardView');
  assert.match(displayHtml, /js\/queue-domain\.js/, 'display.html must load js/queue-domain.js or the shared projection is unavailable');
  assert.match(fs.readFileSync(path.join(dir, 'functions', 'queue-domain.js'), 'utf8'), /pharmacyBoardView,/, 'server queue-domain must export pharmacyBoardView');
  assert.match(fnIndex, /queueDomain\.pharmacyBoardView\(pharmacyRows\)/, 'getTvFeed must use the shared projection');
});

test('pharmacyBoardView behaves identically on client and server', () => {
  const client = require('../js/queue-domain.js');
  const server = require('../functions/queue-domain.js');
  const T = (n) => ({ toMillis: () => n });
  const cases = [
    [],
    null,
    undefined,
    [{ pharmacyStatus: 'waiting' }],
    [{ pharmacyStatus: 'waiting' }, { pharmacyStatus: 'waiting' }, { pharmacyStatus: 'waiting' }],
    [{ pharmacyStatus: 'called', number: '007', pharmacyCalledAt: T(5000) }],
    [
      { pharmacyStatus: 'called', number: '007', pharmacyCalledAt: T(5000) },
      { pharmacyStatus: 'called', number: '009', pharmacyCalledAt: T(9000) },
    ],
    // newest call wins regardless of input order
    [
      { pharmacyStatus: 'called', number: '009', pharmacyCalledAt: T(9000) },
      { pharmacyStatus: 'called', number: '007', pharmacyCalledAt: T(5000) },
    ],
    // Date objects (prototype Firestore timestamps are Dates) and raw millis
    [{ pharmacyStatus: 'called', number: '010', pharmacyCalledAt: new Date(7000) }],
    [{ pharmacyStatus: 'called', number: '011', pharmacyCalledAt: 8000 }],
    // dispensed / skipped rows must not appear or count
    [
      { pharmacyStatus: 'dispensed', number: '001' },
      { pharmacyStatus: 'skipped', number: '002' },
      { pharmacyStatus: 'waiting', number: '003' },
    ],
    // a called row with no timestamp still counts as active
    [{ pharmacyStatus: 'called', number: '012' }],
    // missing pharmacyStatus is treated as waiting, matching the server default
    [{ number: '013' }],
  ];

  for (const rows of cases) {
    const c = client.pharmacyBoardView(rows);
    const s = server.pharmacyBoardView(rows);
    assert.equal(c.waiting, s.waiting, `waiting count drifted for ${JSON.stringify(rows)}`);
    assert.equal(
      c.active ? c.active.number : null,
      s.active ? s.active.number : null,
      `active token drifted for ${JSON.stringify(rows)}`
    );
  }

  // spot-check the intended semantics
  const mixed = client.pharmacyBoardView([
    { pharmacyStatus: 'waiting', number: '020' },
    { pharmacyStatus: 'waiting', number: '021' },
    { pharmacyStatus: 'called', number: '019', pharmacyCalledAt: 1000 },
    { pharmacyStatus: 'called', number: '022', pharmacyCalledAt: 2000 },
    { pharmacyStatus: 'dispensed', number: '018' },
  ]);
  assert.equal(mixed.waiting, 2);
  assert.equal(mixed.active.number, '022');
  assert.deepEqual(client.pharmacyBoardView([]), { active: null, waiting: 0 });
});
