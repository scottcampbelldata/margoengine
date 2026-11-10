// Clean-room VTK.js black-box harness. A one-run smoke records no elapsed times.
import { realpathSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { volumeRivalPlugin } from '../../../scripts/rival-volume-alias.mjs';
import { benchRoot, rivalVersion } from '../../../scripts/rival-pair.mjs';
import { deferSpeed } from '../../../scripts/support/speed-phase.mjs';
import { installWorkCounters, rivalOptions } from './rival-contract.js';

if (process.argv.includes('--help')) {
  console.log(
    'node packages/sciviz/scripts/rival-bench.mjs --runs=1 --scene=legacy-64|isotropic-64|isotropic-128 --output=test-results/bp-182',
  );
  process.exit(0);
}
const options = rivalOptions(process.argv.slice(2));
if (!options.smoke && deferSpeed('packages/sciviz/scripts/rival-bench.mjs')) process.exit(0);
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const output = resolve(options.output);
mkdirSync(output, { recursive: true });
const vtkRoot = realpathSync.native(join(benchRoot(), 'batch-167/node_modules/@kitware/vtk.js'));
const modules = realpathSync.native(join(benchRoot(), 'batch-167/node_modules'));
const repo = realpathSync.native(process.cwd());
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
    if (message.type() === 'error') errors.push(message.text());
  });
  page.setDefaultTimeout(180_000);
  await page.evaluate(installWorkCounters);
  await page.evaluate((value) => {
    window.__rivalOptions = value;
    window.__startRival = true;
  }, options);
  await page.waitForFunction(() => window.__rival, null, { timeout: 180_000 });
  const report = await page.evaluate(() => window.__rival);
  if (report.error) throw new Error(`${report.error}\n${report.stack}`);
  if (errors.length) throw new Error(errors.slice(0, 20).join('\n'));
  const result = {
    schema: 'margo-sciviz-rival/1',
    rival: { name: 'VTK.js', version: rivalVersion('@kitware/vtk.js') },
    hardware,
    ...report,
  };
  writeFileSync(join(output, `${options.scene}.json`), JSON.stringify(result, null, 2) + '\n');
  // Capture the actual canvas before disposal; the browser frame bytes were checked separately.
  for (const name of ['margo', 'vtk']) {
    await page
      .locator(name === 'margo' ? '#margo' : '#vtk canvas')
      .screenshot({ path: join(output, `${options.scene}-${name}.png`) });
  }
  if (options.smoke)
    console.log(`${options.scene}: smoke passed; repeated images byte-identical; timing pending the quiet rerun`);
  else
    console.log(
      `${options.scene}: frame/read minima margo ${report.minA} ms, vtk ${report.minB} ms; see workload differences in JSON`,
    );
  console.log(JSON.stringify({ delta: report.delta, workA: report.workA, workB: report.workB }));
  await page.evaluate(() => window.__disposeRival());
} finally {
  if (context) await context.close();
}
