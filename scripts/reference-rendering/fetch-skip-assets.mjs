// Standard test data only. No renderer source. Every file stays outside the repository.
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fetchFixture } from '../support/fetch-fixture.mjs';
import { externalAssets, externalAssetRoot, requireExternalAssets } from '../support/external-test-assets.mjs';
import { downloadArguments } from '../support/download-arguments.mjs';
import { blendRepeatRoot, blendRepeatScene } from './blend-repeat-scene.mjs';

const args = downloadArguments(
  `Usage: node scripts/reference-rendering/fetch-skip-assets.mjs
Downloads the pinned external test assets (scripts/support/external-test-assets.json) that are missing or changed,
and the blend repeat check's fixture.
  --help   print this and download nothing`,
);
if (args) {
  const root = externalAssetRoot();
  const deadline = setTimeout(() => {
    console.error('External test asset acquisition exceeded its 15-minute hard deadline');
    process.exit(1); // process.exit: the watchdog ends a run that is still going past its hard limit
  }, 15 * 60_000);
  deadline.unref();
  for (let i = 0; i < externalAssets.length; i += 6) {
    await Promise.all(
      externalAssets.slice(i, i + 6).map(async ({ file, url, sha256, size }) => {
        const path = resolve(root, file);
        if (existsSync(path) && createHash('sha256').update(readFileSync(path)).digest('hex') === sha256) return;
        await fetchFixture(url, path, sha256, { maxBytes: size });
      }),
    );
  }
  requireExternalAssets();
  await blendRepeatScene(blendRepeatRoot(), { download: true });
  clearTimeout(deadline);
  console.log(`Required external test assets ready: ${externalAssets.length} in ${root}; no environment export needed`);
}
