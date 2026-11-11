// Batch 168 OIT measurement, in one headless page. @babylonjs/core stays outside the repository.
// This file does not read its source.
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openBrowser } from './browser.js';
import { oitRivalPlugin } from './rival-oit-alias.mjs';
import { line } from './rival-pair.mjs';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));

const bench = process.env.MARGO_ENGINE_BENCH ?? fileURLToPath(new URL('../../engine-bench', import.meta.url));
const modules = realpathSync.native(`${bench}\\batch-168\\node_modules`);
const repo = realpathSync.native(process.cwd());
const version = JSON.parse(readFileSync(`${modules}\\@babylonjs\\core\\package.json`, 'utf8')).version;

const round = (value) => (value === Infinity ? null : Number(value.toFixed(6)));

let context;
try {
  context = await openBrowser({
    startPath: '/scripts/rival-oit-page.html',
    port: 'free',
    plugins: [oitRivalPlugin(modules, repo)],
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
  console.log(`@babylonjs/core ${version}`);
  if (report.error) {
    console.error(report.error);
    if (report.stack) console.error(report.stack);
    process.exitCode = 1;
  } else {
    console.log(
      `oit method ${report.method} rival ${report.rivalMethod} passCount ${report.passCount} size ${report.width}x${report.height}`,
    );
    console.log(line('oit-panes', 'margo', report.minA, 'babylon', report.minB));
    console.log(`rounds margo ${report.roundsA.map((value) => value.toFixed(3)).join(' ')}`);
    console.log(`rounds rival ${report.roundsB.map((value) => value.toFixed(3)).join(' ')}`);
    console.log(
      `margo mae ${report.margo.mae.toFixed(6)} psnr ${report.margo.psnr === Infinity ? 'inf' : report.margo.psnr.toFixed(3)} max ${report.margo.max}`,
    );
    console.log(
      `rival mae ${report.rival.mae.toFixed(6)} psnr ${report.rival.psnr === Infinity ? 'inf' : report.rival.psnr.toFixed(3)} max ${report.rival.max}`,
    );
    console.log(
      `center ref ${report.centerRef.join(',')} margo ${report.centerMargo.join(',')} rival ${report.centerRival.join(',')}`,
    );
    console.log(`corner margo ${report.cornerMargo.join(',')} rival ${report.cornerRival.join(',')}`);
    console.log(`buffer ${report.drawingBuffer.join('x')}`);
    const result = {
      passCount: report.passCount,
      minA: report.minA,
      minB: report.minB,
      roundsA: report.roundsA,
      roundsB: report.roundsB,
      margo: { ...report.margo, psnr: round(report.margo.psnr) },
      rival: { ...report.rival, psnr: round(report.rival.psnr) },
      centerRef: report.centerRef,
      centerMargo: report.centerMargo,
      centerRival: report.centerRival,
      cornerMargo: report.cornerMargo,
      cornerRival: report.cornerRival,
      margoLayer1: report.margoLayer1,
      rivalLayer1: report.rivalLayer1,
      margoBackground: report.margoBackground,
      rivalBackground: report.rivalBackground,
    };
    console.log(`RESULT ${JSON.stringify(result)}`);
    const background = Math.max(report.margoBackground?.mae ?? 99, report.rivalBackground?.mae ?? 99);
    const single = Math.max(report.margoLayer1?.mae ?? 99, report.rivalLayer1?.mae ?? 99);
    if (background > 2 || single > 3) {
      console.error(`setup error: background mae ${background} single-layer mae ${single}`);
      process.exitCode = 1;
    }
  }
  if (errors.length) {
    console.error(errors.slice(0, 20).join('\n'));
    process.exitCode = 1;
  }
} finally {
  if (context) await context.close();
}
