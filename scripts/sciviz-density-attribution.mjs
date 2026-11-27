// Black-box probes that isolate why Margo's density pixels differ from two rivals. Pixel only, no timing, no
// correctness gate. Rival packages run from outside this repository; their source is never read. Prepare their bundle
// once with `node scripts/sciviz-density-pixels.mjs --prepare`.
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openBrowser } from './browser.js';
import { engineBenchRoot } from './support/engine-bench.mjs';
import { checkProbes } from './support/density-raster-model.mjs';

const rivalRoot = process.env.MARGO_DENSITY_RIVALS ?? resolve(engineBenchRoot(), 'batch-181-density');
const bundle = resolve(rivalRoot, 'margo-density-output/density-rivals.js').replaceAll('\\', '/');
const browser = await openBrowser({
  startPath: '/packages/sciviz/tests/volume-quality.html',
  port: 'free',
  plugins: [{ name: 'density-rival-files', config: () => ({ server: { fs: { allow: [process.cwd(), rivalRoot] } } }) }],
});
browser.page.setDefaultTimeout(300000);
try {
  const report = await browser.page.evaluate(async (bundle) => {
    const probe = await import('/scripts/support/density-attribution-page.mjs');
    return probe.run('/@fs/' + bundle);
  }, bundle);
  const rivals = Object.fromEntries(
    Object.entries(report).map(([name, { stacks, sweepLow, sweepHigh, real }]) => [
      name,
      { probes: checkProbes(name, stacks, [...sweepLow, ...sweepHigh]), stacks, real },
    ]),
  );
  const out = {
    date: new Date().toISOString().slice(0, 10),
    kind: 'pixel-only attribution, no timing',
    hardware: browser.hardware,
    rivals,
  };
  await writeFile('test-results/density-attribution.json', JSON.stringify(out) + '\n');
  console.log(JSON.stringify(rivals));
} finally {
  await browser.close();
}
