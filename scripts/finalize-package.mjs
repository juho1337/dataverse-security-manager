// Finishes dist/ after the Vite build: writes dist/package.json (the tool manifest PPTB reads from the dist root: no scripts, no dev
// dependencies) and dist/THIRD-PARTY-NOTICES.txt (runtime dependencies bundled into app.js, from the lockfile).
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const manifest = {
  name: pkg.name,
  version: pkg.version,
  displayName: pkg.displayName,
  description: pkg.description,
  icon: pkg.icon,
  main: pkg.main,
  author: pkg.author,
  license: pkg.license,
  contributors: pkg.contributors,
  keywords: pkg.keywords,
  configurations: pkg.configurations,
  features: pkg.features,
};
writeFileSync(new URL('../dist/package.json', import.meta.url), JSON.stringify(manifest, null, 2) + '\n');
execFileSync(process.execPath, [fileURLToPath(new URL('./generate-notices.mjs', import.meta.url)), fileURLToPath(new URL('../dist/THIRD-PARTY-NOTICES.txt', import.meta.url))], { stdio: 'inherit' });
console.log(`dist/package.json written for ${manifest.name}@${manifest.version}`);
