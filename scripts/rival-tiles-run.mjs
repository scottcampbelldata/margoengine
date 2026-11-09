// Batch 168 tiles measurement, in one headless page. The rival needs a browser (it reads window).
// 3d-tiles-renderer stays outside the repository. This file does not read its source.
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openBrowser } from './browser.js';
import { line } from './rival-pair.mjs';
import { tilesRivalPlugin } from './rival-tiles-alias.mjs';
import { TILES_SCENE, buildTilesScene } from './rival-tiles-scene.mjs';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));

const bench = process.env.MARGO_ENGINE_BENCH ?? 'C:\\Development\\Projects\\engine-bench';
const modules = realpathSync.native(`${bench}\\batch-168\\node_modules`);
const repo = realpathSync.native(process.cwd());
const version = JSON.parse(readFileSync(`${modules}\\3d-tiles-renderer\\package.json`, 'utf8')).version;
const scene = buildTilesScene();

let context;
try {
  context = await openBrowser({
    startPath: '/scripts/rival-tiles-page.html',
    port: 'free',
    plugins: [tilesRivalPlugin(modules, repo, scene)],
  });
  const { page } = context;
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.setDefaultTimeout(600_000);
  await page.waitForFunction(() => window.__rival, null, { timeout: 600_000 });
  const report = await page.evaluate(() => window.__rival);
  console.log(`3d-tiles-renderer ${version}`);
  console.log(`tiles ${(4 ** TILES_SCENE.levels - 1) / 3} errorTarget ${TILES_SCENE.maximumScreenSpaceError}`);
  if (report.error) {
    console.error(report.error);
    if (report.stack) console.error(report.stack);
    process.exitCode = 1;
  } else {
    console.log(
      `selected margo ${report.margoCount} checksum ${report.margoChecksum} depths ${JSON.stringify(report.margoDepths)}`,
    );
    console.log(
      `selected rival ${report.rivalCount} checksum ${report.rivalChecksum} depths ${JSON.stringify(report.rivalDepths)}`,
    );
    console.log(`only margo ${report.onlyMargo} only rival ${report.onlyRival}`);
    if (report.onlyMargoSample.length) console.log(`only margo sample ${report.onlyMargoSample.join(' ')}`);
    if (report.onlyRivalSample.length) console.log(`only rival sample ${report.onlyRivalSample.join(' ')}`);
    console.log(`rival tile keys ${report.sampleKeys.join(' ')}`);
    console.log(`rival tile numbers ${JSON.stringify(report.sampleNumbers)}`);
    console.log(line('tiles-quadtree', 'margo', report.minA, '3d-tiles-renderer', report.minB));
    console.log(`rounds margo ${report.roundsA.map((value) => value.toFixed(3)).join(' ')}`);
    console.log(`rounds rival ${report.roundsB.map((value) => value.toFixed(3)).join(' ')}`);
  }
  if (errors.length) {
    console.error(errors.slice(0, 20).join('\n'));
    process.exitCode = 1;
  }
} finally {
  if (context) await context.close();
}
