// `npm run test:gallery:browser`: the Harrow Head gallery and the voxel sandbox, built as the site builds them
// (scripts/site-gallery.mjs) from this checkout into test-results/gallery-site, in a real WebGPU browser. Runs in
// check:gpu-packages under one GPU slot, after `npm run build:packages`; its sources are examples/gallery. It once
// read the site's own build folder, which only `npm run build:site` makes: the GPU runner alone failed it, and an older
// site build passed (tests/site-gallery.test.js).
//   every page in examples/gallery is built; title and description are unique; no long dashes; body text at least 16 px;
//   no sideways scroll at 390 px; the text and the panel read with JavaScript off; the JavaScript a page loads before its
//   first frame stays under the budget; every section of a scene page draws pixels with no console or GPU error; deep
//   links work; the numbers strip fills in; the dedication is absent until found, then shows without covering anything.
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { preview } from 'vite';
import { buildGallery, buildVoxel } from './site-gallery.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { closeAll } from './support/shutdown.mjs';
import { decodePNG } from '../tests/support/png.js';

/** Hard limit for the whole run: past this the process exits so a hung page cannot hold its GPU slot. */
const LIMIT_MS = 300_000;
/** A section has this long to appear; the largest published model is 13.5 MB read from disk. */
const SECTION_MS = 60_000;
/** Gzip bytes of JavaScript a gallery page may load before its first frame (threejs-gallery plan). */
export const PAGE_BUDGET = 120_000;
const EGG = 'Margo engine ❤️ made for Margie';

const root = resolve(import.meta.dirname, '..'),
  source = join(root, 'examples/gallery'),
  dist = join(root, 'test-results/gallery-site');

/**
 * Gzip bytes of a built chunk plus what it imports statically and, for the page's entry, what its WebGPU gate imports;
 * each counted once. Imports a scene makes later for one section (a decoder, say) are not before the first frame.
 */
