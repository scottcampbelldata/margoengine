// Runs the README quickstart and every guide in a real WebGPU browser, exactly as written (`npm run test:docs:browser`,
// part of `npm run check:gpu-packages`). Each page must draw a non-blank scene with no console error, page error or
// failed request, and the interactions the page teaches must work: orbit drags change the picture, a click picks the
// crate, a drag box selects, a button switches the animation clip.
//   node scripts/docs-browser-test.mjs                      run every page
//   node scripts/docs-browser-test.mjs --only=gltf,camera   run some (slugs from scripts/support/doc-snippets.mjs)
//   DOCS_SCREENSHOTS=1 node scripts/docs-browser-test.mjs   also write docs/images/*.webp (1280 px wide, at most 150 KB)
// The guides load /models/<file> from examples/assets and /textures/<file> from examples/assets/docs, the folders their
// text tells the reader to copy into public/.
import assert from 'node:assert/strict';
import { createReadStream, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { openBrowser } from './browser.js';
import { pages } from './support/doc-snippets.mjs';

const root = resolve(import.meta.dirname, '..');
const only = process.argv
  .find((a) => a.startsWith('--only='))
  ?.slice(7)
  .split(',');
const writeImages = process.env.DOCS_SCREENSHOTS === '1';
const imageDir = join(root, 'docs/images');
const pageDir = join(root, 'test-results/docs-pages');
const types = { '.glb': 'model/gltf-binary', '.png': 'image/png', '.jpg': 'image/jpeg' };

/** Serves the files the guides tell the reader to copy into public/. */
const assets = {
  name: 'docs-assets',
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      const match = /^\/(models|textures)\/([\w.-]+)$/.exec(request.url ?? '');
      if (!match) return next();
      const file = join(root, match[1] === 'models' ? 'examples/assets' : 'examples/assets/docs', match[2]);
      if (!existsSync(file)) {
        response.statusCode = 404;
        return response.end('missing');
      }
      response.setHeader('content-type', types[file.slice(file.lastIndexOf('.'))] ?? 'application/octet-stream');
      response.setHeader('content-length', statSync(file).size);
      createReadStream(file).pipe(response);
    });
  },
};

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

/** Re-encodes a screenshot as WebP, lowering quality until it is at most 150 KB. */
async function webp(png) {
  for (let quality = 84; quality >= 40; quality -= 6) {
    const data = await sharp(png).resize({ width: 1280, withoutEnlargement: true }).webp({ quality }).toBuffer();
    if (data.length <= 150_000) return data;
  }
  throw new Error('a screenshot does not fit 150 KB even at quality 40; simplify the scene');
}

