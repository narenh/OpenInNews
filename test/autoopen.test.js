// node --test test/
const test = require('node:test');
const assert = require('node:assert');
const { autoOpens, modeFor, modesFrom } = require('../Extension/Resources/autoopen.js');

const SEEDS = ['wsj.com', 'wired.com', 'nymag.com'];

test('only auto opens News by itself', () => {
  const s = { modes: { 'wsj.com': 'auto', 'nymag.com': 'ask', 'wired.com': 'off' } };
  assert.strictEqual(autoOpens(s, 'wsj.com'), true);
  assert.strictEqual(autoOpens(s, 'nymag.com'), false);
  assert.strictEqual(autoOpens(s, 'wired.com'), false);
  assert.strictEqual(autoOpens(s, 'unknown.com'), false);
  assert.strictEqual(autoOpens(s, null), false);
});

test('a site missing from the map is off', () => {
  assert.strictEqual(modeFor({ 'wsj.com': 'ask' }, 'wired.com'), 'off');
  assert.strictEqual(modeFor({}, null), 'off');
});

test('migration: a fresh install seeds every seed site as auto', () => {
  const r = modesFrom({}, SEEDS);
  assert.deepStrictEqual(r.modes, { 'wsj.com': 'auto', 'wired.com': 'auto', 'nymag.com': 'auto' });
  assert.strictEqual(r.migrated, true);
  assert.strictEqual(r.at, 0);
});

test('migration: on becomes auto, button-only becomes ask, off stays off', () => {
  const r = modesFrom({ sites: { 'wsj.com': true, 'wired.com': false, 'nymag.com': true, 'custom.com': true }, auto: true, manual: { 'nymag.com': true } }, SEEDS);
  assert.deepStrictEqual(r.modes, { 'wsj.com': 'auto', 'wired.com': 'off', 'nymag.com': 'ask', 'custom.com': 'auto' });
});

test('migration: global auto off makes every on site ask', () => {
  const r = modesFrom({ sites: { 'wsj.com': true, 'wired.com': false }, auto: false }, SEEDS);
  assert.deepStrictEqual(r.modes, { 'wsj.com': 'ask', 'wired.com': 'off' });
});

test('migration: seed sites missing from the old map are not added', () => {
  const r = modesFrom({ sites: { 'wsj.com': true } }, SEEDS);
  assert.deepStrictEqual(r.modes, { 'wsj.com': 'auto' });
});

test('migration: old settings with no sites stored still mean the seeds were on', () => {
  const r = modesFrom({ auto: false, manual: { 'wsj.com': true } }, SEEDS);
  assert.deepStrictEqual(r.modes, { 'wsj.com': 'ask', 'wired.com': 'ask', 'nymag.com': 'ask' });
});

test('stored modes are kept, minus invalid values, and are not migrated again', () => {
  const r = modesFrom({ modes: { 'wsj.com': 'ask', 'x.com': 'bogus' }, modesAt: 5, sites: { 'wired.com': true } }, SEEDS);
  assert.deepStrictEqual(r, { modes: { 'wsj.com': 'ask' }, at: 5, migrated: false });
});
