// Build stamp shown in the app footer: version, commit and build time, so the owner can see which build the host really loaded
// (the host can keep serving an old one). "+local" marks uncommitted changes in the working tree.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

function git(args) {
  try {
    return execSync(`git ${args}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
}

export function buildStamp() {
  const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  const sha = git('rev-parse --short HEAD') || 'nogit';
  const dirty = git('status --porcelain') !== '' ? '+local' : '';
  // SOURCE_DATE_EPOCH (seconds) makes the stamp, and with it the bundle, reproducible: scripts/pack-rc.mjs sets it to the commit time.
  const epoch = Number(process.env.SOURCE_DATE_EPOCH);
  const when = (Number.isFinite(epoch) && epoch > 0 ? new Date(epoch * 1000) : new Date()).toISOString().slice(0, 16).replace('T', ' ');
  return `v${version} · ${sha}${dirty} · built ${when} UTC`;
}
