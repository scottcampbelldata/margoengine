import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// A fixture file is an explicit audit boundary, not a syntactic waiver: a package is gated once it has
// packages/<name>/test(s)/owner-lifetime.fixture.js. A selected package with none is printed as pending by every
// owner/lifetime check, never counted as a pass.
const root = fileURLToPath(new URL('../../', import.meta.url));
export const OWNER_FIXTURES = Object.fromEntries(readdirSync(`${root}packages`).sort().flatMap((name) =>
  ['tests', 'test'].map((dir) => `packages/${name}/${dir}/owner-lifetime.fixture.js`)
    .filter((file) => existsSync(root + file)).slice(0, 1).map((file) => [name, file])));
export const OWNER_EXCLUSIONS = {
  core: 'Core is the engine every fixture runs on; its scene routing, plugins and frame graph are exercised by all of them.',
  physics: 'Physics is on hold (Scott, 2026-11-10).',
  physics2d: 'Physics is on hold (Scott, 2026-11-10).',
  ragdoll: 'Physics is on hold (Scott, 2026-11-10).',
};

const known = (name) => existsSync(`${root}packages/${name}/package.json`);

/** Splits a package selection into fixtures to run and packages still pending a fixture. Unknown names throw. */
export function selectOwnerPackages(packages, registered = OWNER_FIXTURES, exists = known) {
  const unknown = packages.filter((name) => !registered[name] && !exists(name));
  if (unknown.length) throw new Error(`OWNER_UNKNOWN_PACKAGE: ${unknown.join(', ')}`);
  return {
    selected: packages.filter((name) => registered[name]),
    pending: packages.filter((name) => !registered[name] && !OWNER_EXCLUSIONS[name]),
  };
}

/** The pending line every owner/lifetime check prints; an empty list prints nothing. */
export function pendingLine(pending) {
  return pending.length
    ? `Owner/lifetime pending, no fixture yet, NOT checked (${pending.length}): ${pending.join(', ')}`
    : '';
}
