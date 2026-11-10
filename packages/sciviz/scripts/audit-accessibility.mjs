import { startDevServer } from '../../../scripts/browser.js';
import { resolve, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
// Install the pinned audit tools into an isolated directory; no engine runtime dependency.
const root = resolve(process.env.MARGO_A11Y_TOOLS ?? 'test-results/a11y-tools');
const load = (p) => import(pathToFileURL(join(root, 'node_modules', p)).href);
const [chromeLauncher, { default: puppeteer }, { startFlow }] = await Promise.all([
  load('chrome-launcher/dist/index.js'),
  load('puppeteer-core/lib/puppeteer/puppeteer-core.js'),
  load('lighthouse/core/index.js'),
]);
import { writeFileSync, readdirSync, mkdirSync } from 'node:fs';
const names = (
  process.env.A11Y_PAGES?.split(',') ?? readdirSync('examples').filter((n) => /^sciviz-.*\.html$/.test(n))
).sort();
const server = await startDevServer({ startPath: '/examples/sciviz-a11y.html', port: 'free' });
const chrome = await chromeLauncher.launch({
  chromePath: process.env.CHROME_PATH,
  chromeFlags: ['--headless=new', '--enable-unsafe-webgpu', '--use-angle=d3d11', '--no-first-run'],
  logLevel: 'silent',
});
const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${chrome.port}` });
const reports = [];
mkdirSync('test-results/sciviz-a11y/lighthouse', { recursive: true });
try {
  for (const name of names) {
    const page = await browser.newPage(),
      pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    try {
      await page.setViewport({ width: 1440, height: 1000 });
      const url = server.server.resolvedUrls.local[0] + 'examples/' + name;
      let target = url;
      if (name === 'sciviz-share.html') {
        await page.goto(server.server.resolvedUrls.local[0] + 'examples/sciviz-a11y.html', {waitUntil:'networkidle2',timeout:120000});
        await page.waitForFunction(() => document.querySelector('#status')?.textContent.startsWith('Ready:'), {timeout:120000});
        target = await page.evaluate(async base => {
          const {ligo} = await import('/examples/sciviz-a11y.ts');
          const {createShareURL} = await import('/packages/sciviz/dist/share.js');
          return createShareURL(await ligo.toJSON(), base);
        }, url);
        pageErrors.length = 0;
      }

      await page.goto(target, { waitUntil: 'networkidle2', timeout: 120000 });
      await page.waitForFunction(
        async () => {
          const m = await import('/packages/sciviz/dist/a11y.js');
          const canvases = [...document.querySelectorAll('canvas')];
          const figures = canvases.filter((c) => m.figureForCanvas(c)?.layers.length);
          if (figures.length)
            return figures.every(
              (c) =>
                c.dataset.accessibleReady === 'true' ||
                (c.dataset.margoExplore !== undefined &&
                  document.querySelector('#status')?.textContent.startsWith('Ready:')),
            );
          return document.readyState === 'complete' && (!canvases.length || !!document.querySelector('svg,table'));
        },
        { timeout: 120000 },
      );
      const errors = await page.evaluate(() =>
        [...document.querySelectorAll('[data-error],[data-accessible-error]')].map(
          (e) => e.dataset.error ?? e.dataset.accessibleError,
        ),
      );
      errors.push(...pageErrors);
      if (errors.length) throw new Error(name + ': ' + errors.join('; '));
      const flow = await startFlow(page, {
        config: {
          extends: 'lighthouse:default',
          settings: { onlyCategories: ['accessibility'], formFactor: 'desktop', screenEmulation: { disabled: true } },
        },
      });
      await flow.snapshot({ name: 'Loaded ' + name });
      const result = await flow.createFlowResult(),
        lhr = result.steps[0].lhr;
      writeFileSync(`test-results/sciviz-a11y/lighthouse/${name.replace(/[^a-z0-9_.-]/gi, '_')}.json`, JSON.stringify(lhr, null, 2));
      const failures = Object.values(lhr.audits)
        .filter((a) => a.score !== null && a.score < 1)
        .map((a) => ({ id: a.id, title: a.title, items: a.details?.items }));
      const report = { page: name, score: lhr.categories.accessibility.score, failures };
      reports.push(report);
      console.log(JSON.stringify(report));
      flow.dispose();
    } finally {
      await page.close();
    }
  }
  writeFileSync(
    'test-results/sciviz-a11y/lighthouse.json',
    JSON.stringify(
      {
        version: '13.6.0',
        browser: await browser.version(),
        viewport: { width: 1440, height: 1000 },
        method: 'Loaded-page accessibility snapshots after complete accessible data readiness; no audits disabled',
        reports,
      },
      null,
      2,
    ),
  );
  if (reports.some((r) => r.score !== 1)) process.exitCode = 1;
} finally {
  await browser.disconnect();
  await chrome.kill();
  await server.close();
}
