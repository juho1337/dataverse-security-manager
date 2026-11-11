// Verifies the build output is loadable by PPTB: classic script, no module/crossorigin, manifest and icon present.
import { existsSync, readFileSync } from 'node:fs';

const dist = new URL('../dist/', import.meta.url);
const problems = [];
const read = (name) => readFileSync(new URL(name, dist), 'utf8');

if (!existsSync(new URL('index.html', dist))) problems.push('dist/index.html is missing (run npm run build)');
else {
  const html = read('index.html');
  const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
  if (scripts.length !== 1) problems.push(`expected exactly one <script>, found ${scripts.length}`);
  if (/type="module"/.test(html)) problems.push('index.html still contains type="module"');
  if (/crossorigin/.test(html)) problems.push('index.html still contains crossorigin');
  if (/(src|href)="\//.test(html)) problems.push('index.html has absolute (non-relative) asset URLs; file:// loading would fail');
  if (!/src="\.\/app\.js"/.test(html)) problems.push('script src is not ./app.js');
  const body = html.slice(html.indexOf('<body'));
  if (!(body.indexOf('<script') > body.indexOf('id="root"'))) problems.push('script tag is not after the root element');
}
if (!existsSync(new URL('app.js', dist))) problems.push('dist/app.js is missing');
else {
  const js = read('app.js');
  if (/\bimport\s*\(|^\s*import\s.+from\s/m.test(js)) problems.push('app.js contains ES module import syntax');
  if (!/^\s*\(function|^\s*var\s+\w+\s*=\s*\(function|^\s*\(\(\)\s*=>|^\s*\(function\(/.test(js.slice(0, 400)) && !/\(function\s*\(/.test(js.slice(0, 2000)))
    problems.push('app.js does not look like an IIFE bundle');
}
if (!existsSync(new URL('package.json', dist))) problems.push('dist/package.json (manifest) is missing');
else {
  const m = JSON.parse(read('package.json'));
  for (const f of ['name', 'version', 'displayName', 'description', 'icon', 'author', 'keywords'])
    if (!m[f]) problems.push(`manifest field missing: ${f}`);
  if (!m.features?.minAPI) problems.push('manifest field missing: features.minAPI');
  if (m.icon && !existsSync(new URL(m.icon, dist))) problems.push(`icon file not found: ${m.icon}`);
}

if (problems.length) {
  console.error('Bundle check FAILED:\n- ' + problems.join('\n- '));
  process.exit(1);
}
console.log('Bundle check passed: single classic IIFE script, relative URLs, manifest and icon present.');
