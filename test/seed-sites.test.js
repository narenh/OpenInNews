// node --test test/
// Shared/SeedSites.swift is generated from sites.js; regenerate it with
// `node scripts/gen-seed-sites.js` if this fails.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { generate, out } = require('../scripts/gen-seed-sites.js');

test('the app\'s seed site list matches sites.js', () => {
  assert.strictEqual(fs.readFileSync(out, 'utf8'), generate());
});