async function main() {
  mkdirSync(pageDir, { recursive: true });
  if (writeImages) mkdirSync(imageDir, { recursive: true });
  const all = pages().filter((p) => !only || only.includes(p.slug));
  for (const p of all) {
    if (p.slug === 'quickstart') continue; // run from examples/quickstart, which tests/docs-guides.test.js proves equal
    mkdirSync(join(pageDir, p.slug), { recursive: true });
    const file = p.react ? 'main.tsx' : 'main.ts';
    writeFileSync(join(pageDir, p.slug, 'index.html'), p.html.replace('./main.ts', `./${file}`));
    writeFileSync(join(pageDir, p.slug, file), p.program);
  }
  const url = (p) =>
    p.slug === 'quickstart' ? '/examples/quickstart/index.html' : `/test-results/docs-pages/${p.slug}/index.html`;
  const browser = await openBrowser({ startPath: url(all[0]), plugins: [assets], port: 5199 });
  const { page } = browser;
  await page.setViewportSize({ width: 1280, height: 720 });
  const problems = [];
  page.on('console', (m) => m.type() === 'error' && problems.push(`console error: ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('requestfailed', (r) => problems.push(`request failed: ${r.url()}`));
  page.on(
    'response',
    (r) => r.status() >= 400 && !r.url().endsWith('favicon.ico') && problems.push(`${r.status()} ${r.url()}`),
  );

  const snap = async () => page.screenshot({ type: 'png' });
  const same = async (a, b) => Buffer.compare(await sharp(a).raw().toBuffer(), await sharp(b).raw().toBuffer()) === 0;
  const status = async () => (await page.textContent((await page.$('#doc-status')) ? '#doc-status' : '#status')) ?? '';
  const box = async () => await page.locator('canvas').first().boundingBox();
  const at = async (fx, fy) => {
    const b = await box();
    return [b.x + b.width * fx, b.y + b.height * fy];
  };
  const click = async (fx, fy) => {
    const [x, y] = await at(fx, fy);
    await page.mouse.click(x, y);
    await wait(500);
  };
  const drag = async (from, to, steps = 12, button = 'left') => {
    const [x0, y0] = await at(...from),
      [x1, y1] = await at(...to);
    await page.mouse.move(x0, y0);
    await page.mouse.down({ button });
    await page.mouse.move(x1, y1, { steps });
    await page.mouse.up({ button });
    await wait(400);
  };
  /** Clicks a grid over the middle of the canvas until the status text matches; returns the click position. */
  const find = async (pattern) => {
    for (const fy of [0.55, 0.62, 0.48, 0.7, 0.4, 0.78])
      for (const fx of [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74, 0.18, 0.82]) {
        await click(fx, fy);
        if (pattern.test(await status())) return [fx, fy];
      }
    throw new Error(`no click reached ${pattern}; the page said "${await status()}"`);
  };
  const filled = async (png, label) => {
    const { channels } = await sharp(png).stats();
    const spread = channels.slice(0, 3).reduce((sum, c) => sum + c.stdev, 0) / 3;
    assert.ok(
      spread > 8,
      `${label}: the picture is nearly one colour (spread ${spread.toFixed(1)}); nothing was drawn`,
    );
  };
  const save = async (p, png) => {
    if (!writeImages) return;
    const data = await webp(png);
    writeFileSync(join(imageDir, `${p.image}.webp`), data);
    console.log(`  wrote docs/images/${p.image}.webp (${data.length} bytes)`);
  };

  const run = {
    async quickstart() {
      const crate = await find(/Picked the crate/);
      await page.mouse.move(2, 2);
      await wait(300);
      const hero = await snap(); // the crate outlined, before the camera moves
      const ball = await find(/Picked the ball/);
      assert.notDeepEqual(crate, ball);
      await click(0.04, 0.9); // empty floor corner clears the selection
      assert.match(await status(), /Click the crate/);
      const before = await snap();
      await drag([0.5, 0.35], [0.62, 0.3]);
      assert.ok(!(await same(before, await snap())), 'an orbit drag must change the picture');
      assert.doesNotMatch(await status(), /Picked/, 'a drag must not pick');
      return hero;
    },
    async textures() {
      await wait(1500);
      return snap();
    },
    async lights() {
      await wait(1200);
      const a = await snap();
      await wait(900);
      assert.ok(!(await same(a, await snap())), 'the lamp must move');
      return snap();
    },
    async camera() {
      await wait(1000);
      const before = await snap();
      await drag([0.5, 0.5], [0.35, 0.42], 12, 'middle'); // the BLENDER profile turns the view with the middle button
      assert.ok(!(await same(before, await snap())), 'orbit drag must change the picture');
      await drag([0.5, 0.5], [0.55, 0.52], 12, 'middle');
      await wait(900); // damping settles
      return snap();
    },
    async interaction() {
      await wait(1000);
      await find(/Picked cube/);
      assert.match(await status(), /Picked cube \d\./);
      const before = await snap();
      const [fx, fy] = await find(/Picked cube/);
      await drag([fx, fy], [fx + 0.1, fy + 0.12]);
      assert.ok(!(await same(before, await snap())), 'dragging a cube must move it');
      await page.keyboard.down('Shift');
      await drag([0.1, 0.2], [0.9, 0.85], 20);
      await page.keyboard.up('Shift');
      assert.match(
        await status(),
        /^[1-9]\d* selected\.$/,
        `the drag box must select; the page said "${await status()}"`,
      );
      await page.mouse.move(2, 2);
      await wait(400);
      return snap();
    },
    async react() {
      await wait(2500);
      const rate = async () => Number.parseInt(await status(), 10);
      await page.waitForFunction(() => /commits per second/.test(document.querySelector('#status')?.textContent ?? ''));
      await wait(1500);
      const refRate = await rate();
      await page.click('button:text-is("Ref + useFrame")');
      await wait(3200);
      const stateRate = await rate();
      console.log(`  commits per second: ref ${refRate}, state ${stateRate}`);
      assert.ok(refRate <= 2, `the ref cube must not re-render every frame (${refRate} commits per second)`);
      assert.ok(stateRate >= 20, `the state cube must re-render about every frame (${stateRate} commits per second)`);
      await page.click('button:text-is("State-driven")');
      await wait(2300);
      return snap();
    },
    async 'react-document'() {
      await page.waitForSelector('#doc-status');
      const press = async (name) => {
        await page.click(`button:text-is("${name}")`);
        await wait(150);
      };
      for (const name of ['Add box', 'Add box', 'Add box', 'Add sphere', 'Add sphere']) await press(name);
      assert.match(await status(), /^5 items/);
      await press('Undo');
      assert.match(await status(), /^4 items/);
      await press('Redo');
      assert.match(await status(), /^5 items/);
      await press('Export');
      const saved = await page.inputValue('textarea');
      assert.equal(JSON.parse(saved).items.length, 5, 'Export writes the document as JSON');
      await page.fill('textarea', 'not json');
      await press('Import');
      assert.match(await status(), /^5 items.*SyntaxError/, 'bad JSON is refused and the scene is kept');
      await page.fill('textarea', '{"version":1,"items":[{"id":1,"shape":"box","position":[0,"x",0],"color":"#fff"}]}');
      await press('Import');
      assert.match(await status(), /^5 items.*Item 1 is not valid/, 'an invalid item is refused');
      await find(/Selected \d/); // picking is asynchronous: find() clicks, then waits for the state to change
      await press('Delete selected');
      assert.match(await status(), /^4 items/);
      await page.fill('textarea', saved);
      await press('Import');
      assert.match(await status(), /^5 items.*Loaded/);
      await find(/Selected \d/);
      await page.mouse.move(2, 2);
      await wait(300);
      return snap();
    },
    async gltf() {
      await page.waitForFunction(() => document.querySelector('#status')?.textContent?.startsWith('Loaded'), null, {
        timeout: 60000,
      });
      await wait(1500);
      return snap();
    },
    async animation() {
      await page.waitForSelector('button', { timeout: 60000 });
      await wait(1500);
      const names = await page.$$eval('button', (buttons) => buttons.map((b) => b.textContent));
      assert.ok(names.includes('Walking') && names.length >= 10, `clip buttons missing: ${names}`);
      await page.click('button:text-is("Walking")');
      await wait(800);
      const a = await snap();
      await wait(450);
      assert.ok(!(await same(a, await snap())), 'the walking clip must move the model');
      await page.click('button:text-is("Wave")');
      await wait(600);
      const waving = await snap();
      assert.ok(!(await same(a, waving)), 'a different clip must change the pose');
      await page.click('button:text-is("Walking")');
      await wait(700);
      return snap();
    },
  };

  let failed = 0;
  for (const p of all) {
    const started = Date.now();
    problems.length = 0;
    try {
      await page.goto(`http://127.0.0.1:5199${url(p)}`);
      await page.waitForSelector('canvas', { timeout: 60000 });
      const png = await run[p.slug](p);
      await filled(png, p.slug);
      assert.deepEqual(problems, [], `${p.slug}: browser reported problems`);
      await save(p, png);
      console.log(`ok   ${p.slug} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
    } catch (error) {
      failed++;
      console.log(`FAIL ${p.slug}: ${error.message}\n${problems.join('\n')}`);
      await page.screenshot({ path: join(pageDir, `${p.slug}-failed.png`) }).catch(() => {});
    }
  }
  await browser.close();
  if (!failed) rmSync(join(pageDir), { recursive: true, force: true });
  if (failed) process.exitCode = 1;
}

await main();
