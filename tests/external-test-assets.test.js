import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { externalAssetRoot, requireExternalAssets, externalAssets } from '../scripts/support/external-test-assets.mjs';
import { SERIAL } from '../scripts/verify.mjs';

test('all worktrees and direct tests resolve the same external assets without an environment export', () => {
  assert.equal(externalAssetRoot({}), resolve(import.meta.dirname, '../../engine-bench/batch-160/gltf-gpu-samples'));
  assert.equal(
    externalAssetRoot({ MARGO_ENGINE_BENCH: 'test-results/bench' }),
    resolve('test-results/bench/batch-160/gltf-gpu-samples'),
  );
  assert.equal(externalAssetRoot({ MARGO_SPLAT_SAMPLES: 'test-results/override' }), resolve('test-results/override'));
  assert.ok(SERIAL.includes('node scripts/support/external-test-assets.mjs'));
  assert.equal(externalAssets.length, 352);
  for (const file of [
    'video/flower.mp4',
    'tower.glb',
    'racoonfamily.spz',
    'hornedlizard.spz',
    ...[
      'JointTypes',
      'ShapeTypes',
      'Filtering',
      'Triggers',
      'MotionProperties',
      'Materials_Friction',
      'Materials_Restitution',
    ].flatMap((name) => [`physics/${name}.gltf`, `physics/${name}.bin`]),
    'interactivity/test-index.json',
  ])
    assert.ok(
      externalAssets.some((asset) => asset.file === file),
      `Required family missing from download manifest: ${file}`,
    );
  assert.ok(
    externalAssets.every(
      ({ file, sha256, size, url }) =>
        !file.includes('..') && /^[a-f0-9]{64}$/.test(sha256) && size > 0 && url.startsWith('https://'),
    ),
  );
});

test('missing, partial, changed and LFS-only external caches fail loudly with the recovery command', () => {
  mkdirSync('test-results', { recursive: true });
  const root = mkdtempSync(resolve('test-results/external-assets-'));
  const bytes = Buffer.from('outside standard sample');
  const assets = ['index.json', 'companion.bin'].map((file) => ({
    file,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }));
  const check = () => requireExternalAssets('', { root, assets });
  const message = (name) => (error) =>
    error.message.includes(resolve(root, name)) &&
    error.message.includes('node scripts/reference-rendering/fetch-skip-assets.mjs');
  try {
    assert.throws(check, message('index.json'));
    writeFileSync(resolve(root, 'index.json'), bytes);
    assert.throws(check, message('companion.bin'));
    writeFileSync(resolve(root, 'companion.bin'), 'version https://git-lfs.github.com/spec/v1\n');
    assert.throws(check, message('companion.bin'));
    writeFileSync(resolve(root, 'companion.bin'), 'changed');
    assert.throws(check, message('companion.bin'));
    writeFileSync(resolve(root, 'companion.bin'), bytes);
    assert.equal(check(), root);
    const run = spawnSync(process.execPath, ['scripts/verify.mjs'], {
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, MARGO_SPLAT_SAMPLES: root, MARGO_RESULT_CACHE: 'off' },
    });
    assert.equal(run.error, undefined);
    assert.notEqual(run.status, 0);
    assert.match(run.stdout, /verify FAILED at node scripts\/support\/external-test-assets.mjs/);
    assert.match(run.stdout, /fetch-skip-assets.mjs/);
    assert.ok(!run.stdout.includes('=== npm run build:packages'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('physics sample provenance preserves the exact pinned commit in notices and the audit', () => {
  const commit = new URL(externalAssets.find(({ file }) => file.startsWith('physics/')).url).pathname.split('/')[3];
  for (const file of ['scripts/supply-chain.mjs', 'docs/work-lists/batch-160-skips.md']) {
    assert.ok(
      readFileSync(new URL('../' + file, import.meta.url), 'utf8').includes(commit),
      file + ' must name ' + commit,
    );
  }
});
