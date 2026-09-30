'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

test('dark mode toggle is implemented via window.hk shared in js/app.js', () => {
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf8');
  assert.match(appJs, /window\.hk\s*=\s*\(function/, 'app.js must define window.hk');
  assert.match(appJs, /function toggleDark/, 'hk.toggleDark must exist');
  assert.match(appJs, /function applyDark/, 'hk.applyDark must exist');
  assert.match(appJs, /localStorage/, 'theme choice must persist');
  assert.match(appJs, /tokspot_theme/, 'persistence key must be set');
});

test('every page with a moon button wires it to hk.toggleDark and loads app.js', () => {
  const dir = path.join(__dirname, '..');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(dir, file), 'utf8');
    if (!/fa-moon/.test(html)) continue;
    assert.match(html, /hk\.toggleDark\(\)/, `${file} has a moon button but no hk.toggleDark wiring`);
    assert.match(html, /js\/app\.js/, `${file} has a moon button but does not load js/app.js`);
  }
});