/* Chrome only has `chrome`; Safari has both. The rest of the code uses `browser`. */
globalThis.browser ??= globalThis.chrome;
