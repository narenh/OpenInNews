/*
 * Asks the background script whether this page is an Apple News article. On a
 * hit it opens News (if automatic) and shows a pill that opens the article.
 *
 * On iPhone and iPad the pill links to https://apple.news/<id>, a universal
 * link, which opens News directly when tapped from a publisher's page. Elsewhere
 * the background script opens News natively (Safari on the Mac) or the page
 * navigates to the applenewss: scheme, which Chrome confirms in a dialog.
 */
(() => {
  if (window.top !== window) return;

  const touchDevice = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  function openArticle(id) {
    const viaScheme = () => { location.href = `applenewss:///${id}`; };
    if (touchDevice) return viaScheme();
    browser.runtime.sendMessage({ action: 'open', id }).then((r) => r?.opened || viaScheme(), viaScheme);
  }

  browser.runtime.sendMessage({ action: 'checkPage', url: location.href }).then((result) => {
    if (!result?.id) return;
    if (result.openNow) openArticle(result.id);
    if (document.body) showPill(result.id);
    else document.addEventListener('DOMContentLoaded', () => showPill(result.id), { once: true });
  }, () => {});

  function showPill(id) {
    const host = document.createElement('div');
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;left:50%;transform:translateX(-50%);bottom:calc(16px + env(safe-area-inset-bottom))';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>
        .pill { display:flex; align-items:center; gap:4px; padding:4px; border-radius:999px;
                background:rgba(28,28,30,.92); box-shadow:0 4px 16px rgba(0,0,0,.3);
                font:600 15px -apple-system,system-ui,sans-serif; -webkit-backdrop-filter:blur(12px); }
        a { color:#fff; text-decoration:none; padding:8px 12px 8px 14px; white-space:nowrap; }
        button { all:unset; color:rgba(255,255,255,.6); font-size:18px; line-height:1; padding:8px 12px; cursor:pointer; }
      </style>
      <div class="pill">
        <a href="https://apple.news/${id}">Open in News</a>
        <button aria-label="Dismiss">×</button>
      </div>`;
    if (!touchDevice) {
      root.querySelector('a').addEventListener('click', (e) => {
        e.preventDefault();
        openArticle(id);
      });
    }
    root.querySelector('button').addEventListener('click', () => host.remove());
    document.documentElement.appendChild(host);
  }
})();
