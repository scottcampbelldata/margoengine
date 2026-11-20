// The frozen physics2d step-profile bundle (docs/whitepaper/results/physics2d-step-profile-20261108) pins every file's
// bytes in bundle-manifest.json, and its verify.mjs checks them. Repository-wide sweeps (the GPU lock removal, the
// process.exit sweep) edited six bundle files without restating their hashes, so verify.mjs failed for days and
// nothing ran it. An edit to a bundle file now restates its hash in the manifest's `editsAfterFreeze`, or this fails.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const bundle = resolve(import.meta.dirname, '../docs/whitepaper/results/physics2d-step-profile-20261108');

test('the physics2d step-profile bundle verifies against its manifest', () => {
  const run = spawnSync(process.execPath, [join(bundle, 'verify.mjs')], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(run.error, undefined);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^Verified \d+ bundled files/);
});

test('every file edited after the freeze is named, and the measurements are unchanged', () => {
  const manifest = JSON.parse(readFileSync(join(bundle, 'bundle-manifest.json'), 'utf8'));
  const listed = new Set(manifest.files.map((f) => f.path));
  for (const file of manifest.editsAfterFreeze.files) assert.ok(listed.has(file), file);
  assert.equal(manifest.editsAfterFreeze.sourceAndMeasurementsChanged, false);
});
