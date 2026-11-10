#!/usr/bin/env node
// Writes Shared/SeedSites.swift from Extension/Resources/sites.js, so the app
// and the extension share one list.
//
//   node scripts/gen-seed-sites.js
//
// test/seed-sites.test.js fails if the checked-in file is out of date.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');

function generate() {
  const ctx = vm.createContext({});
  ctx.self = ctx;
  vm.runInContext(fs.readFileSync(path.join(root, 'Extension/Resources/sites.js'), 'utf8'), ctx);
  const sites = Array.from(ctx.SEED_SITES);
  return `// Generated from Extension/Resources/sites.js by scripts/gen-seed-sites.js. Do not edit.

/// The sites the extension starts with, as in its sites.js.
let seedSites: [String] = [
${sites.map((s) => `    "${s}",`).join('\n')}
]
`;
}

const out = path.join(root, 'Shared/SeedSites.swift');
if (require.main === module) fs.writeFileSync(out, generate());
module.exports = { generate, out };
