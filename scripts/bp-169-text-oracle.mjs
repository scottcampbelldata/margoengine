import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { createServer } from 'vite';
import { launchBrowser } from './lib/browser.mjs';
import { closeAll } from './support/shutdown.mjs';
import { acquire } from './gpu-lock.mjs';

const root = resolve(import.meta.dirname, '..');
const supplied = process.argv.find((a) => a.startsWith('--rival='))?.slice(8);
assert.ok(supplied && isAbsolute(supplied), 'Supply --rival=<absolute external test directory>');
const external = resolve(supplied);
const rel = relative(root, external);
assert.ok(rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel), 'Install the rival outside this repository');
const pkg = JSON.parse(readFileSync(resolve(external, 'node_modules/troika-three-text/package.json'), 'utf8'));
assert.equal(pkg.name, 'troika-three-text');
assert.equal(pkg.version, '0.52.4');
const url = (p) => '/@fs/' + resolve(p).replaceAll('\\', '/');
const lock = await acquire({ owner: 'bp-169-text-oracle', mode: 'shared', max: 5, waitMax: 60 });
let browser, server;
try {
  server = await createServer({
    configFile: false,
    root: external,
    cacheDir: resolve(root, 'test-results/bp-169-vite'),
    plugins: [
      {
        name: 'bp169-oracle-page',
        configureServer(srv) {
          srv.middlewares.use('/bp169', (_, res) => {
            res.setHeader('Content-Type', 'text/html');
            res.end('<!doctype html><title>Text value oracle</title>');
          });
        },
      },
    ],
    server: { port: 0, host: '127.0.0.1', fs: { allow: [root, external] } },
  });
  await server.listen();
  browser = await launchBrowser({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(60_000);
  await page.goto(server.resolvedUrls.local[0] + 'bp169');
  const report = await page.evaluate(
    async ({ margo, rival, fontUrl }) => {
      const { Font, layoutText } = await import(margo);
      const { Text, configureTextBuilder, getSelectionRects } = await import(rival);
      configureTextBuilder({ useWorker: false });
      const face = new FontFace('Bp169', 'url("' + fontUrl + '")');
      const font = new Font({ face });
      await font.load();
      const canvas = new OffscreenCanvas(1, 1),
        ctx = canvas.getContext('2d');
      ctx.font = font.css;
      ctx.fontKerning = 'normal';
      const results = [];
      for (const text of ['AVATAR', 'office affine waffle', 'Hello world', 'AVATAR'.repeat(20)]) {
        const ours = layoutText(text, { fontSize: 1, ligatures: true }, font);
        const margoWidth = ours.bounds.right - ours.bounds.left;
        const canvasWidth = ctx.measureText(text).width / font.size;
        const t = new Text();
        t.text = text;
        t.font = fontUrl;
        t.fontSize = 1;
        t.anchorX = 'left';
        t.anchorY = 'top';
        t.gpuAccelerateSDF = false;
        let timer;
        try {
          await new Promise((done, fail) => {
            timer = setTimeout(() => fail(new Error('Troika sync deadline')), 60000);
            t.sync(done);
          });
          const rects = getSelectionRects(t.textRenderInfo, 0, text.length);
          const troikaWidth = Math.max(...rects.map((r) => r.right)) - Math.min(...rects.map((r) => r.left));
          results.push({
            text,
            margoWidth,
            canvasWidth,
            troikaWidth,
            canvasError: margoWidth - canvasWidth,
            troikaError: margoWidth - troikaWidth,
          });
        } finally {
          clearTimeout(timer);
          t.dispose();
        }
      }
      return results;
    },
    {
      margo: url(resolve(root, 'packages/text/dist/index.js')),
      rival: url(resolve(external, 'node_modules/troika-three-text', pkg.module)),
      fontUrl: url(resolve(root, 'packages/text/tests/fixtures/fonts/SourceSans3-Regular.ttf')),
    },
  );
  for (const row of report)
    for (const field of ['margoWidth', 'canvasWidth', 'troikaWidth', 'canvasError', 'troikaError'])
      assert.ok(Number.isFinite(row[field]), field);
  console.log(
    JSON.stringify(
      { rival: 'troika-three-text@0.52.4', font: 'Source Sans 3 Regular 3.052R', results: report },
      null,
      2,
    ),
  );
} finally {
  try {
    await closeAll({ browser, servers: server ? [server] : [] });
  } finally {
    await lock();
  }
}
