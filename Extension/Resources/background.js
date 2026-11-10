/*
 * Decides whether a page should open in News, using owl.js to look it up in
 * Apple's index. A page is only looked up on sites whose mode is ask or auto;
 * a miss means News has no copy, so the page is left alone.
 */

const COOLDOWN_MS = 15 * 60 * 1000; // don't auto-open the same URL twice in this window
const SYNC_INTERVAL_MS = 10 * 60 * 1000; // report activity to the app at most this often
const APP_ID = 'com.canopysf.AutoOpenInNews';

// Safari extensions come with a native handler; Chrome's has none.
const IS_SAFARI = browser.runtime.getURL('').startsWith('safari-web-extension:');

async function settings() {
  const stored = await browser.storage.local.get(['sites', 'auto', 'manual', 'modes', 'modesAt', 'opened']);
  const { modes, at, migrated } = modesFrom(stored, self.SEED_SITES);
  if (migrated) await browser.storage.local.set({ modes, modesAt: at });
  return { modes, modesAt: at, opened: stored.opened ?? {} };
}

/* The sites that have a mode, plus the seed sites, which are off unless the map says otherwise. */
function knownSites(modes) {
  return { ...Object.fromEntries(self.SEED_SITES.map((s) => [s, 'off'])), ...modes };
}

/* The known site that covers this host: itself or its nearest parent. */
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
  const { modes, modesAt } = await settings();
  const { seen = {}, active = 0, lastLookup = null } = await browser.storage.local.get(['seen', 'active', 'lastLookup']);
  const reply = await browser.runtime.sendNativeMessage(APP_ID, { action: 'sync', state: { modes, modesAt, seen, active, lastLookup } });
  await adoptFromApp(reply);
}

/*
 * The app can edit the modes too. Whichever side changed them last wins; the
 * app's copy arrives with any native reply, and only when it is newer than
 * the `modesAt` the extension sent.
 */
async function adoptFromApp(reply) {
  if (!(reply?.modesAt > (await settings()).modesAt) || typeof reply.modes !== 'object') return;
  await browser.storage.local.set({ modes: cleanModes(reply.modes), modesAt: reply.modesAt });
}

async function pullFromApp() {
  if (!IS_SAFARI) return;
  const { modesAt } = await settings();
  await adoptFromApp(await browser.runtime.sendNativeMessage(APP_ID, { action: 'pull', modesAt }).catch(() => null));
}

/* Records that the extension ran (on a known site, if given), reporting it when stale. */
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
 * Grays the tab's icon for a page News lacks, unless the tab has moved on to
 * another page. Query and fragment are ignored: sites often rewrite them in place.
 */
async function showMissing(tabId, url) {
  if (tabId === undefined) return;
  const page = (u) => { const { origin, pathname } = new URL(u); return origin + pathname; };
  const tab = await browser.tabs.get(tabId);
  if (tab.url && page(tab.url) === page(url)) await setTabIcon(tabId, null);
}

async function checkPage(urlString, tabId) {
  const url = new URL(urlString);
  const { modes } = await settings();
  const site = siteFor(url.hostname, knownSites(modes));
  noteActivity(site).catch(() => {});
  if (modeFor(modes, site) === 'off' || !hasArticleSlug(url)) return null;

  const id = await lookup(urlString);
  if (id === null) showMissing(tabId, urlString).catch(() => {});
  if (!id) return null;

  await pullFromApp();
  const current = await settings();
  const { opened } = current;
  const now = Date.now();
  const openNow = autoOpens(current, site) && !(now - (opened[urlString] ?? 0) < COOLDOWN_MS);
  if (openNow) {
    const recent = Object.fromEntries(Object.entries(opened).filter(([, t]) => now - t < COOLDOWN_MS));
    await browser.storage.local.set({ opened: { ...recent, [urlString]: now } });
  }
  return { id, openNow };
}

/* Opens News from the native handler, which only does so on the Mac. */
async function openArticle(id) {
  if (!IS_SAFARI) return { opened: false };
  const reply = await browser.runtime.sendNativeMessage(APP_ID, { action: 'open', id }).catch(() => null);
  return { opened: reply?.opened === true };
}

async function siteStatus(host) {
  await pullFromApp();
  const { modes } = await settings();
  const site = siteFor(host, knownSites(modes));
  return { site: site ?? host.replace(/^www\./, ''), mode: modeFor(modes, site) };
}

async function setMode(site, mode) {
  if (!MODES.includes(mode)) return;
  const { modes } = await settings();
  await browser.storage.local.set({ modes: { ...modes, [site]: mode }, modesAt: Date.now() });
  await syncToApp().catch(() => {});
}

const handlers = {
  checkPage: (m, sender) => checkPage(m.url, sender.tab?.id),
  lookup: async (m) => ({ id: await lookup(m.url) }),
  open: (m) => openArticle(m.id),
  siteStatus: (m) => siteStatus(m.host),
  setMode: (m) => setMode(m.site, m.mode)
};

// Callback style: Chrome ignores a promise returned from the listener.
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = handlers[message.action];
  if (!handler) return false;
  Promise.resolve(handler(message, sender)).then(sendResponse, (e) => sendResponse({ error: String(e) }));
  return true;
});

// A new page starts with the normal icon; checkPage grays it if News lacks it.
browser.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === 'loading') setTabIcon(tabId, undefined).catch(() => {});
});
