// Unit tests for the lightweight i18n layer (js/i18n.js).
// Run with: node --test tests/i18n.test.cjs
const test = require('node:test');
const assert = require('node:assert');

const I18N = require('../js/i18n.js');

// i18n.js reads localStorage through the browser globals when it can;
// under Node those calls are guarded by try/catch and default to 'en'.
test('i18n layer exposes the expected API', () => {
  assert.equal(typeof I18N.t, 'function');
  assert.equal(typeof I18N.setLang, 'function');
  assert.equal(typeof I18N.apply, 'function');
  assert.equal(typeof I18N.init, 'function');
  assert.ok(Array.isArray(I18N.supported));
  assert.ok(I18N.supported.includes('en'));
  assert.ok(I18N.supported.includes('ta'));
});

test('i18n t() resolves en and ta translations and falls back to en', () => {
  // Default context (no localStorage in Node) is English.
  assert.equal(I18N.t('token.nowServing'), 'Now Serving');
  assert.equal(I18N.t('desk.issue'), 'Issue Token');

  // Unknown keys echo the key itself (never crash).
  assert.equal(I18N.t('missing.key.example'), 'missing.key.example');
});

test('i18n en/ta dictionaries stay in sync on every key', () => {
  const en = Object.keys(I18N.dicts.en);
  const ta = Object.keys(I18N.dicts.ta);
  const onlyEn = en.filter((k) => !ta.includes(k));
  const onlyTa = ta.filter((k) => !en.includes(k));
  assert.deepEqual(onlyEn, [], 'keys present in en but missing from ta: ' + onlyEn.join(', '));
  assert.deepEqual(onlyTa, [], 'keys present in ta but missing from en: ' + onlyTa.join(', '));
  assert.ok(en.length >= 60, 'expected a healthy dictionary size, got ' + en.length);
});