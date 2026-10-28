/*
 * Decides whether a page should open in News, using owl.js to look it up in
 * Apple's index. A page is only looked up on sites you have turned on; a miss
 * means News has no copy, so the page is left alone.
 */

const COOLDOWN_MS = 15 * 60 * 1000; // don't auto-open the same URL twice in this window

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

function lookup(url) {
  if (!lookups.has(url)) lookups.set(url, owlResolve(url).catch(() => null));
  return lookups.get(url);
}

async function checkPage(urlString) {
  const url = new URL(urlString);
  const { sites, auto, opened } = await settings();
  const site = siteFor(url.hostname, sites);
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

async function siteStatus(host) {
  const { sites, auto } = await settings();
  const site = siteFor(host, sites);
  return { site: site ?? host.replace(/^www\./, ''), on: !!(site && sites[site]), auto };
}

async function setSite(site, on) {
  const { sites } = await settings();
  await browser.storage.local.set({ sites: { ...sites, [site]: on } });
}

const handlers = {
  checkPage: (m) => checkPage(m.url),
  lookup: async (m) => ({ id: await lookup(m.url) }),
  siteStatus: (m) => siteStatus(m.host),
  setSite: (m) => setSite(m.site, m.on),
  setAuto: (m) => browser.storage.local.set({ auto: m.on })
};

browser.runtime.onMessage.addListener((message) => handlers[message.action]?.(message));
