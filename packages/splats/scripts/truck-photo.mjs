// Correctness only: the Truck 7,000-iteration cloud at view 000001 against the published photograph (PSNR and MAE,
// both readings of the camera rotation). No rival and no clock, so it is not deferred by the speed phase.
// Usage: node packages/splats/scripts/truck-photo.mjs [--ply=truck-7k.ply | --ply=truck-7k-fit.ply] [--save=<folder>]
// (--save writes the two renders as truck-w2c.png and truck-c2w.png)
// Data: <bench>/batch-168/data (docs/benchmarking.md); the cloud and photograph stay outside the repository.
import { realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { benchRoot } from '../../../scripts/rival-pair.mjs';
import { splatsRivalPlugin } from '../../../scripts/rival-splats-alias.mjs';

process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const save = process.argv.find((arg) => arg.startsWith('--save='))?.slice(7);
const near = process.argv.find((arg) => arg.startsWith('--near='))?.slice(7);
const ply = process.argv.find((arg) => arg.startsWith('--ply='))?.slice(6) ?? 'truck-7k.ply';
const modules = realpathSync.native(join(benchRoot(), 'batch-168', 'node_modules'));
const dataDir = realpathSync.native(join(benchRoot(), 'batch-168', 'data'));
const repo = realpathSync.native(process.cwd());

let context;
try {
  context = await openBrowser({
    startPath: `/scripts/splats-truck-photo-page.html?ply=${encodeURIComponent(ply)}${save ? '&save' : ''}${near ? `&near=${near}` : ''}`,
    port: 'free',
    plugins: [splatsRivalPlugin(modules, dataDir, repo)],
  });
  const { page, hardware } = context;
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
  await page.waitForFunction(() => window.__photo, null, { timeout: 600_000 });
  const report = await page.evaluate(() => window.__photo);
  console.log(`GPU ${hardware.webgpu?.description || hardware.webglRenderer || 'unknown'}`);
  if (report.error) {
    console.error(report.error);
    process.exitCode = 1;
  } else {
    console.log(`${report.ply}: splats ${report.count} drawn ${report.drawn} image ${report.width}x${report.height}`);
    for (const [mode, s] of Object.entries(report.poses)) {
      console.log(`psnr ${mode} ${s.psnr.toFixed(3)} mae ${s.mae.toFixed(3)}`);
      if (save) writeFileSync(join(save, `truck-${mode}.png`), Buffer.from(s.png.split(',')[1], 'base64'));
    }
  }
  if (errors.length) {
    console.error(errors.slice(0, 20).join('\n'));
    process.exitCode = 1;
  }
} finally {
  if (context) await context.close();
}
