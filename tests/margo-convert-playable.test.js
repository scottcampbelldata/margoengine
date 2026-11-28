// margo-convert playable: a tiny built app (a module graph, a .wasm, images, a stylesheet and a JSON file) becomes one
// HTML file with no external reference, which runs in headless Chromium with every network request refused, waits for
// MRAID ready and viewable, pauses on viewableChange and clicks through with mraid.open (window.open with no MRAID).
// Over a budget the build fails with a coded error naming the biggest files, unless allowOverBudget is set.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { buildPlayable, PLAYABLE_BUDGETS, scanScript, scriptText } from '../tools/margo-convert/pipeline/playable.js';
import { launchBrowser } from '../scripts/lib/browser.mjs';
import { closeAll } from '../scripts/support/shutdown.mjs';

const sharp = createRequire(import.meta.url)('sharp');
const dir = mkdtempSync(join(tmpdir(), 'margo-playable-'));
after(() => rmSync(dir, { recursive: true, force: true }));

// (module (func (export "add") (param i32 i32) (result i32) local.get 0 local.get 1 i32.add))
const ADD_WASM = Uint8Array.from([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f, 0x03, 0x02,
  0x01, 0x00, 0x07, 0x07, 0x01, 0x03, 0x61, 0x64, 0x64, 0x00, 0x00, 0x0a, 0x09, 0x01, 0x07, 0x00, 0x20, 0x00, 0x20,
  0x01, 0x6a, 0x0b,
]);

const write = (/** @type {string} */ path, /** @type {string | Uint8Array} */ data) => {
  mkdirSync(resolve(dir, path, '..'), { recursive: true });
  writeFileSync(resolve(dir, path), data);
};
const png = (/** @type {number} */ w, /** @type {number} */ h) =>
  sharp({ create: { width: w, height: h, channels: 4, background: { r: 200, g: 40, b: 40, alpha: 1 } } })
    .png()
    .toBuffer();

const app = join(dir, 'app');
write(
  'app/index.html',
  `<!doctype html>
<html><head><meta charset="utf-8"><title>Fixture</title>
<link rel="modulepreload" href="./assets/lib.js">
<link rel="stylesheet" href="assets/style.css">
<script type="module" src="./assets/main.js"></script>
</head><body><img id="logo" src="assets/logo.png" alt=""><button id="cta">Install</button></body></html>
`,
);
write('app/assets/style.css', 'body{margin:0;background:#123 url("bg.png") repeat}');
write('app/assets/lib.js', `export { scale } from './deep/scale.js';\nexport const add = (a, b) => a + b;\n`);
write('app/assets/deep/scale.js', `export const scale = (v) => v * 10;\n`);
write(
  'app/assets/main.js',
  `import { add, scale } from './lib.js';
import { onViewableChange, open, close, hasMraid, assetURL } from 'margo-convert/playable-runtime';
const log = (globalThis.__log ??= []);
const { instance } = await WebAssembly.instantiateStreaming(fetch(new URL('../wasm/add.wasm', import.meta.url)));
const img = new Image();
img.src = new URL("./sprite.png", import.meta.url).href;
await img.decode();
const level = await (await fetch('data/level.json')).json();
const lazy = await import('./lazy.js');
const text = '</script><!-- <script>' + \`</SCRIPT \${1 < 2}\`;
onViewableChange((v) => log.push('viewable:' + v));
document.getElementById('cta').addEventListener('click', () => log.push('open:' + open('https://example.com/store')));
globalThis.__close = close;
document.body.dataset.result = JSON.stringify({
  sum: instance.exports.add(2, 3), js: scale(add(4, 5)), img: [img.naturalWidth, img.naturalHeight], level: level.level,
  lazy: lazy.value, text, mraid: hasMraid(), asset: assetURL('data/level.json').startsWith('margo-playable:'),
  logo: document.getElementById('logo').naturalWidth, regex: /<\\/script>/.test('</script>'),
});
`,
);
write('app/assets/lazy.js', 'export const value = "lazy";\n');
write('app/wasm/add.wasm', ADD_WASM);
write('app/assets/sprite.png', await png(3, 2));
write('app/assets/logo.png', await png(5, 1));
write('app/assets/bg.png', await png(1, 1));
write('app/data/level.json', JSON.stringify({ level: 7 }));
write('app/assets/main.js.map', '{}');

