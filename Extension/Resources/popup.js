const $ = (id) => document.getElementById(id);
const send = (action, fields = {}) => browser.runtime.sendMessage({ action, ...fields });

(async () => {
  send('popupShown');
  // Opened in a tab of its own (see showSettings), the page names the tab it is for.
  const forTab = new URLSearchParams(location.search).get('tab');
  // A closed tab leaves `tab` empty, which shows "Open a web page first."
  const tab = forTab ? await browser.tabs.get(Number(forTab)).catch(() => null) : (await browser.tabs.query({ active: true, currentWindow: true }))[0];
  if (!/^https?:/.test(tab?.url ?? '')) {
    $('open').disabled = true;
    $('note').textContent = 'Open a web page first.';
    document.querySelectorAll('.row').forEach((row) => row.hidden = true);
    return;
  }

  const { site, on, auto, siteAuto } = await send('siteStatus', { host: new URL(tab.url).hostname });
  $('site').textContent = site;
  $('site-on').checked = on;
  $('auto').checked = auto;
  $('site-auto').checked = siteAuto;
  // Only matters when the site is on and automatic opening is on.
  const showSiteAuto = () => { $('site-auto').disabled = !($('site-on').checked && $('auto').checked); };
  showSiteAuto();

  $('site-on').onchange = (e) => { send('setSite', { site, on: e.target.checked }); showSiteAuto(); };
  $('auto').onchange = (e) => { send('setAuto', { on: e.target.checked }); showSiteAuto(); };
  $('site-auto').onchange = (e) => send('setSiteAuto', { site, on: e.target.checked });

  $('open').onclick = async () => {
    $('open').disabled = true;
    $('note').textContent = 'Looking it up\u2026';
    const { id } = await send('lookup', { url: tab.url });
    if (!id) {
      $('note').textContent = 'Apple News doesn\u2019t have this page.';
      $('open').disabled = false;
      return;
    }
    const { opened } = await send('open', { id });
    if (!opened) await browser.tabs.update(tab.id, { url: `applenewss:///${id}` });
    window.close();
  };
})();
