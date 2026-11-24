// Shared standard test inputs: explicit environment override or the cache beside all worktrees.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { requiredFixture } from './required-fixture.mjs';

export const externalAssets = JSON.parse(readFileSync(new URL('./external-test-assets.json', import.meta.url), 'utf8'));
export const externalAssetRecovery = 'node scripts/reference-rendering/fetch-skip-assets.mjs';

/** Resolve identically in verify, individual package tests and the downloader, without a shell export. */
export function externalAssetRoot(env = process.env) {
  return resolve(env.MARGO_SPLAT_SAMPLES ?? resolve(
    env.MARGO_ENGINE_BENCH ?? fileURLToPath(new URL('../../../engine-bench/', import.meta.url)),
    'batch-160/gltf-gpu-samples',
  ));
}

/** Validate every input in a family, including companions, before any conformance enumeration can omit one. */
export function requireExternalAssets(prefix = '', { root = externalAssetRoot(), assets = externalAssets } = {}) {
  const rows = assets.filter(({ file }) => file.startsWith(prefix));
  assert.ok(rows.length, `No required external test assets match ${prefix}`);
  for (const { file, sha256 } of rows) {
    const path = resolve(root, file), bytes = requiredFixture(path, externalAssetRecovery);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), sha256,
      `Changed required test fixture ${path}; fetch it with: ${externalAssetRecovery}`);
  }
  return resolve(root, prefix);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  requireExternalAssets();
  console.log(`Required external test assets: ${externalAssets.length} verified in ${externalAssetRoot()}`);
}