async function pageBytes(folder, chunk, seen, entry = true) {
  if (seen.has(chunk)) return 0;
  seen.add(chunk);
  const code = await readFile(join(folder, chunk)),
    text = code.toString('utf8'),
    deps = [...text.matchAll(/(?:from\s*|import\s*)["']\.\/([^"']+\.js)["']/g)].map((m) => m[1]);
  if (entry) for (const [, dep] of text.matchAll(/import\(\s*[`"']\.\/([^`"']+\.js)[`"']/g)) deps.push(dep);
  let bytes = gzipSync(code).length;
  for (const dep of deps) bytes += await pageBytes(folder, dep, seen, false);
  return bytes;
}

let browser, site;
const timer = setTimeout(() => {
  console.error(`test-gallery-browser: over its ${LIMIT_MS / 1000} s limit, stopping`);
  // Closing the browser is itself bounded: a hung browser must not hold the GPU slot.
  setTimeout(() => process.exit(1), 15_000).unref();
  closeAll({ browser, servers: [site] }).finally(() => process.exit(1));
}, LIMIT_MS);
try {
  const pages = (await readdir(source)).filter((name) => name.endsWith('.html')).sort();
  assert.ok(pages.includes('index.html') && pages.includes('khronos.html'), 'the gallery pages are missing');
  await buildGallery(dist);
  await buildVoxel(dist);
  const built = (await readdir(join(dist, 'gallery'))).filter((name) => name.endsWith('.html')).sort();
  assert.deepEqual(built, pages, 'the gallery build differs from examples/gallery');
  site = await preview({
    configFile: false,
    root,
    build: { outDir: 'test-results/gallery-site' },
    preview: { port: 0, strictPort: true },
    logLevel: 'error',
  });
  const origin = new URL(site.resolvedUrls.local[0]).origin;
  browser = await launchBrowser({ headless: true, needs: 'webgpu', suite: 'gallery' });
  const titles = new Set(),
    descriptions = new Set();

  for (const name of pages) {
    const url = `${origin}/gallery/${name}`,
      html = await readFile(join(dist, 'gallery', name), 'utf8');

    // Budget: the entry chunks in the built html and everything they pull in before the first frame.
    const entries = [...html.matchAll(/<script[^>]*type="module"[^>]*src="\.\/assets\/([^"]+)"/g)].map((m) => m[1]);
    let bytes = 0;
    const seen = new Set();
    for (const entry of entries) bytes += await pageBytes(join(dist, 'gallery/assets'), entry, seen);
    assert.ok(
      bytes <= PAGE_BUDGET,
      `${name}: ${bytes} B gzip of JavaScript before the first frame, over ${PAGE_BUDGET}`,
    );

    // JavaScript off: the text and the sections are in the HTML; the dedication is not.
    const off = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
    const still = await off.newPage();
    await still.goto(url);
    assert.ok(await still.locator('h1').isVisible(), `${name}: no heading with JavaScript off`);
    const text = await still.locator('body').innerText();
    assert.ok(!text.includes('Margie'), `${name}: the dedication is in the page copy`);
    assert.ok(!html.includes('Margie'), `${name}: the dedication is in the built HTML`);
    await off.close();

    for (const [width, height] of [
      [1440, 900],
      [390, 844],
    ]) {
      const context = await browser.newContext({ viewport: { width, height } }),
        page = await context.newPage(),
        problems = [];
      page.on('pageerror', (error) => problems.push(error.message));
      page.on('console', (m) => {
        if (m.type() === 'error') problems.push(m.text());
      });
      await page.goto(url);
      const scene = await page.locator('.stage canvas').count();
      if (scene) await page.waitForFunction(() => window.gallery?.readiness === true, null, { timeout: SECTION_MS });
      const facts = await page.evaluate(() => ({
        title: document.title,
        description: document.querySelector('meta[name=description]')?.content,
        text: document.body.innerText,
        sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        body: parseFloat(getComputedStyle(document.body).fontSize),
        small: [...document.querySelectorAll('p, button, a, dd, dt, summary, label, code')]
          .filter((e) => parseFloat(getComputedStyle(e).fontSize) < 16 && e.textContent.trim())
          .map((e) => e.textContent.trim().slice(0, 40)),
        h1Lines: (() => {
          const h = document.querySelector('h1');
          return Math.round(h.getBoundingClientRect().height / parseFloat(getComputedStyle(h).lineHeight));
        })(),
      }));
      titles.add(facts.title);
      descriptions.add(facts.description);
      assert.ok(facts.description, `${name}: no description`);
      assert.ok(!/[–—]/.test(facts.text), `${name}: a long dash in the visible text`);
      assert.ok(facts.sideways <= 0, `${name} at ${width}: ${facts.sideways} px of sideways scroll`);
      assert.ok(facts.body >= 16, `${name}: body text ${facts.body} px`);
      assert.deepEqual(facts.small, [], `${name} at ${width}: text under 16 px`);
      assert.ok(facts.h1Lines <= 2, `${name} at ${width}: heading on ${facts.h1Lines} lines`);

      // The dedication: not there, three presses show it, and it covers neither the canvas nor the panel.
      assert.ok(!facts.text.includes('Margie'), `${name}: the dedication shows before it is found`);
      for (let i = 0; i < 3; i++) await page.keyboard.press('KeyM');
      await page.waitForFunction((egg) => document.querySelector('.egg')?.textContent === egg, EGG, { timeout: 2000 });
      const covers = await page.evaluate(() => {
        const box = (e) => e?.getBoundingClientRect(),
          egg = box(document.querySelector('.egg')),
          hit = (b) => !!b && egg.left < b.right && b.left < egg.right && egg.top < b.bottom && b.top < egg.bottom;
        return [hit(box(document.querySelector('.stage canvas'))), hit(box(document.querySelector('.panel')))];
      });
      assert.deepEqual(covers, [false, false], `${name}: the dedication covers the page`);

      if (scene && width === 1440) {
        const ids = await page.$$eval('[data-section]', (all) => all.map((b) => b.dataset.section));
        assert.ok(ids.length > 0, `${name}: a scene page with no sections`);
        for (const id of ids) {
          await page.evaluate((section) => window.gallery.setSection(section), id);
          await page.waitForFunction(() => window.gallery.readiness === true, null, { timeout: SECTION_MS });
          assert.equal(await page.locator(`[data-section="${id}"]`).getAttribute('aria-pressed'), 'true');
          const { data, width: w, height: h } = await decodePNG(await page.locator('.stage canvas').screenshot());
          const colours = new Set();
          for (let y = 0; y < h; y += 7)
            for (let x = 0; x < w; x += 7) {
              const at = (y * w + x) * 4;
              colours.add((data[at] << 16) | (data[at + 1] << 8) | data[at + 2]);
            }
          assert.ok(colours.size > 16, `${name} section ${id}: ${colours.size} colours, nothing drew`);
        }
        // The variant control shows only for a model with variants, and it changes what is drawn.
        const variants = page.locator('[data-variants]');
        await page.evaluate(() => window.gallery.setSection('ToyCar'));
        await page.waitForFunction(() => window.gallery.readiness === true, null, { timeout: SECTION_MS });
        assert.equal(await variants.isVisible(), false, 'an empty variant control shows on a model with none');
        await page.evaluate(() => window.gallery.setSection('SheenChair'));
        await page.waitForFunction(() => window.gallery.readiness === true, null, { timeout: SECTION_MS });
        assert.equal(await variants.isVisible(), true, 'no variant control on a model with variants');
        const shot = () => page.locator('.stage canvas').screenshot(),
          before = await shot();
        await variants.locator('select').selectOption('1');
        // The change reaches the screen within a few frames; each screenshot takes at least one.
        let changed = false;
        for (let i = 0; i < 20 && !changed; i++) changed = !before.equals(await shot());
        assert.ok(changed, 'choosing a variant changed nothing');
        const last = ids.at(-1);
        await page.goto(`${url}?section=${last}`);
        await page.waitForFunction(() => window.gallery?.readiness === true, null, { timeout: SECTION_MS });
        assert.equal(await page.evaluate(() => window.gallery.section), last, `${name}: the deep link was ignored`);
        await page.waitForFunction(
          () =>
            /\d/.test(document.querySelector('[data-number="frame"]').textContent) &&
            /\d/.test(document.querySelector('[data-number="draws"]').textContent),
          null,
          { timeout: 10_000 },
        );
        await page.evaluate(() => window.gallery.dispose());
      }
      assert.deepEqual(problems, [], `${name} at ${width}: console or page errors`);
      await context.close();
    }
    console.log(`${name}: ${bytes} B gzip before the first frame`);
  }
  assert.equal(titles.size, pages.length, 'every page has its own title');
  assert.equal(descriptions.size, pages.length, 'every page has its own description');

  // The published voxel sandbox hides the dedication as well.
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } }),
    page = await context.newPage();
  await page.goto(`${origin}/voxel/`);
  await page.waitForFunction(() => window.voxelSandbox?.ready === true, null, { timeout: SECTION_MS });
  assert.ok(!(await page.locator('#toast').innerText()).includes('Margie'));
  for (let i = 0; i < 3; i++) await page.keyboard.press('KeyM');
  await page.waitForFunction((egg) => document.querySelector('#toast')?.textContent === egg, EGG, { timeout: 2000 });
  await context.close();
  console.log(`gallery check passed: ${pages.length} pages and the voxel sandbox`);
} finally {
  clearTimeout(timer);
  await closeAll({ browser, servers: [site] });
}
