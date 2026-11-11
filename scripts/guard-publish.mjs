// `prepublishOnly` guard: the package is published from the exported public repository (a reviewed snapshot), never from the private
// development monorepo this folder also lives in. Refuses when the folder sits inside a monorepo checkout (AGENTS.md two levels up).
import { existsSync } from 'node:fs';

const inMonorepo = existsSync(new URL('../../../AGENTS.md', import.meta.url)) && existsSync(new URL('../../../pptb/', import.meta.url));
if (inMonorepo) {
  console.error('Refusing to publish from the development monorepo. Export the public snapshot and publish from there (see the maintainers\' release procedure).');
  process.exit(1);
}
