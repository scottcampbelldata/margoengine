import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { launchBrowser } from '../scripts/lib/browser.mjs';
import { server } from '../scripts/serve-catalog.js';

let url, browser;
const entries = JSON.parse(await readFile(new URL('../docs/catalog.json', import.meta.url), 'utf8'));
before(async () => {
  // Node's fetch reuses idle sockets; if the server's 5 s keep-alive timer closes one first (seconds pass between the
  // example fetches on a loaded machine), the reused request fails with ECONNRESET. Let the client close idle sockets.
  server.keepAliveTimeout = 0;
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  url = `http://127.0.0.1:${server.address().port}`;
  // One browser for the file: closing Edge is the slow step on a loaded machine (docs/known-bugs.md), so do it once.
  browser = await launchBrowser({ headless: true });
});
after(async () => {
  try {
    await browser?.close();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('catalog covers every public package with matching versions and imports, and no repository links', async () => {
  for (const id of await readdir(new URL('../packages/', import.meta.url))) {
    let manifest;
    try {
      manifest = JSON.parse(await readFile(new URL(`../packages/${id}/package.json`, import.meta.url), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (manifest.private) continue;
    const entry = entries.find((entry) => entry.id === id);
    assert.ok(entry, `${id} missing from catalog`);
    assert.equal(entry.package, manifest.name);
    assert.equal(entry.version, manifest.version);
    assert.equal(typeof entry.published, 'boolean');
    assert.ok(entry.install.includes(`${manifest.name}@${manifest.version}`));
    const runtime = await import(new URL(`../packages/${id}/dist/index.js`, import.meta.url));
    assert.deepEqual(entry.exports, Object.keys(runtime).sort());
    // Every published manifest links back to its folder in the source repository.
    assert.deepEqual(
      manifest.repository,
      { type: 'git', url: 'git+https://github.com/scottcampbelldata/margoengine.git', directory: `packages/${id}` },
      `${manifest.name} must name its repository folder`,
    );
    assert.equal(manifest.license, 'Apache-2.0', `${manifest.name} must be Apache-2.0 licensed`);
    assert.equal(manifest.author, 'Scott Campbell', `${manifest.name} must name its author`);
  }
  assert.equal(new Set(entries.map((entry) => entry.package)).size, entries.length);
});

test('preview serves static files and rejects escaped paths and unsupported methods', async () => {
  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(await page.text(), /Find what you want to build/);
  assert.equal((await fetch(`${url}/catalog.json`, { method: 'HEAD' })).status, 200);
  assert.equal((await fetch(url, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`${url}/missing.html`)).status, 404);
  for (const [path, expected] of [
    ['/%ZZ', 400],
    ['/..%2fpackage.json', 404],
    ['/%5c..%5cpackage.json', 404],
  ]) {
    const status = await new Promise((resolve, reject) => {
      request(`${url}${path}`, (response) => {
        response.resume();
        resolve(response.statusCode);
      })
        .on('error', reject)
        .end();
    });
    assert.equal(status, expected, path);
  }
});

// A loaded machine slows the browser by minutes (see tests/browser/catalog.test.js), so every browser step may take up
// to STEP_TIMEOUT before it fails naming the step; the test as a whole has a hard limit of 15 minutes.
const STEP_TIMEOUT = 5 * 60_000;

/** A context whose pages record clipboard writes and status messages. */
async function catalogContext() {
  const context = await browser.newContext();
  context.setDefaultTimeout(STEP_TIMEOUT);
  // The page clears #copy-status 7 s after each copy, so reading it later fails on a slow machine: record every
  // message it shows instead.
  // The Windows system clipboard is shared by every process, so any other browser or app can overwrite it between a
  // write and a read. Each page gets its own clipboard that records every writeText call; the copy buttons still call
  // navigator.clipboard.writeText and the test reads back exactly what they wrote.
  await context.addInitScript(() => {
    window.written = [];
    window.clipboardPolls = 0;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text) => {
          window.written.push(String(text));
        },
        readText: async () => window.written.at(-1) ?? '',
      },
    });
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
  return context;
}

const clipboardOf = async (page) => (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n');
// The predicate must be synchronous: Playwright does not await it, and a promise counts as true at once. The example
// copy fetches before it writes, so a wait that ends early reads the copy before it.
const clipboardHolds = (page, expected) =>
  page.waitForFunction(
    (expected) => {
      window.clipboardPolls++;
      return (window.written.at(-1) ?? '').replace(/\r\n/g, '\n') === expected;
    },
    expected,
    { timeout: STEP_TIMEOUT },
  );

const isExample = (target) => target.pathname.startsWith('/examples/');

/**
 * Holds every fetch of an example page until `release()`, which lets it through or, with `answer` 'abort', fails it.
 * `arrived` settles when the page has asked for it, and `done()` removes the hold.
 */
async function holdExample(page, answer = 'continue') {
  let release, arrive;
  const released = new Promise((resolve) => (release = resolve)),
    arrived = new Promise((resolve) => (arrive = resolve));
  await page.route(isExample, async (route) => {
    arrive();
    await released;
    await route[answer]();
  });
  return { release, arrived, done: () => page.unroute(isExample) };
}

// Regression (2026-10-31): the clipboard wait never waited, and one loaded landing read the imports copied just before.
test('the clipboard wait holds until a slow example has been written', { timeout: 15 * 60_000 }, async () => {
  const context = await catalogContext();
  try {
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForFunction(() => !document.querySelector('#search').disabled);
    const card = page.locator('#gltf');
    const imports = await card.locator('.imports').textContent();
    await card.locator('[data-copy="imports"]').click();
    await clipboardHolds(page, imports);
    const example = await card.locator('.run').getAttribute('href');
    const expected = (await (await fetch(new URL(example, url))).text()).replace(/\r\n/g, '\n');
    const held = await holdExample(page);
    await card.locator('.source summary').click();
    await held.arrived;
    await card.locator('[data-copy="example"]').click();
    await page.evaluate(() => {
      window.clipboardPolls = 0;
    });
    const waited = clipboardHolds(page, expected);
    // The wait has to be seen answering false while the example is held, with no clock in this: a wait that does not
    // wait finishes first.
    const polled = page.waitForFunction(() => window.clipboardPolls > 2 && window.written.length === 1);
    polled.catch(() => {});
    const ended = await Promise.race([waited.then(() => true), polled.then(() => false)]);
    assert.equal(ended, false, 'the clipboard wait ended while the example was still on its way');
    assert.equal(await clipboardOf(page), imports);
    held.release();
    await waited;
    assert.equal(await clipboardOf(page), expected);
  } finally {
    await context.close();
  }
});

// Regression (2026-10-31): a slow example that finished after a later copy overwrote what the person copied last.
test('the last copy click wins over an example still loading, and a stale failure says nothing', {
  timeout: 15 * 60_000,
}, async () => {
  const context = await catalogContext();
  try {
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForFunction(() => !document.querySelector('#search').disabled);
    const card = page.locator('#gltf');
    const install = await card.locator('.install').textContent();
    const held = await holdExample(page);
    await card.locator('.source summary').click();
    await held.arrived;
    await card.locator('[data-copy="example"]').click();
    await card.locator('[data-copy="install"]').click();
    await clipboardHolds(page, install);
    held.release();
    await page.waitForFunction(() => !document.querySelector('#gltf [data-copy="example"]').disabled);
    await held.done();
    assert.deepEqual(await page.evaluate(() => window.written), [install]);
    // The late example still fills the open source view; only the clipboard stays with the last click.
    assert.match(await card.locator('.example-code').textContent(), /^<!doctype html>/);

    // A second card, this time the fetch fails after a later copy: its failure message must not replace that copy's.
    const other = page.locator('#core');
    const refused = await holdExample(page, 'abort');
    await other.locator('.source summary').click();
    await refused.arrived;
    await other.locator('[data-copy="example"]').click();
    await other.locator('[data-copy="install"]').click();
    await clipboardHolds(page, await other.locator('.install').textContent());
    refused.release();
    await page.waitForFunction(() => !document.querySelector('#core [data-copy="example"]').disabled);
    assert.doesNotMatch((await page.evaluate(() => window.statuses)).join('\n'), /Could not copy the example/);

    // With nothing later, the same failure is reported: the guard only silences a copy that was overtaken.
    await other.locator('[data-copy="example"]').click();
    await page.waitForFunction(() => window.statuses.some((text) => /Could not copy the example/.test(text)));
    await refused.done();
  } finally {
    await context.close();
  }
});

test('catalog searches, copies exact text, links examples, and handles clipboard denial', {
  timeout: 15 * 60_000,
}, async () => {
  const context = await catalogContext();
  try {
    const page = await context.newPage();
    const clipboard = () => clipboardOf(page);
    const waitForClipboard = (expected) => clipboardHolds(page, expected);
    const errors = [];
    const requests = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => requests.push(request.url()));
    await page.goto(url);
    await page.waitForFunction(() => !document.querySelector('#search').disabled);
    assert.equal(await page.locator('.module:visible').count(), entries.length);
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
        await card.locator(`[data-copy="${kind}"]`).click();
        await waitForClipboard(await card.locator(`.${kind}`).textContent());
        assert.equal(await clipboard(), await card.locator(`.${kind}`).textContent());
      }
      if (!(await card.locator('.source').isVisible())) continue;
      await card.locator('.source summary').click();
      await card.locator('[data-copy="example"]').click();
      const response = await fetch(new URL(await card.locator('.run').getAttribute('href'), url));
      const expectedExample = (await response.text()).replace(/\r\n/g, '\n');
      await waitForClipboard(expectedExample);
      const example = await clipboard();
      assert.equal(example, expectedExample);
      assert.match(example, /^<!doctype html>/);
      await card.locator('.source summary').click();
    }
    await page.locator('#physics .exports summary').click();
    await page.getByRole('button', { name: 'Copy import for Vehicle', exact: true }).click();
    await waitForClipboard("import { Vehicle } from '@margoengine/physics';");
    assert.equal(await clipboard(), "import { Vehicle } from '@margoengine/physics';");
    const shown = await page.evaluate(() => {
      navigator.clipboard.writeText = async () => {
        throw new Error('Denied');
      };
      return window.statuses.length;
    });
    await page.getByRole('button', { name: 'Copy import for CharacterController', exact: true }).click();
    await page.waitForFunction(
      () => window.getSelection().toString() === "import { CharacterController } from '@margoengine/physics';",
    );
    assert.equal(
      await page.evaluate(() => window.getSelection().toString()),
      "import { CharacterController } from '@margoengine/physics';",
    );
    // The denied copy showed the select-and-press-Ctrl+C message (however long ago).
    assert.match((await page.evaluate((from) => window.statuses.slice(from), shown)).join('\n'), /Ctrl\+C/);
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
  } finally {
    await context.close();
  }
});
