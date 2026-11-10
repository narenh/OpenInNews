const $ = (id) => document.getElementById(id);
const send = (action, fields = {}) => browser.runtime.sendMessage({ action, ...fields });

(async () => {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!/^https?:/.test(tab?.url ?? '')) {
    $('open').disabled = true;
    $('note').textContent = 'Open a web page first.';
    $('site-settings').hidden = true;
    return;
  }

  const { site, mode } = await send('siteStatus', { host: new URL(tab.url).hostname });
  $('site').textContent = site;
  const hints = {
    off: 'Articles on this site aren\u2019t checked.',
    ask: 'Articles are checked. Tap the button on the page to open News.',
    auto: 'Articles are checked and open in News by themselves.'
  };
  const show = (m) => {
    document.querySelectorAll('.seg button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === m)));
    $('mode-hint').textContent = hints[m];
  };
  show(mode);
  document.querySelectorAll('.seg button').forEach((b) => {
    b.onclick = () => { show(b.dataset.mode); send('setMode', { site, mode: b.dataset.mode }); };
  });

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
