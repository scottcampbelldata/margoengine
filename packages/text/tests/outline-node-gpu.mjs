// Real-GPU proof that GlyphFieldFont text renders the same in a page and in Node (from the repository root, after
// building packages; MARGO_COMPAT=1 runs the page on the WebGL2 compatibility layer):
//   node scripts/run-with-timeout.mjs -- node packages/text/tests/outline-node-gpu.mjs [--write-kerning]
// The scene of outline-scene.js (a title with an outline and a soft shadow, a kerned caption, small text) is drawn on a
// page canvas from src and in a Node process on the `webgpu` binding from dist. Bars: equal glyph field hashes, every
// channel within 2 of 255, at most 0.1 % of pixels off by more than 1. It also measures kerning through the browser's
// own shaper (a FontFace at 1000 px) and checks GlyphFieldFont reads the same values from the file; --write-kerning
// freezes them into fixtures/fonts/kerning-reference.json for the CPU test. The Node run also tries a lower third
// through @margoengine/ui and reports what happened.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBrowser } from '../../../scripts/browser.js';
import { compatRun } from '../../../scripts/support/compat-shim.js';
import { decodePNG } from '../../../tests/support/png.js';
import { GlyphFieldFont } from '@margoengine/text/outline';
import { openType } from '@margoengine/loaders/font-opentype';

const FONT = 'packages/text/tests/fixtures/fonts/SourceSans3-Regular.ttf',
  OTF = 'packages/text/tests/fixtures/fonts/SourceSans3-Regular.otf';
const PAIRS = ['AV', 'VA', 'AT', 'To', 'Ta', 'Te', 'Yo', 'Wa', 'LT', 'LY', 'P.', 'F,', 'r.', 'y.', 'Av', 'ov', 'AY', 'Tr', 'kn', 'OO'];
const LIMITS = { most: 2, share: 0.001 };

const context = await openBrowser({ startPath: '/packages/text/tests/outline-page.html', port: 'free' }),
  { page } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
const scratch = join(tmpdir(), `margo-outline-${process.pid}`);
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 60_000 });
  const run = await page.evaluate((url) => window.check.page(url), `/${FONT}`);
  assert.deepEqual(run.errors, [], 'no validation errors in the page');
  const seen = await decodePNG(new Uint8Array(await page.locator('#page').screenshot()));
  execFileSync(process.execPath, ['packages/text/tests/outline-scene.mts', FONT, `${scratch}.png`, `${scratch}.json`], {
    stdio: 'inherit',
    timeout: 180_000,
  });
  const node = JSON.parse(await readFile(`${scratch}.json`, 'utf8')),
    made = await decodePNG(new Uint8Array(await readFile(`${scratch}.png`)));
  assert.deepEqual(node.errors, [], 'no validation errors in Node');
  assert.equal(node.hash, run.hash, 'the page and Node build byte-identical glyph fields');
  assert.deepEqual([made.width, made.height], [seen.width, seen.height]);
  let most = 0,
    off = 0,
    ink = 0;
  for (let i = 0; i < made.data.length; i += 4) {
    let pixel = 0;
    for (let c = 0; c < 3; c++) pixel = Math.max(pixel, Math.abs(made.data[i + c] - seen.data[i + c]));
    most = Math.max(most, pixel);
    if (pixel > 1) off++;
    if (Math.abs(made.data[i] - made.data[0]) + Math.abs(made.data[i + 1] - made.data[1]) > 24) ink++;
  }
  const share = off / (made.data.length / 4),
    tier = compatRun() ? 'WebGL2 compatibility layer page' : 'native WebGPU page';
  console.log(`page (${tier}) against Node: largest channel difference ${most}, ${off} pixels (${(share * 100).toFixed(4)} %) off by more than 1, ${ink} ink pixels, field hash ${node.hash.slice(0, 16)}`);
  assert.ok(ink > 8000, `the title, caption and small text drew (${ink} ink pixels)`);
  assert.ok(most <= LIMITS.most, `largest channel difference ${most} is within ${LIMITS.most}`);
  assert.ok(share <= LIMITS.share, `${(share * 100).toFixed(4)} % of pixels off by more than 1 is within 0.1 %`);
  // Reported, not asserted: UiRenderer attaches input to the canvas by default, which a headless canvas cannot take (bug-sweep KB-FILM-UI-NODE).
  console.log(`Ui lower third in Node: ${JSON.stringify(node.ui).slice(0, 700)}`);
  // Kerning: the browser's shaper against the file's GPOS as GlyphFieldFont reads it.
  const reference = {};
  for (const file of [FONT, OTF]) {
    const measured = await page.evaluate(([url, pairs]) => window.check.browserKerning(url, pairs), [`/${file}`, PAIRS]),
      font = new GlyphFieldFont(await readFile(file), { openType }),
      ours = Object.fromEntries(PAIRS.map((pair) => [pair, Math.round(font.kerning(pair[0], pair[1]) * font.unitsPerEm)]));
    assert.deepEqual(ours, measured, `${file}: GlyphFieldFont kerning equals the browser's`);
    assert.ok(Object.values(ours).some((v) => v !== 0), 'some pairs are kerned');
    reference[file.split('/').pop()] = measured;
    console.log(`ok kerning ${file.split('/').pop()}: ${PAIRS.length} pairs equal the browser's (${PAIRS.filter((p) => ours[p]).length} kerned)`);
  }
  if (process.argv.includes('--write-kerning'))
    await writeFile(
      'packages/text/tests/fixtures/fonts/kerning-reference.json',
      `${JSON.stringify({ method: 'Chromium canvas measureText(pair) - measureText(first) - measureText(second) at 1000 px with fontKerning normal, from a FontFace of the file; in font units (unitsPerEm 1000)', browser: 'Playwright Chromium', fonts: reference }, null, 2)}\n`,
    );
  assert.deepEqual(pageErrors, []);
} finally {
  await rm(`${scratch}.png`, { force: true });
  await rm(`${scratch}-ui.png`, { force: true });
  await rm(`${scratch}.json`, { force: true });
  await context.close();
}
