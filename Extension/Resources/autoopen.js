/*
 * Per-site modes. Each site is off (not checked), ask (the button offers News
 * but nothing opens by itself) or auto (News opens by itself, and the button is
 * there too). A site that isn't in the map is off.
 */
const MODES = ['off', 'ask', 'auto'];

function modeFor(modes, site) {
  return (site && modes[site]) || 'off';
}

/* Whether a hit on this site opens News by itself. */
function autoOpens({ modes }, site) {
  return modeFor(modes, site) === 'auto';
}

/* Keeps only entries with a valid mode. */
function cleanModes(modes) {
  return Object.fromEntries(Object.entries(modes ?? {}).filter(([, m]) => MODES.includes(m)));
}

/*
 * The mode map for stored settings. Settings from before modes had three
 * separate pieces: `sites` (site -> on), a global `auto`, and `manual` (the
 * button-only sites). A site that was on becomes auto, or ask if it was
 * button-only or automatic opening was off globally; a site that was off or
 * missing is off. With none of them stored (a fresh install) the seed sites
 * are all auto. `at` is when the map was last edited: 0 for a migrated one, so
 * an edit in the app always wins over it.
 */
function modesFrom(stored, seeds) {
  if (stored.modes) return { modes: cleanModes(stored.modes), at: stored.modesAt ?? 0, migrated: false };
  const sites = stored.sites ?? Object.fromEntries(seeds.map((s) => [s, true]));
  const modes = {};
  for (const [site, on] of Object.entries(sites)) {
    modes[site] = !on ? 'off' : stored.auto === false || stored.manual?.[site] ? 'ask' : 'auto';
  }
  return { modes, at: 0, migrated: true };
}

if (typeof module !== 'undefined') module.exports = { MODES, modeFor, autoOpens, cleanModes, modesFrom };
