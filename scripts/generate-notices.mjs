// Writes the third-party notice file for the package: every runtime (non-dev) dependency in the lockfile with its version, licence
// identifier and the licence text found in node_modules. This is an inventory, not a legal determination: a package whose licence text is
// missing is listed as such so that a person can look. Used by scripts/pack-rc.mjs; run on its own with `node scripts/generate-notices.mjs <out>`.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const lock = JSON.parse(readFileSync(new URL('package-lock.json', root), 'utf8'));
const entries = Object.entries(lock.packages ?? {})
  .filter(([path, p]) => path.startsWith('node_modules/') && p.dev !== true && p.optional !== true)
  .map(([path, p]) => ({ name: path.replace(/^.*node_modules\//, ''), dir: path, version: p.version, license: p.license ?? 'UNKNOWN' }))
  .sort((a, b) => a.name.localeCompare(b.name));

function licenseText(dir) {
  const folder = new URL(`${dir}/`, root);
  if (!existsSync(folder)) return null;
  const file = readdirSync(folder).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
  return file ? readFileSync(new URL(file, folder), 'utf8').trim() : null;
}

const own = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
const out = [
  `THIRD-PARTY NOTICES for ${own.displayName} ${own.version}`,
  '',
  'The tool bundles the runtime packages below into app.js. Development tools (compiler, test runner, linter, type definitions) are not part of the package.',
  'This list is generated from package-lock.json and node_modules; it is an inventory, not legal advice.',
  '',
];
for (const e of entries) {
  const text = licenseText(e.dir);
  out.push('='.repeat(78), `${e.name} ${e.version}  (${e.license})`, '='.repeat(78), '', text ?? '(no licence file found in the installed package: check the project before distributing)', '');
}
const target = process.argv[2];
if (!target) {
  console.error('usage: node scripts/generate-notices.mjs <output file>');
  process.exit(2);
}
writeFileSync(target, out.join('\n'), 'utf8');
console.log(`${entries.length} runtime package(s) listed in ${target}`);
