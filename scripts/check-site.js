#!/usr/bin/env node
/*
 * Reports how many of a site's current articles Apple News can open.
 *
 *   node scripts/check-site.js wsj.com theatlantic.com …
 *
 * Fetches each site's homepage, picks out links that look like articles, and
 * resolves up to 12 of them against Apple's index. A site worth adding to
 * sites.js resolves most of them.
 */
const { owlResolve } = require('../Extension/Resources/owl.js');

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';

async function articleLinks(site) {
  const res = await fetch(`https://www.${site}/`, { headers: { 'User-Agent': UA } })
    .catch(() => fetch(`https://${site}/`, { headers: { 'User-Agent': UA } }));
  const html = await res.text();
  const links = new Set();
  for (const [, href] of html.matchAll(/href="([^"#]+)"/g)) {
    let url;
    try { url = new URL(href, res.url); } catch { continue; }
    if (url.hostname !== site && !url.hostname.endsWith('.' + site)) continue;
    const last = url.pathname.split('/').filter(Boolean).pop() || '';
    if ((last.match(/-/g) || []).length >= 3) links.add(url.origin + url.pathname);
  }
  return [...links].slice(0, 12);
}

(async () => {
  for (const site of process.argv.slice(2)) {
    try {
      const links = await articleLinks(site);
      const ids = await Promise.all(links.map(owlResolve));
      const hits = ids.filter(Boolean).length;
      console.log(`${site.padEnd(24)} ${hits}/${links.length}`);
    } catch (e) {
      console.log(`${site.padEnd(24)} error: ${e.message}`);
    }
  }
})();