test('the output is one file with no external reference and every file inside', async () => {
  const { html, report } = await buildPlayable({ input: app });
  const markup = html.replace(/(<script\b[^>]*>)[\s\S]*?<\/script>/gi, '$1</script>');
  assert.doesNotMatch(markup, /\b(?:src|href)\s*=\s*["']?(?!data:|#)[^"'\s>]+/i, 'no src or href outside data URLs');
  assert.doesNotMatch(markup, /url\(\s*(?!["']?data:)/i, 'no CSS url outside data URLs');
  assert.deepEqual(
    [...new Set(html.match(/\b(?:https?:)?\/\/[\w.-]+\.[a-z]{2,}[^\s"'`)]*/gi))],
    ['https://example.com/store'],
    'the only URL is the click-through',
  );
  assert.doesNotMatch(html, /\.map\b/);
  assert.deepEqual(report.modules.map((m) => m.path).sort(), [
    'assets/deep/scale.js',
    'assets/lazy.js',
    'assets/lib.js',
    'assets/main.js',
  ]);
  assert.deepEqual(report.assets.map((a) => a.path).sort(), ['assets/sprite.png', 'data/level.json', 'wasm/add.wasm']);
  assert.deepEqual(report.inlined.map((a) => a.path).sort(), ['assets/bg.png', 'assets/logo.png', 'assets/style.css']);
  assert.equal(report.budget?.name, 'unity');
  assert.equal(report.overBudget, false);
  assert.ok(report.gzipBytes < report.bytes && report.bytes === Buffer.byteLength(html));
  assert.ok(report.largest[0].bytes >= report.largest.at(-1).bytes);
  // Script text cannot end its element early: exactly one closing tag per opening tag.
  assert.equal((html.match(/<script\b/gi) ?? []).length, (html.match(/<\/script>/gi) ?? []).length);
});

test('the scanner rewrites code only, never strings, comments or regular expressions', () => {
  const src = `import a from './a.js'; const s = "import './no.js'"; // import './c.js'
const r = /from '.\\/x.js'/; const u = new URL('./w.wasm', import.meta.url); const m = import.meta.url; x = a / 2 / 3;
const t = \`\${import('./d.js')} new URL('./no.png', import.meta.url)\`;`;
  const scan = scanScript(src);
  assert.deepEqual(
    scan.edits.map((e) => [e.kind, e.spec ?? null]),
    [
      ['spec', './a.js'],
      ['newurl', './w.wasm'],
      ['meta', null],
      ['spec', './d.js'],
    ],
  );
  assert.equal(
    scriptText('a<script>; "</script>"', scanScript('a<script>; "</script>"')),
    'a< script>; "\\x3C/script>"',
  );
});

/** Opens html at an https page with every other request refused; returns the page and the refused requests. */
async function openPage(browser, html, init) {
  const context = await browser.newContext();
  const refused = [];
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (url === 'https://playable.test/index.html') return route.fulfill({ body: html, contentType: 'text/html' });
    refused.push(url);
    return route.abort();
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (!/^(data|blob):/.test(request.url()) && request.url() !== 'https://playable.test/index.html')
      refused.push(request.url());
  });
  if (init) await page.addInitScript(init);
  await page.goto('https://playable.test/index.html');
  return { context, page, refused, errors };
}
const result = (page) =>
  page
    .waitForFunction(() => document.body.dataset.result, null, { timeout: 20_000 })
    .then(async () => JSON.parse(await page.evaluate(() => document.body.dataset.result)));
const EXPECTED = {
  sum: 5,
  js: 90,
  img: [3, 2],
  level: 7,
  lazy: 'lazy',
  text: '</script><!-- <script></SCRIPT true',
  asset: true,
  logo: 5,
  regex: true,
};

test('the file runs in Chromium with the network blocked, with MRAID and without', { timeout: 120_000 }, async () => {
  const { html } = await buildPlayable({ input: app });
  const browser = await launchBrowser({ headless: true, needs: 'none' });
  const contexts = [];
  try {
    // No MRAID: the entry starts once the page is parsed and visible; the click-through is window.open.
    const plain = await openPage(browser, html, () => {
      window.open = (url) => ((window.__opened = url), null);
    });
    contexts.push(plain.context);
    assert.deepEqual(await result(plain.page), { ...EXPECTED, mraid: false });
    await plain.page.click('#cta');
    assert.equal(await plain.page.evaluate(() => window.__opened), 'https://example.com/store');
    assert.deepEqual(await plain.page.evaluate(() => window.__log), ['open:window']);
    assert.equal(await plain.page.evaluate(() => window.__close()), false);
    assert.deepEqual(plain.errors, []);
    assert.deepEqual(plain.refused, [], 'no network request');

    // A stub MRAID container, loading and not viewable at first.
    const ad = await openPage(browser, html, () => {
      const listeners = {};
      const state = { state: 'loading', viewable: false, opened: [], closed: 0 };
      window.__mraid = state;
      window.mraid = {
        getState: () => state.state,
        isViewable: () => state.viewable,
        addEventListener: (e, f) => (listeners[e] ??= new Set()).add(f),
        removeEventListener: (e, f) => listeners[e]?.delete(f),
        open: (url) => state.opened.push(url),
        close: () => state.closed++,
      };
      window.__fire = (e, ...args) => {
        if (e === 'ready') state.state = 'default';
        if (e === 'viewableChange') state.viewable = args[0];
        for (const f of [...(listeners[e] ?? [])]) f(...args);
      };
    });
    contexts.push(ad.context);
    // fixed-wait: a check that nothing happens: no result before the ad container is ready
    await ad.page.waitForTimeout(500);
    assert.equal(await ad.page.evaluate(() => document.body.dataset.result ?? null), null, 'waits for ready');
    await ad.page.evaluate(() => window.__fire('ready'));
    // fixed-wait: a check that nothing happens: no result before the ad is viewable
    await ad.page.waitForTimeout(300);
    assert.equal(await ad.page.evaluate(() => document.body.dataset.result ?? null), null, 'waits for viewable');
    await ad.page.evaluate(() => window.__fire('viewableChange', true));
    assert.deepEqual(await result(ad.page), { ...EXPECTED, mraid: true });
    await ad.page.evaluate(() => window.__fire('viewableChange', false));
    await ad.page.evaluate(() => window.__fire('viewableChange', true));
    await ad.page.click('#cta');
    assert.equal(await ad.page.evaluate(() => window.__close()), true);
    assert.deepEqual(await ad.page.evaluate(() => window.__log), ['viewable:false', 'viewable:true', 'open:mraid']);
    assert.deepEqual(await ad.page.evaluate(() => [window.__mraid.opened, window.__mraid.closed]), [
      ['https://example.com/store'],
      1,
    ]);
    assert.deepEqual(ad.errors, []);
    assert.deepEqual(ad.refused, [], 'no network request');

    // An entry module alone gets a page of its own.
    write(
      'solo/entry.js',
      `import { open } from 'margo-convert/playable-runtime';\nconst r = await fetch(new URL('./n.json', import.meta.url));\ndocument.body.dataset.result = JSON.stringify(await r.json());\n`,
    );
    write('solo/n.json', '[1,2]');
    const solo = await openPage(
      browser,
      (await buildPlayable({ input: join(dir, 'solo/entry.js'), budget: 'iab' })).html,
    );
    contexts.push(solo.context);
    assert.deepEqual(await result(solo.page), [1, 2]);
    assert.deepEqual(solo.refused, []);
  } finally {
    await closeAll({ context: contexts.pop(), browser });
  }
});

test('over budget fails with a coded error and the report, unless allowOverBudget', async () => {
  await assert.rejects(buildPlayable({ input: app, budget: { bytes: 1000 } }), (error) => {
    assert.equal(error.name, 'MargoError');
    assert.equal(error.code, 'failed');
    assert.match(error.message, /over the custom budget of 1,000; largest: .*sprite\.png|largest: /);
    assert.match(error.message, /margoengine\.com\/errors#playable/);
    assert.equal(error.report.overBudget, true);
    return true;
  });
  const gz = await buildPlayable({
    input: app,
    budget: { bytes: 1000, measure: 'gzip', name: 'tiny' },
    allowOverBudget: true,
  });
  assert.equal(gz.report.overBudget, true);
  assert.equal(gz.report.budget.name, 'tiny');
  assert.equal((await buildPlayable({ input: app, budget: false })).report.budget, null);
  assert.deepEqual(Object.keys(PLAYABLE_BUDGETS).sort(), [
    'applovin',
    'chartboost',
    'iab',
    'liftoff',
    'meta',
    'moloco',
    'unity',
  ]);
  await assert.rejects(buildPlayable({ input: app, budget: 'nope' }), RangeError);
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(buildPlayable({ input: app, signal: ac.signal }), { name: 'AbortError' });
  write('bare/index.html', '<script type="module" src="m.js"></script>');
  write('bare/m.js', "import '@margoengine/core';");
  await assert.rejects(buildPlayable({ input: join(dir, 'bare') }), { code: 'unsupported' });
});

test('the CLI writes the file and fails over budget', () => {
  const cli = resolve('tools/margo-convert/cli.js'),
    out = join(dir, 'out.html');
  execFileSync(process.execPath, [cli, 'playable', app, '--out', out, '--budget', 'meta', '--quiet']);
  assert.match(readFileSync(out, 'utf8'), /^<!doctype html>/i);
  assert.throws(
    () =>
      execFileSync(process.execPath, [cli, 'playable', app, '--out', out, '--budget', '100', '--quiet'], {
        stdio: 'pipe',
      }),
    (error) => error.status === 1 && /over the custom budget/.test(String(error.stderr)),
  );
});
