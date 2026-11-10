import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Batch 132 audit: the README's third-party table named only the 3D solver's engine and react, while the manifest also
// has the 2D solver's engine (physics2d) as an optional peer. Every optional third-party peer must be in the install table.
test('the README third-party table names every optional third-party peer the manifest declares', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const section = readme.split('## Third-party libraries')[1] ?? '';
  const installs = [...section.matchAll(/`npm i ([^`]+)`/g)].flatMap((match) => match[1].split(/\s+/));
  for (const peer of Object.keys(manifest.peerDependencies ?? {})) {
    assert.ok(installs.includes(peer), `${peer} is a peer of margoengine but missing from the README install table`);
  }
  for (const name of installs) {
    assert.ok(name in (manifest.peerDependencies ?? {}), `${name} is in the README table but is not a declared peer`);
  }
});
