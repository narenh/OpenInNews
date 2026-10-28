/*
 * Decides whether a page should open in News, using owl.js to look it up in
 * Apple's index. A page is only looked up on sites you have turned on; a miss
 * means News has no copy, so the page is left alone.
 */

const COOLDOWN_MS = 15 * 60 * 1000; // don't auto-open the same URL twice in this window
const SYNC_INTERVAL_MS = 10 * 60 * 1000; // report activity to the app at most this often
const APP_ID = 'com.canopysf.OpenInNews';

// Safari extensions come with a native handler; Chrome's has none.
const IS_SAFARI = browser.runtime.getURL('').startsWith('safari-web-extension:');

async function settings() {
  const stored = await browser.storage.local.get(['sites', 'auto', 'opened']);
  return {
    sites: stored.sites ?? Object.fromEntries(self.SEED_SITES.map((s) => [s, true])),
    auto: stored.auto ?? true,
    opened: stored.opened ?? {}
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

const lookups = new Map(); // url -> Promise<article ID | null>

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
    id = await owlResolve(url).catch(() => null);
    report = { ...owlLastLookup, native: false, ms: Date.now() - started };
  }
  await browser.storage.local.set({ lastLookup: { ...report, at: Date.now() } });
  syncToApp().catch(() => {});
  return id;
}

function lookup(url) {
  if (!lookups.has(url)) lookups.set(url, resolve(url));
  return lookups.get(url);
}

/*
 * The app shows the extension's settings and where it has run, which Safari
 * doesn't expose to it. Each report replaces the last one.
 */
async function syncToApp() {
  if (!IS_SAFARI) return;
  const { sites, auto } = await settings();
  const { seen = {}, active = 0, lastLookup = null } = await browser.storage.local.get(['seen', 'active', 'lastLookup']);
  await browser.runtime.sendNativeMessage(APP_ID, { action: 'sync', state: { sites, auto, seen, active, lastLookup } });
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

async function checkPage(urlString) {
  const url = new URL(urlString);
  const { sites, auto, opened } = await settings();
  const site = siteFor(url.hostname, sites);
  noteActivity(site && sites[site] ? site : null).catch(() => {});
  if (!site || !sites[site] || !hasArticleSlug(url)) return null;

  const id = await lookup(urlString);
  if (!id) return null;

  const now = Date.now();
  const openNow = auto && !(now - (opened[urlString] ?? 0) < COOLDOWN_MS);
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
  const { sites, auto } = await settings();
  const site = siteFor(host, sites);
  return { site: site ?? host.replace(/^www\./, ''), on: !!(site && sites[site]), auto };
}

async function setSite(site, on) {
  const { sites } = await settings();
  await browser.storage.local.set({ sites: { ...sites, [site]: on } });
  await syncToApp().catch(() => {});
}

async function setAuto(on) {
  await browser.storage.local.set({ auto: on });
  await syncToApp().catch(() => {});
}

const handlers = {
  checkPage: (m) => checkPage(m.url),
  lookup: async (m) => ({ id: await lookup(m.url) }),
  open: (m) => openArticle(m.id),
  siteStatus: (m) => siteStatus(m.host),
  setSite: (m) => setSite(m.site, m.on),
  setAuto: (m) => setAuto(m.on)
};

// Callback style: Chrome ignores a promise returned from the listener.
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = handlers[message.action];
  if (!handler) return false;
  Promise.resolve(handler(message)).then(sendResponse, (e) => sendResponse({ error: String(e) }));
  return true;
});
