// Batch 168 points measurement, in one headless page. potree-core stays outside the repository.
// This file does not read its source.
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openBrowser } from './browser.js';
import { line } from './rival-pair.mjs';
import { pointsRivalPlugin } from './rival-points-alias.mjs';
import { POINTS_SCENE, POINT_STRIDE, fillPoints, hierarchyOf, metadataOf, pointCount } from './rival-points-scene.mjs';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));

const bench = process.env.MARGO_ENGINE_BENCH ?? 'C:\\Development\\Projects\\engine-bench';
const modules = realpathSync.native(`${bench}\\batch-168\\node_modules`);
const repo = realpathSync.native(process.cwd());
const folder = `${bench}\\batch-168\\data\\points-10m`;
const version = JSON.parse(readFileSync(`${modules}\\potree-core\\package.json`, 'utf8')).version;
const count = pointCount(POINTS_SCENE);

const writeCloud = () => {
  mkdirSync(folder, { recursive: true });
  writeFileSync(`${folder}\\metadata.json`, JSON.stringify(metadataOf(POINTS_SCENE)));
  writeFileSync(`${folder}\\hierarchy.bin`, hierarchyOf(POINTS_SCENE));
  const file = `${folder}\\octree.bin`;
  const bytes = count * POINT_STRIDE;
  if (existsSync(file)) {
    const fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    closeSync(fd);
    if (size === bytes) return;
  }
  const fd = openSync(file, 'w');
  const chunk = 200_000;
  const buf = new Uint8Array(chunk * POINT_STRIDE);
  for (let start = 0; start < count; start += chunk) {
    const n = Math.min(chunk, count - start);
    fillPoints(POINTS_SCENE, start, n, n === chunk ? buf : buf.subarray(0, n * POINT_STRIDE));
    writeSync(fd, buf, 0, n * POINT_STRIDE);
  }
  closeSync(fd);
};

writeCloud();

let context;
try {
  context = await openBrowser({
    startPath: '/scripts/rival-points-page.html',
    port: 'free',
    plugins: [pointsRivalPlugin(modules, repo, folder)],
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
  console.log(`potree-core ${version}`);
  console.log(`points ${count} budget ${POINTS_SCENE.budget}`);
  if (report.error) {
    console.error(report.error);
    if (report.stack) console.error(report.stack);
    process.exitCode = 1;
  } else {
    console.log(
      `drawn margo ${report.margoDrawn} loaded ${report.margoLoaded} source ${report.sourcePoints} rival ${report.rivalDrawn} rival frame ${report.rivalFrameDrawn}`,
    );
    console.log(`calls ${report.calls} renderPoints ${report.renderPoints}`);
    console.log(line('points-10m', 'margo', report.minA, 'potree-core', report.minB));
    console.log(`rounds margo ${report.roundsA.map((value) => value.toFixed(3)).join(' ')}`);
    console.log(`rounds rival ${report.roundsB.map((value) => value.toFixed(3)).join(' ')}`);
    if (report.margoDrawn !== count || report.rivalFrameDrawn !== count) process.exitCode = 1;
  }
  if (errors.length) {
    console.error(errors.slice(0, 20).join('\n'));
    process.exitCode = 1;
  }
} finally {
  if (context) await context.close();
}
