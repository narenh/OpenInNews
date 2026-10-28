const $ = (id) => document.getElementById(id);
const send = (action, fields = {}) => browser.runtime.sendMessage({ action, ...fields });

(async () => {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!/^https?:/.test(tab?.url ?? '')) {
    $('open').disabled = true;
    $('note').textContent = 'Open a web page first.';
    document.querySelectorAll('.row').forEach((row) => row.hidden = true);
    return;
  }

  const { site, on, auto } = await send('siteStatus', { host: new URL(tab.url).hostname });
  $('site').textContent = site;
  $('site-on').checked = on;
  $('auto').checked = auto;

  $('site-on').onchange = (e) => send('setSite', { site, on: e.target.checked });
  $('auto').onchange = (e) => send('setAuto', { on: e.target.checked });

  $('open').onclick = async () => {
    $('open').disabled = true;
    $('note').textContent = 'Looking it up…';
    const { id } = await send('lookup', { url: tab.url });
    if (!id) {
      $('note').textContent = 'Apple News doesn’t have this page.';
      $('open').disabled = false;
      return;
    }
    await browser.tabs.update(tab.id, { url: `applenewss:///${id}` });
    window.close();
  };
})();
