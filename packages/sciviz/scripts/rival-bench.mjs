// volume-64 render time and image against VTK.js.
// Both libraries share one headless page and take turns. Times are per-round minima of
// one frame plus the pixel read. Busy machine: diagnostic.
// VTK.js stays outside the repository. This file never reads its source.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { volumeRivalPlugin } from '../../../scripts/rival-volume-alias.mjs';
import { benchRoot, line, rivalVersion } from '../../../scripts/rival-pair.mjs';

process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));

const vtkRoot = realpathSync.native(`${benchRoot()}\\batch-167\\node_modules\\@kitware\\vtk.js`);
const modules = realpathSync.native(`${benchRoot()}\\batch-167\\node_modules`);
const repo = realpathSync.native(process.cwd());

const version = rivalVersion('@kitware/vtk.js');
let context;
try {
  context = await openBrowser({
    startPath: '/packages/sciviz/scripts/rival-page.html',
    port: 'free',
    plugins: [volumeRivalPlugin(vtkRoot, modules, repo)],
  });
  const { page, hardware } = context;
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    const text = message.text();
    if (text.startsWith('rival')) console.log(text);
    if (message.type() === 'error' && !text.startsWith('rival failed')) errors.push(text);
  });
  page.setDefaultTimeout(180_000);
  await page.evaluate(() => {
    window.__startRival = true;
  });
  await page.waitForFunction(() => window.__rival, null, { timeout: 180_000 });
  const report = await page.evaluate(() => window.__rival);
  console.log(`VTK.js ${version}`);
  console.log(`GPU ${hardware.webgpu?.description || hardware.webglRenderer || 'unknown'}`);
  console.log(`adapter ${JSON.stringify(hardware.webgpu)}`);
  if (report.error) {
    console.error(report.error);
    if (report.stack) console.error(report.stack);
    process.exitCode = 1;
  } else {
    console.log(line('volume-64', 'margo', report.minA, 'vtk', report.minB));
    console.log(`bounds ${JSON.stringify(report.bounds)}`);
    console.log(`sampleDistance ${report.sampleDistance}`);
    console.log(`spacing ${JSON.stringify(report.spacing)}`);
    console.log(`field sum ${report.sum}`);
    console.log(`image mean abs ${report.delta.mean} far8 ${report.delta.far} pixels ${report.delta.pixels}`);
    console.log(`margo ink ${report.margo.ink} sum ${report.margo.sum}`);
    console.log(`vtk ink ${report.vtk.ink} sum ${report.vtk.sum}`);
    const dump = (name, rounds) => console.log(`${name} ${rounds.map((value) => value.toFixed(3)).join(' ')}`);
    dump('rounds margo', report.roundsA);
    dump('rounds vtk', report.roundsB);
  }
  if (errors.length) {
    console.error(errors.slice(0, 20).join('\n'));
    process.exitCode = 1;
  }
} finally {
  if (context) await context.close();
}
