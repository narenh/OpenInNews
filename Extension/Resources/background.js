/*
 * Decides whether a page should open in News, using owl.js to look it up in
 * Apple's index. A page is only looked up on sites you have turned on; a miss
 * means News has no copy, so the page is left alone.
 */

const COOLDOWN_MS = 15 * 60 * 1000; // don't auto-open the same URL twice in this window
const SYNC_INTERVAL_MS = 10 * 60 * 1000; // report activity to the app at most this often
const APP_ID = 'com.canopysf.AutoOpenInNews';

// Safari extensions come with a native handler; Chrome's has none.
const IS_SAFARI = browser.runtime.getURL('').startsWith('safari-web-extension:');

async function settings() {
  const stored = await browser.storage.local.get(['sites', 'auto', 'opened', 'manual', 'manualAt']);
  return {
    sites: stored.sites ?? Object.fromEntries(self.SEED_SITES.map((s) => [s, true])),
    auto: stored.auto ?? true,
    opened: stored.opened ?? {},
    manual: stored.manual ?? {}, // site -> true: show the pill, never open News by itself
    manualAt: stored.manualAt ?? 0
  };
}

/* The configured site that covers this host: itself or its nearest parent. */
function siteFor(host, sites) {
  for (let h = host; h.includes('.'); h = h.slice(h.indexOf('.') + 1)) {
    if (h in sites) return h;
  }
  return null;
}

/*
 * Article URLs end in a slug or a numeric ID; section fronts don't. Checking
 * this first saves fetching an index bucket for every page on a site.
 */
function hasArticleSlug(url) {
  const last = url.pathname.split('/').filter(Boolean).pop() ?? '';
  return (last.match(/-/g) ?? []).length >= 3 || /\d{6,}/.test(last);
}

const lookups = new Map(); // url -> Promise<article ID, null if not in News, undefined if the lookup failed>

/*
 * In Safari the native handler does the lookup (OWLResolver.swift), so the
 * request comes from the app extension rather than a browser context. owl.js
 * covers Chrome, and Safari if the native lookup fails.
 */
async function nativeLookup(url) {
  if (!IS_SAFARI) return null;
  const reply = await browser.runtime.sendNativeMessage(APP_ID, { action: 'resolve', url }).catch(() => null);
  return typeof reply?.found === 'boolean' ? reply : null;
}

async function resolve(url) {
  const started = Date.now();
  const native = await nativeLookup(url);
  let id, report;
  if (native) {
    id = native.found ? native.id : null;
    report = { ranged: native.ranged, native: true, newsHeaders: native.newsHeaders === true, ms: Date.now() - started };
  } else {
    id = await owlResolve(url).catch(() => undefined);
    report = { ...owlLastLookup, native: false, ms: Date.now() - started };
  }
  await browser.storage.local.set({ lastLookup: { ...report, at: Date.now() } });
  syncToApp().catch(() => {});
  return id;
}

/* Hits and misses are kept; a failed lookup is dropped so the next visit tries again. */
function lookup(url) {
  if (!lookups.has(url)) {
    const pending = resolve(url);
    lookups.set(url, pending);
    pending.then((id) => { if (id === undefined) lookups.delete(url); }, () => lookups.delete(url));
  }
  return lookups.get(url);
}

/*
 * The app shows the extension's settings and where it has run, which Safari
 * doesn't expose to it. Each report replaces the last one.
 */
async function syncToApp() {
  if (!IS_SAFARI) return;
  const { sites, auto, manual, manualAt } = await settings();
  const { seen = {}, active = 0, lastLookup = null } = await browser.storage.local.get(['seen', 'active', 'lastLookup']);
  const reply = await browser.runtime.sendNativeMessage(APP_ID, { action: 'sync', state: { sites, auto, seen, active, lastLookup, manual, manualAt } });
  await adoptFromApp(reply);
}

/*
 * The app can edit the button-only sites too. Whichever side changed them
 * last wins; the app's copy arrives with any native reply.
 */
