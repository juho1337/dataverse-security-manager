// Runs the official PPTB manifest rules (the library behind `pptb-validate`, shipped with @pptb/types) WITHOUT the URL reachability checks,
// and checks that the icon exists in dist/. `pptb-validate` 1.0.5 checks URLs always (its --skip-url-checks flag is documented but not
// honoured), so this script is what runs in CI and before the public repository exists. `npm run validate` is the full check.
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const here = createRequire(import.meta.url);
const fromTypes = createRequire(here.resolve('@pptb/types/package.json'));
const { validatePackageJson } = fromTypes('@pptb/validate');

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const result = await validatePackageJson(pkg, { skipUrlChecks: true });
const problems = [...result.errors];
if (pkg.private === true) problems.push('"private": true must not be set in the publication manifest');
if (!pkg.name?.startsWith('@')) problems.push('name must be scoped (@scope/name)');
if (pkg.icon && !existsSync(new URL(`../dist/${pkg.icon}`, import.meta.url))) problems.push(`icon not found in dist/: ${pkg.icon} (run npm run build)`);

result.warnings.forEach((w) => console.warn(`warning: ${w}`));
if (problems.length > 0) {
  console.error('PPTB manifest validation (offline) FAILED:\n- ' + problems.join('\n- '));
  process.exit(1);
}
console.log(`PPTB manifest validation (offline) passed for ${pkg.name}@${pkg.version} (URL reachability not checked; run \`npm run validate\` once the repository is public).`);
