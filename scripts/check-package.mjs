// Checks what `npm publish` would upload, independently of any other packaging script: runs `npm pack --dry-run --json` and verifies the
// file list and contents. Run through `npm run check:package` after `npm run build`.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../', import.meta.url);
const cli = process.env.npm_execpath;
if (!cli || !/npm-cli\.c?js$/.test(cli)) {
  console.error('Run this through npm: `npm run check:package`.');
  process.exit(1);
}
const out = execFileSync(process.execPath, [cli, 'pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] }).toString();
const info = JSON.parse(out)[0];
const files = info.files.map((f) => f.path.replace(/\\/g, '/')).sort();
const problems = [];

const required = ['package.json', 'LICENSE', 'README.md', 'dist/index.html', 'dist/app.js', 'dist/app.css', 'dist/package.json', 'dist/THIRD-PARTY-NOTICES.txt'];
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
required.push(`dist/${pkg.icon}`);
for (const r of required) if (!files.includes(r)) problems.push(`missing from the package: ${r}`);
for (const f of files) {
  // npm always adds the file named by `main` ("index.html", relative to dist/ for PPTB): at the package root that is the unbuilt Vite entry page,
  // which is harmless (the tool is served from dist/).
  const ok = f === 'package.json' || f === 'LICENSE' || f === 'README.md' || f === 'index.html' || f.startsWith('dist/');
  if (!ok) problems.push(`must not be published: ${f}`);
  if (/\.map$/.test(f) || /\.test\.[jt]sx?$/.test(f) || f.startsWith('src/')) problems.push(`must not be published: ${f}`);
}

const text = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
if (!/GNU GENERAL PUBLIC LICENSE\s+Version 3/.test(text('LICENSE'))) problems.push('LICENSE is not the GPL-3.0 text');
if (pkg.private === true) problems.push('package.json still says "private": true');

// Generic secret / personal-data patterns over every text file that would be uploaded. (The monorepo export adds its private denylist.)
const patterns = [
  [/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/, 'JWT-like token'],
  [/Bearer\s+[A-Za-z0-9._-]{30,}/, 'bearer token'],
  [/[A-Za-z]:\\(Users|source)\\/i, 'absolute Windows path'],
  [/(client_secret|password|apikey)\s*[:=]\s*['"][^'"]{8,}/i, 'credential assignment'],
];
for (const f of files.filter((x) => /\.(js|css|html|json|txt|svg|md)$/.test(x))) {
  const t = text(f);
  for (const [re, what] of patterns) if (re.test(t)) problems.push(`${f}: ${what}`);
}

if (problems.length > 0) {
  console.error('Package check FAILED:\n- ' + problems.join('\n- '));
  process.exit(1);
}
console.log(`Package check passed: ${info.name}@${info.version}, ${files.length} files, ${info.size} bytes packed, ${info.unpackedSize} unpacked.`);
console.log(files.map((f) => `  ${join(f)}`).join('\n'));
