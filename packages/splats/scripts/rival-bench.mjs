// Truck image 000001 against the published photograph, and one frame against GaussianSplats3D.
// Both renderers share one headless page. Times are per-round minima of one frame, after the GPU
// has finished it. The pixel read is not in the clock. Busy machine: diagnostic.
// The rival stays outside the repository. This file does not read its source.
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { benchRoot, line } from '../../../scripts/rival-pair.mjs';
import { splatsRivalPlugin } from '../../../scripts/rival-splats-alias.mjs';
import { fitDegree3Count, writePlyPrefix } from '../../../scripts/rival-splats-fit.mjs';

process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));

const modules = realpathSync.native(`${benchRoot()}\\batch-168\\node_modules`);
const dataDir = realpathSync.native(`${benchRoot()}\\batch-168\\data`);
const repo = realpathSync.native(process.cwd());
const fit = await writePlyPrefix(join(dataDir, 'truck-7k.ply'), join(dataDir, 'truck-7k-fit.ply'), fitDegree3Count());
console.log(`fit prefix ${fit.count} of ${fit.sourceCount} stride ${fit.stride} bytes ${fit.bytes}`);

let context;
try {
  context = await openBrowser({
    startPath: '/scripts/rival-splats-page.html',
    port: 'free',
    plugins: [splatsRivalPlugin(modules, dataDir, repo)],
  });
  const { page, hardware } = context;
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    const text = message.text();
    if (message.type() === 'error') errors.push(text);
  });
  page.setDefaultTimeout(600_000);
  await page.waitForFunction(() => window.__rival, null, { timeout: 600_000 });
  const report = await page.evaluate(() => window.__rival);
  const rival = JSON.parse(readFileSync(`${modules}\\@mkkellogg\\gaussian-splats-3d\\package.json`, 'utf8')).version;
  console.log(`GaussianSplats3D ${rival}`);
  console.log(`GPU ${hardware.webgpu?.description || hardware.webglRenderer || 'unknown'}`);
  console.log(`adapter ${JSON.stringify(hardware.webgpu)}`);
  if (report.error) {
    console.error(report.error);
    if (report.stack) console.error(report.stack);
    process.exitCode = 1;
  } else {
    console.log(line('truck-7k-fit', 'margo', report.minA, 'gaussian-splats-3d', report.minB));
    console.log(`splats ${report.count} of ${fit.sourceCount} drawn ${report.ink} image ${report.width}x${report.height}`);
    console.log(`camera ${report.winner} isolated ${report.isolated}`);
    console.log(`psnr w2c ${report.poses.w2c.psnr} mae ${report.poses.w2c.mae}`);
    console.log(`psnr c2w ${report.poses.c2w.psnr} mae ${report.poses.c2w.mae}`);
    const brief = (s) => (s ? `mean ${s.mean.map((v) => v.toFixed(2)).join(' ')} nonzero ${s.nonzero}` : 'none');
    console.log(`psnr photo ${report.psnr} mae ${report.mae} ${brief(report.frame)}`);
    console.log(`rival psnr ${report.rivalPsnr} mae ${report.rivalMae} ${brief(report.rivalFrame)}`);
    console.log(`probe ${brief(report.probe)}`);
    console.log(`rival probe ${brief(report.rivalProbe)}`);
    console.log(`reveal ${report.reveal} ${brief(report.revealStats)} draws ${report.drawCalls} canvases ${report.canvases} sameRenderer ${report.sameRenderer}`);
    if (!report.probe || report.probe.nonzero === 0) {
      console.error('Margo canvas readback is empty; the clear did not come back');
      process.exitCode = 1;
    }
    const dump = (name, rounds) => console.log(`${name} ${rounds.map((value) => value.toFixed(3)).join(' ')}`);
    dump('rounds margo', report.roundsA);
    dump('rounds gaussian', report.roundsB);
  }
  if (errors.length) {
    console.error(errors.slice(0, 20).join('\n'));
    process.exitCode = 1;
  }
} finally {
  if (context) await context.close();
}
