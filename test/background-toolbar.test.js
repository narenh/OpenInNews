// node --test test/
const test = require('node:test');
const assert = require('node:assert');
const { load } = require('./fake-browser.js');
const ARTICLE = 'https://www.wsj.com/politics/some-long-article-slug-here';
const found = async () => 'A1';

test('auto-open on: the popup stays', async () => {
  const b = load(found);
  await b.visit(1, ARTICLE);
  assert.strictEqual(b.popups[1], 'popup.html');
});

test('auto-open off globally or for the site: a click opens the article', async () => {
  for (const [action, fields] of [['setAuto', { on: false }], ['setSiteAuto', { site: 'wsj.com', on: false }]]) {
    const b = load(found);
    await b.message({ action, ...fields });
    await b.visit(1, ARTICLE);
    assert.strictEqual(b.popups[1], '', action);
    assert.strictEqual(await b.click(1), null, action);
    assert.strictEqual(b.navigated[1], 'applenewss:///A1', action);
  }
});

test('miss, failed lookup, non-article page: the popup stays', async () => {
  for (const [resolve, url] of [[async () => null, ARTICLE], [async () => { throw new Error('503'); }, ARTICLE], [found, 'https://www.wsj.com/news/world']]) {
    const b = load(resolve);
    await b.message({ action: 'setAuto', on: false });
    await b.visit(1, url);
    assert.strictEqual(b.popups[1], 'popup.html', url);
  }
});

test('a new page brings the popup back', async () => {
  const b = load(found);
  await b.message({ action: 'setAuto', on: false });
  await b.visit(1, ARTICLE);
  await b.navigate(1, 'https://www.wsj.com/news/world');
  assert.strictEqual(b.popups[1], 'popup.html');
});

test('no one-click if the tab moved on before the lookup finished', async () => {
  const b = load(found);
  await b.message({ action: 'setAuto', on: false });
  await b.visit(1, ARTICLE, { tabUrl: 'https://www.wsj.com/news/world' });
  assert.strictEqual(b.popups[1], 'popup.html');
});

test('the button has a Settings… item in its right-click menu', async () => {
  const b = load(found);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(b.menus)), [{ id: 'settings', title: 'Settings…', contexts: ['action'] }]);
});

test('Settings… on a one-click page shows the popup and keeps one-click', async () => {
  const b = load(found);
  await b.message({ action: 'setAuto', on: false });
  await b.visit(1, ARTICLE);
  await b.menuClick(1);
  assert.strictEqual(b.popupsOpened(), 1);
  assert.strictEqual(b.popups[1], '');
  assert.deepStrictEqual(b.created, []);
});

test('Settings… on any other page leaves its popup on', async () => {
  const b = load(found);
  await b.visit(1, ARTICLE);
  await b.menuClick(1);
  assert.strictEqual(b.popupsOpened(), 1);
  assert.strictEqual(b.popups[1], 'popup.html');
});

test('a failed popup still gets its settings tab while a second Settings… waits', async () => {
  const calls = [];
  const b = load(found, { openPopup: () => new Promise((resolve, reject) => calls.push({ resolve, reject })), timers: false });
  await b.visit(1, ARTICLE);
  await b.visit(2, ARTICLE);
  await b.menuClick(1);
  await b.menuClick(2);
  calls[0].reject(new Error('no popup')); // tab 1's popup fails while tab 2 waits
  await b.message({ action: 'popupShown' }); // tab 2's popup shows
  await new Promise((r) => setTimeout(r, 30));
  assert.deepStrictEqual(b.created, ['chrome-extension://x/popup.html?tab=1']);
});

test('without context menus (iOS) the background still loads', () => {
  assert.doesNotThrow(() => load(found, { contextMenus: false }));
});

test('Settings… opens a settings tab at once when the popup fails', async () => {
  const b = load(found, { openPopup: async () => { throw new Error('unsupported'); }, timers: false });
  await b.visit(1, ARTICLE);
  await b.menuClick(1);
  assert.deepStrictEqual(b.created, ['chrome-extension://x/popup.html?tab=1']);
});

test('Settings… opens a settings tab after a wait when the popup never shows', async () => {
  const b = load(found, { openPopup: async () => {} });
  await b.visit(1, ARTICLE);
  await b.menuClick(1);
  assert.deepStrictEqual(b.created, ['chrome-extension://x/popup.html?tab=1']);
});

test('after a settings tab, a one-click page stays one-click', async () => {
  const b = load(found, { openPopup: async () => { throw new Error('unsupported'); } });
  await b.message({ action: 'setAuto', on: false });
  await b.visit(1, ARTICLE);
  await b.menuClick(1);
  assert.deepStrictEqual(b.created, ['chrome-extension://x/popup.html?tab=1']);
  assert.strictEqual(b.popups[1], '');
});

test('other menu items are ignored', async () => {
  const b = load(found);
  await b.visit(1, ARTICLE);
  await b.menuClick(1, 'something-else');
  assert.strictEqual(b.popupsOpened(), 0);
});

test('a click when the article cannot be found now shows the settings', async () => {
  let calls = 0;
  const b = load(async () => (calls++ === 0 ? 'A1' : undefined));
  await b.message({ action: 'setAuto', on: false });
  await b.visit(1, ARTICLE);
  // An in-page navigation the content script didn't see; the popup stays removed.
  await b.navigate(1, 'https://www.wsj.com/politics/another-long-article-slug-here');
  b.popups[1] = '';
  assert.strictEqual(await b.click(1), null);
  assert.strictEqual(b.popups[1], 'popup.html');
  assert.strictEqual(b.popupsOpened(), 1);
  assert.strictEqual(b.navigated[1], undefined);
});

test('a click after the site was turned off shows the settings, not News', async () => {
  const b = load(found);
  await b.message({ action: 'setAuto', on: false });
  await b.visit(1, ARTICLE);
  assert.strictEqual(b.popups[1], '');
  await b.message({ action: 'setSite', site: 'wsj.com', on: false });
  assert.strictEqual(await b.click(1), null);
  assert.strictEqual(b.navigated[1], undefined);
  assert.strictEqual(b.popupsOpened(), 1);
});

test('a click on a tab with no url shows the settings', async () => {
  const b = load(found);
  await b.message({ action: 'setAuto', on: false });
  await b.visit(1, ARTICLE);
  await b.navigate(1, undefined);
  assert.strictEqual(await b.click(1), null);
  assert.strictEqual(b.navigated[1], undefined);
  assert.strictEqual(b.popupsOpened(), 1);
});

test('a click after auto-open was turned back on still opens the article', async () => {
  const b = load(found);
  await b.message({ action: 'setAuto', on: false });
  await b.visit(1, ARTICLE);
  await b.message({ action: 'setAuto', on: true });
  assert.strictEqual(await b.click(1), null);
  assert.strictEqual(b.navigated[1], 'applenewss:///A1');
});

test('a menu setup error stays inside the menu setup; the background loads and clicks work', async () => {
  for (const menuError of [new Error('create'), 'sync']) {
    const b = load(found, { menuError });
    await b.message({ action: 'setAuto', on: false });
    await b.visit(1, ARTICLE);
    assert.strictEqual(await b.click(1), null);
    assert.strictEqual(b.navigated[1], 'applenewss:///A1', String(menuError));
  }
});