async function adoptFromApp(reply) {
  if (!(reply?.manualAt > (await settings()).manualAt)) return;
  await browser.storage.local.set({ manual: reply.manual ?? {}, manualAt: reply.manualAt });
}

async function pullFromApp() {
  if (!IS_SAFARI) return;
  await adoptFromApp(await browser.runtime.sendNativeMessage(APP_ID, { action: 'pull' }).catch(() => null));
}

/* Records that the extension ran (on an enabled site, if given), reporting it when stale. */
async function noteActivity(site) {
  const now = Date.now();
  const { seen = {}, active = 0 } = await browser.storage.local.get(['seen', 'active']);
  const stale = (t) => now - (t ?? 0) > SYNC_INTERVAL_MS;
  if (!stale(active) && !(site && stale(seen[site]))) return;
  await browser.storage.local.set({ active: now, ...(site && { seen: { ...seen, [site]: now } }) });
  await syncToApp();
}

async function setTabIcon(tabId, id) {
  const { path, title } = iconFor(id, browser.runtime.getManifest());
  await Promise.all([browser.action.setIcon({ tabId, path }), browser.action.setTitle({ tabId, title })]);
}

/*
 * Whether the tab still shows this page. Query and fragment are ignored: sites
 * often rewrite them in place.
 */
async function stillOn(tabId, url) {
  if (tabId === undefined) return false;
  const page = (u) => { const { origin, pathname } = new URL(u); return origin + pathname; };
  const tab = await browser.tabs.get(tabId);
  return Boolean(tab.url) && page(tab.url) === page(url);
}

/* With no popup, a click on the toolbar button fires action.onClicked instead. */
async function setTabPopup(tabId, on) {
  await browser.action.setPopup({ tabId, popup: on ? browser.runtime.getManifest().action.default_popup : '' });
}

/* Opens the article as the popup's Open in News button does. */
async function openInTab(tab, id) {
  const { opened } = await openArticle(id);
  if (!opened) await browser.tabs.update(tab.id, { url: `applenewss:///${id}` });
}

async function checkPage(urlString, tabId) {
  const url = new URL(urlString);
  const { sites } = await settings();
  const site = siteFor(url.hostname, sites);
  noteActivity(site && sites[site] ? site : null).catch(() => {});
  if (!site || !sites[site] || !hasArticleSlug(url)) return null;

  const id = await lookup(urlString);
  if (id === null && await stillOn(tabId, urlString).catch(() => false)) setTabIcon(tabId, null).catch(() => {});
  if (!id) return null;

  await pullFromApp();
  const current = await settings();
  const { opened } = current;
  const now = Date.now();
  const automatic = autoOpens(current, site);
  const openNow = automatic && !(now - (opened[urlString] ?? 0) < COOLDOWN_MS);
  // Not opening by itself: the toolbar button opens the article in one click.
  if (!automatic && await stillOn(tabId, urlString).catch(() => false)) setTabPopup(tabId, false).catch(() => {});
  if (openNow) {
    const recent = Object.fromEntries(Object.entries(opened).filter(([, t]) => now - t < COOLDOWN_MS));
    await browser.storage.local.set({ opened: { ...recent, [urlString]: now } });
  }
  return { id, openNow };
}

async function siteIsOn(urlString) {
  const { sites } = await settings();
  const site = siteFor(new URL(urlString).hostname, sites);
  return Boolean(site && sites[site]);
}

/* Whether this page should be one-click, decided as checkPage does: an article News has that won't open by itself. */
async function opensOnClick(urlString) {
  const url = new URL(urlString);
  const current = await settings();
  const site = siteFor(url.hostname, current.sites);
  if (!site || !current.sites[site] || !hasArticleSlug(url) || autoOpens(current, site)) return false;
  return Boolean(await lookup(urlString));
}

