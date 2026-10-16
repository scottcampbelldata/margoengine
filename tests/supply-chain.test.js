import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { BUNDLED, publishedPackages } from '../scripts/supply-chain.mjs';

// Launch gate 11c: THIRD-PARTY-NOTICES.md is current and its rules hold, and every published tarball ships its
// licence and notices and nothing else. The file lists come from npm's own npm-packlist (what `npm pack` uses), loaded
// from the npm running this test, so 75 packages take about a second instead of a minute of `npm pack --dry-run`.
// Needs `npm run build:packages` first (verify does): LICENSE and the dist notices are copied by the builds.
const root = resolve(import.meta.dirname, '..');
const npmRoot = [
  process.env.npm_execpath && resolve(dirname(process.env.npm_execpath), '..'),
  join(dirname(process.execPath), 'node_modules/npm'),
  join(dirname(process.execPath), '../lib/node_modules/npm'),
].find((dir) => dir && existsSync(join(dir, 'node_modules/npm-packlist')));
const npmRequire = npmRoot && createRequire(join(npmRoot, 'package.json'));

test('THIRD-PARTY-NOTICES.md is current and every supply-chain rule holds', () => {
  execFileSync(process.execPath, [join(root, 'scripts/supply-chain.mjs'), '--check'], { cwd: root, stdio: 'pipe' });
});

test('every published tarball ships LICENSE, README and its notices, and no sources, tests or source maps', async () => {
  assert.ok(npmRoot, 'npm-packlist not found next to this npm');
  assert.ok(existsSync(join(root, 'packages/core/dist')), 'run npm run build:packages first');
  const packlist = npmRequire('npm-packlist'),
    Arborist = npmRequire('@npmcli/arborist');
  for (const { dir, manifest } of publishedPackages()) {
    const name = manifest.name,
      paths = new Set(await packlist(await new Arborist({ path: join(root, dir) }).loadActual()));
    for (const required of ['LICENSE', 'README.md', 'package.json'])
      assert.ok(paths.has(required), `${name}: ${required}`);
    for (const b of BUNDLED.filter((b) => b.package.split(', ').includes(name)))
      for (const notice of b.notices) assert.ok(paths.has(notice), `${name}: missing ${notice} (${b.component})`);
    for (const path of paths)
      assert.doesNotMatch(
        path,
        /^(src|scripts)\/|(^|\/)(tests?|fixtures|__\w+)\/|\.map$|\.tsbuildinfo$|(^|\/)\.env|\.(pem|key|p12)$|\.npmrc$/,
        `${name}: unexpected file in the tarball: ${path}`,
      );
  }
});
