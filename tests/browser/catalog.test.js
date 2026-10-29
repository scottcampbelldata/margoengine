// Real-browser catalog check (Edge): layout overflow, real clicks and the browser clipboard. Not part of `verify`:
// headless Edge shuts down on low-priority threads, so on a loaded machine browser.close() can take 4-6 minutes.
// `tests/catalog.test.js` runs nearly the same checks inside verify. Run under the GPU lock:
//   node scripts/gpu-lock.mjs run --owner=<agent id> -- npm run test:catalog:browser
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { launchBrowser } from '../../scripts/lib/browser.mjs';
import { server } from '../../scripts/serve-catalog.js';

let url;
const entries = JSON.parse(await readFile(new URL('../../docs/catalog.json', import.meta.url), 'utf8'));
before(async () => {
  server.keepAliveTimeout = 0; // see tests/catalog.test.js: avoids ECONNRESET on reused sockets under load
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  url = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((resolve) => server.close(resolve)));

test('catalog searches, copies exact text, links examples, and handles clipboard denial', {
  timeout: 15 * 60_000,
}, async () => {
  let browser;
  browser = await launchBrowser({ headless: true });
  try {
    const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    // No step has a deadline of its own (a loaded machine slows the browser by minutes); the test as a whole has one.
    context.setDefaultTimeout(0);
    // Count finished clipboard writes: copy handlers are async (the example copy fetches first), so wait for the
    // write to land instead of reading the clipboard right after the click. The page clears #copy-status 7 s after
    // each copy, so waiting for a message after a slow round trip can miss it: record every message it shows.
    await context.addInitScript(() => {
      window.copies = 0;
      const write = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = async (text) => {
        await write(text);
        window.copies++;
      };
      window.statuses = [];
      addEventListener('DOMContentLoaded', () => {
        const status = document.querySelector('#copy-status');
        new MutationObserver(() => window.statuses.push(status.textContent)).observe(status, {
          childList: true,
          characterData: true,
          subtree: true,
        });
      });
    });
    const page = await context.newPage();
    const copy = async (locator) => {
      const before = await page.evaluate(() => window.copies);
      await locator.click();
      await page.waitForFunction((before) => window.copies > before, before);
      return (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n');
    };
    const errors = [];
    const requests = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => requests.push(request.url()));
    await page.goto(url);
    await page.waitForFunction(() => !document.querySelector('#search').disabled);
    assert.equal(await page.locator('.module:visible').count(), entries.length);
    for (const id of ['dof', 'tonemap']) {
      assert.equal(await page.locator(`#${id} .run`).getAttribute('href'), `../demos/${id}/`);
      assert.equal(
        await page.locator(`#${id} .source`).isVisible(),
        false,
        'A built route with bundled assets must not be called a complete copyable HTML example',
      );
      assert.match(await page.locator(`#${id} .requirements`).textContent(), /\^1\.0\.0/);
    }
    for (const [term, id] of [
      ['Gerstner', 'water'],
      ['CharacterController', 'physics'],
      ['loadGLTF', 'gltf'],
      ['particle', 'creative'],
      ['useFrame', 'react'],
      ['Camera', 'core'],
    ]) {
      await page.getByLabel('Search modules and API names').fill(term);
      assert.equal(await page.locator(`#${id}`).isVisible(), true, term);
    }
    await page.reload();
    await page.waitForFunction(() => !document.querySelector('#search').disabled);
    assert.equal(await page.locator('#search').inputValue(), 'Camera');
    await page.getByLabel('Search modules and API names').fill('<img src=x onerror=alert(1)>');
    assert.equal(await page.locator('.module:visible').count(), 0);
    assert.equal(await page.locator('#empty').isVisible(), true);
    await page.getByRole('button', { name: 'Clear search', exact: true }).click();
    assert.equal(await page.locator('.module:visible').count(), entries.length);
    assert.equal(await page.locator('#search').evaluate((element) => element === document.activeElement), true);
    for (const card of await page.locator('.module').all()) {
      for (const kind of ['install', 'imports']) {
        assert.equal(await copy(card.locator(`[data-copy="${kind}"]`)), await card.locator(`.${kind}`).textContent());
      }
      if (!(await card.locator('.source').isVisible())) continue;
      await card.locator('.source summary').click();
      const example = await copy(card.locator('[data-copy="example"]'));
      const response = await fetch(new URL(await card.locator('.run').getAttribute('href'), url));
      assert.equal(example, (await response.text()).replace(/\r\n/g, '\n'));
      assert.match(example, /^<!doctype html>/);
      await card.locator('.source summary').click();
    }
    await page.locator('#physics .exports summary').click();
    assert.equal(
      await copy(page.getByRole('button', { name: 'Copy import for Vehicle', exact: true })),
      "import { Vehicle } from '@margoengine/physics';",
    );
    const shown = await page.evaluate(() => {
      navigator.clipboard.writeText = async () => {
        throw new Error('Denied');
      };
      return window.statuses.length;
    });
    await page.getByRole('button', { name: 'Copy import for CharacterController', exact: true }).click();
    await page.waitForFunction((from) => window.statuses.slice(from).some((text) => /Ctrl\+C/.test(text)), shown);
    assert.equal(
      await page.evaluate(() => window.getSelection().toString()),
      "import { CharacterController } from '@margoengine/physics';",
    );
    for (const width of [375, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
        `overflow at ${width}px`,
      );
    }
    assert.deepEqual(errors, []);
    assert.equal(
      requests.some((request) => /cdn\.jsdelivr|esm\.sh/.test(request)),
      false,
      'catalog must not load engine packages',
    );
    await context.close();
  } finally {
    await browser.close();
  }
});