/* Opens News from the native handler, which only does so on the Mac. */
async function openArticle(id) {
  if (!IS_SAFARI) return { opened: false };
  const reply = await browser.runtime.sendNativeMessage(APP_ID, { action: 'open', id }).catch(() => null);
  return { opened: reply?.opened === true };
}

async function siteStatus(host) {
  await pullFromApp();
  const { sites, auto, manual } = await settings();
  const site = siteFor(host, sites);
  return { site: site ?? host.replace(/^www\./, ''), on: !!(site && sites[site]), auto, siteAuto: !(site && manual[site]) };
}

async function setSite(site, on) {
  const { sites } = await settings();
  await browser.storage.local.set({ sites: { ...sites, [site]: on } });
  await syncToApp().catch(() => {});
}

async function setSiteAuto(site, on) {
  const { manual } = await settings();
  const next = { ...manual };
  if (on) delete next[site];
  else next[site] = true;
  await browser.storage.local.set({ manual: next, manualAt: Date.now() });
  await syncToApp().catch(() => {});
}

async function setAuto(on) {
  await browser.storage.local.set({ auto: on });
  await syncToApp().catch(() => {});
}

const handlers = {
  checkPage: (m, sender) => checkPage(m.url, sender.tab?.id),
  lookup: async (m) => ({ id: await lookup(m.url) }),
  open: (m) => openArticle(m.id),
  siteStatus: (m) => siteStatus(m.host),
  setSite: (m) => setSite(m.site, m.on),
  setAuto: (m) => setAuto(m.on),
  setSiteAuto: (m) => setSiteAuto(m.site, m.on),
  popupShown: () => settingsShown(true)
};

// Callback style: Chrome ignores a promise returned from the listener.
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = handlers[message.action];
  if (!handler) return false;
  Promise.resolve(handler(message, sender)).then(sendResponse, (e) => sendResponse({ error: String(e) }));
  return true;
});

// A new page starts with the normal icon and the popup; checkPage changes them.
browser.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status !== 'loading') return;
  setTabIcon(tabId, undefined).catch(() => {});
  setTabPopup(tabId, true).catch(() => {});
});

/*
 * Shows the settings popup for a tab. If the popup doesn't report in shortly,
 * the settings open in a new tab instead. With `oneClick`, a one-click page
 * gets its popup removed again once the popup has shown.
 */
const SETTINGS_WAIT_MS = 1500;
let settingsShown = () => {};

async function showSettings(tab, { oneClick = false } = {}) {
  let resolve;
  const shown = new Promise((r) => { resolve = settingsShown = r; });
  setTimeout(() => resolve(false), SETTINGS_WAIT_MS);
  // No await before openPopup: Safari may only open it straight from the click.
  setTabPopup(tab.id, true).catch(() => {});
  browser.action.openPopup().catch(() => resolve(false));
  if (!(await shown)) await browser.tabs.create({ url: browser.runtime.getURL(`popup.html?tab=${tab.id}`) });
  if (oneClick && await opensOnClick(tab.url).catch(() => false)) await setTabPopup(tab.id, false);
}

// Only fires on a tab whose popup checkPage removed.
browser.action.onClicked.addListener(async (tab) => {
  // The site may have been turned off since checkPage.
  const id = await siteIsOn(tab.url).catch(() => false) && await lookup(tab.url);
  if (id) return openInTab(tab, id);
  // The site is off, or the article can't be found now (lookup failed, or the page changed).
  return showSettings(tab);
});

// Safari passes no click modifiers, so the settings sit in the button's right-click
// menu. iOS has no such menu.
// Caught: in Chrome's service worker a throw here would stop the whole script loading.
try {
  browser.contextMenus?.removeAll().then(() =>
    browser.contextMenus.create({ id: 'settings', title: 'Settings\u2026', contexts: ['action'] })).catch((e) => console.error('Settings menu:', e));
  browser.contextMenus?.onClicked.addListener((info, tab) => {
    if (info.menuItemId === 'settings' && tab) showSettings(tab, { oneClick: true });
  });
} catch (e) {
  console.error('Settings menu:', e);
}
