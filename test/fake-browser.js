// Loads the real background.js against a fake browser, with the lookup stubbed.
const fs = require('node:fs');
const vm = require('node:vm');
const R = `${__dirname}/../Extension/Resources/`;

/*
 * openPopup: what browser.action.openPopup does after recording the call. By
 * default the popup opens and, like popup.js, reports in. timers: false stops
 * background.js's timers from ever firing.
 */
function load(owlResolve, { openPopup, timers = true, contextMenus = true, menuError } = {}) {
  const tabs = {}, icons = {}, popups = {}, store = {}, navigated = {}, created = [], menus = [];
  let onMessage, onUpdated, onClicked, onMenuClicked, popupsOpened = 0;
  const browser = {
    runtime: {
      getURL: (path) => `chrome-extension://x/${path}`,
      getManifest: () => JSON.parse(fs.readFileSync(R + 'manifest.json', 'utf8')),
      onMessage: { addListener: (f) => { onMessage = f; } }
    },
    storage: { local: { get: async (keys) => Object.fromEntries(keys.filter((k) => k in store).map((k) => [k, store[k]])), set: async (o) => Object.assign(store, o) } },
    tabs: {
      get: async (id) => (id in tabs ? { id, url: tabs[id] } : Promise.reject(new Error('no tab'))),
      update: async (id, { url }) => { navigated[id] = url; },
      create: async ({ url }) => { created.push(url); },
      onUpdated: { addListener: (f) => { onUpdated = f; } }
    },
    action: {
      setIcon: async ({ tabId, path }) => { icons[tabId] = { ...icons[tabId], gray: path[16].includes('gray') }; },
      setTitle: async ({ tabId, title }) => { icons[tabId] = { ...icons[tabId], title }; },
      setPopup: async ({ tabId, popup }) => { popups[tabId] = popup; },
      openPopup: async () => { popupsOpened++; await (openPopup ? openPopup() : message({ action: 'popupShown' })); },
      onClicked: { addListener: (f) => { onClicked = f; } }
    },
    contextMenus: {
      removeAll: async () => { menus.length = 0; },
      ...(menuError === 'sync' && { removeAll: () => { throw new Error('removeAll'); } }),
      create: (item) => { if (menuError) throw menuError; menus.push(item); },
      onClicked: { addListener: (f) => { onMenuClicked = f; } }
    }
  };
  if (!contextMenus) delete browser.contextMenus;
  // Timers run 100 times faster, so waits in background.js stay short here.
  const ctx = vm.createContext({ browser, console, URL, Date, Promise, Object, Map, Boolean, String, JSON, Number, setTimeout: (f, ms) => timers && setTimeout(f, ms / 100) });
  ctx.self = ctx;
  for (const f of ['sites.js', 'autoopen.js', 'icon.js', 'background.js']) vm.runInContext(fs.readFileSync(R + f, 'utf8'), ctx);
  ctx.owlResolve = owlResolve;
  ctx.owlLastLookup = {};
  const settle = () => new Promise((r) => setTimeout(r, 30));
  function message(m, sender = {}) { return new Promise((res) => onMessage(m, sender, res)); }
  return {
    icons, popups, navigated, created, menus, popupsOpened: () => popupsOpened,
    async visit(tabId, url, { tabUrl = url } = {}) {
      if (tabUrl) { tabs[tabId] = tabUrl; onUpdated(tabId, { status: 'loading' }); }
      await message({ action: 'checkPage', url }, { tab: { id: tabId } });
      await settle();
    },
    async navigate(tabId, url) { tabs[tabId] = url; onUpdated(tabId, { status: 'loading' }); await settle(); },
    async click(tabId) { const error = await onClicked({ id: tabId, url: tabs[tabId] }).then(() => null, (e) => e); await settle(); return error; },
    async menuClick(tabId, menuItemId = 'settings') { onMenuClicked({ menuItemId }, { id: tabId, url: tabs[tabId] }); await settle(); },
    message
  };
}

module.exports = { load };
