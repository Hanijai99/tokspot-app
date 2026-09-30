// Unit tests for the bundled medicine catalog (js/medicines.js).
// Run with: node --test tests/medicines.test.cjs
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const MEDICINES = (() => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'medicines.js'), 'utf8');
  const sandbox = {};
  vm.runInNewContext(src, sandbox);
  return sandbox.TOKSPOT_MEDICINES;
})();

test('medicine catalog is a healthy, searchable list', () => {
  assert.ok(Array.isArray(MEDICINES), 'TOKSPOT_MEDICINES must be an array');
  assert.ok(MEDICINES.length >= 100, `expected >= 100 medicines, got ${MEDICINES.length}`);
});

test('every medicine has a unique name, a category, and a strengths array', () => {
  const seen = new Set();
  for (const m of MEDICINES) {
    assert.ok(m && typeof m.name === 'string' && m.name.trim(), 'each entry has a name');
    assert.ok(typeof m.category === 'string' && m.category.trim(), `category missing for ${m.name}`);
    assert.ok(Array.isArray(m.strengths), `strengths must be an array for ${m.name}`);
    const key = m.name.trim().toLowerCase();
    assert.ok(!seen.has(key), `duplicate medicine name: ${m.name}`);
    seen.add(key);
  }
});

test('catalog is searchable by name (case-insensitive substring)', () => {
  const q = 'paracetamol'.toLowerCase();
  const hits = MEDICINES.filter((m) => m.name.toLowerCase().includes(q));
  assert.ok(hits.length >= 1, 'expected at least one match for "paracetamol"');
});