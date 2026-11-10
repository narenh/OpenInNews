// node --test test/
// Per-site modes through background.js, driven by test/fake-browser.js.
const test = require('node:test');
const assert = require('node:assert');
const { load } = require('./fake-browser.js');
const ARTICLE = 'https://www.wsj.com/politics/some-long-article-slug-here';
const hit = async () => 'A1';
const plain = (v) => JSON.parse(JSON.stringify(v ?? null)); // objects from the vm context aren't deep-equal across realms
const check = (b, url = ARTICLE) => b.message({ action: 'checkPage', url }, { tab: { id: 1 } });

test('a fresh install opens seed sites automatically and stores the map', async () => {
  const b = load(hit);
  assert.deepStrictEqual(plain(await check(b)), { id: 'A1', openNow: true });
  assert.strictEqual(b.store.modes['wsj.com'], 'auto');
});

test('ask: the id comes back but News is not opened', async () => {
  const b = load(hit, { store: { modes: { 'wsj.com': 'ask' }, modesAt: 1 } });
  assert.deepStrictEqual(plain(await check(b)), { id: 'A1', openNow: false });
});

test('off, and a seed site missing from the stored map: no lookup', async () => {
  let calls = 0;
  const b = load(async () => { calls++; return 'A1'; }, { store: { modes: { 'wired.com': 'auto' }, modesAt: 1 } });
  assert.strictEqual(await check(b), null);
  const off = load(hit, { store: { modes: { 'wsj.com': 'off' }, modesAt: 1 } });
  assert.strictEqual(await check(off), null);
  assert.strictEqual(calls, 0);
});

test('old settings are migrated on first use', async () => {
  const b = load(hit, { store: { sites: { 'wsj.com': true, 'wired.com': true }, manual: { 'wired.com': true } } });
  assert.deepStrictEqual(plain(await b.message({ action: 'siteStatus', host: 'www.wired.com' })), { site: 'wired.com', mode: 'ask' });
  assert.deepStrictEqual(plain(await b.message({ action: 'siteStatus', host: 'www.wsj.com' })), { site: 'wsj.com', mode: 'auto' });
  assert.deepStrictEqual(plain(await b.message({ action: 'siteStatus', host: 'nymag.com' })), { site: 'nymag.com', mode: 'off' });
  assert.deepStrictEqual(plain(await b.message({ action: 'siteStatus', host: 'www.example.org' })), { site: 'example.org', mode: 'off' });
});

test('setMode changes the site and rejects an invalid mode', async () => {
  const b = load(hit, { store: { modes: {}, modesAt: 1 } });
  await b.message({ action: 'setMode', site: 'example.org', mode: 'ask' });
  assert.strictEqual(b.store.modes['example.org'], 'ask');
  assert.ok(b.store.modesAt > 1);
  await b.message({ action: 'setMode', site: 'example.org', mode: 'bogus' });
  assert.strictEqual(b.store.modes['example.org'], 'ask');
});

test('seen is recorded for seed and custom sites in any mode, not for others', async () => {
  const b = load(hit, { store: { modes: { 'wsj.com': 'off', 'custom.com': 'ask' }, modesAt: 1 } });
  await check(b, 'https://www.wsj.com/news/world');
  assert.ok(b.store.seen['wsj.com'] > 0);
  const c = load(hit, { store: { modes: { 'custom.com': 'off' }, modesAt: 1 } });
  await check(c, 'https://custom.com/');
  await check(c, 'https://wired.com/');   // seed, not in the map
  await check(c, 'https://other.example/');
  assert.deepStrictEqual(Object.keys(c.store.seen).sort(), ['custom.com', 'wired.com']);
});

test('sync sends the modes and adopts the app\'s when they are newer', async () => {
  const sent = [];
  let appReply = {};
  const b = load(hit, { native: (m) => { sent.push(m); return m.action === 'resolve' ? { found: true, id: 'A1' } : appReply; },
                        store: { modes: { 'wsj.com': 'auto' }, modesAt: 10 } });
  await check(b);
  const sync = sent.find((m) => m.action === 'sync');
  assert.deepStrictEqual(plain(sync.state.modes), { 'wsj.com': 'auto' });
  assert.strictEqual(sync.state.modesAt, 10);
  assert.ok(!('sites' in sync.state) && !('auto' in sync.state));

  appReply = { modes: { 'wsj.com': 'off' }, modesAt: 5 };       // older: ignored
  await b.message({ action: 'siteStatus', host: 'wsj.com' });
  assert.strictEqual(b.store.modes['wsj.com'], 'auto');
  appReply = { modes: { 'wsj.com': 'ask', 'new.com': 'auto' }, modesAt: 20 }; // newer: adopted
  assert.deepStrictEqual(plain(await b.message({ action: 'siteStatus', host: 'wsj.com' })), { site: 'wsj.com', mode: 'ask' });
  assert.strictEqual(b.store.modesAt, 20);
  assert.strictEqual(b.store.modes['new.com'], 'auto');
  assert.strictEqual(sent.filter((m) => m.action === 'pull').at(-1).modesAt, 10); // pull says how new its copy is
});
