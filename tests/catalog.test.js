import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { server } from '../scripts/serve-catalog.js';

let url;
const entries = JSON.parse(await readFile(new URL('../docs/catalog.json', import.meta.url), 'utf8'));
before(async () => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  url = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise(resolve => server.close(resolve)));

test('catalog covers every public package with matching versions, imports and repository links', async () => {
  for (const id of await readdir(new URL('../packages/', import.meta.url))) {
    let manifest;
    try { manifest = JSON.parse(await readFile(new URL(`../packages/${id}/package.json`, import.meta.url), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (manifest.private) continue;
    const entry = entries.find(entry => entry.id === id);
    assert.ok(entry, `${id} missing from catalog`);
    assert.equal(entry.package, manifest.name);
    assert.equal(entry.version, manifest.version);
    assert.equal(typeof entry.published, 'boolean');
    assert.ok(entry.install.includes(`${manifest.name}@${manifest.version}`));
    const runtime = await import(new URL(`../packages/${id}/dist/index.js`, import.meta.url));
    assert.deepEqual(entry.exports, Object.keys(runtime).sort());
    assert.ok(manifest.repository.url.endsWith('/margoengine.git'));
  }
  assert.equal(new Set(entries.map(entry => entry.package)).size, entries.length);
});

test('preview serves static files and rejects escaped paths and unsupported methods', async () => {
  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(await page.text(), /Find what you want to build/);
  assert.equal((await fetch(`${url}/catalog.json`, { method: 'HEAD' })).status, 200);
  assert.equal((await fetch(url, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`${url}/missing.html`)).status, 404);
  for (const [path, expected] of [['/%ZZ', 400], ['/..%2fpackage.json', 404], ['/%5c..%5cpackage.json', 404]]) {
    const status = await new Promise((resolve, reject) => {
      request(`${url}${path}`, response => { response.resume(); resolve(response.statusCode); }).on('error', reject).end();
    });
    assert.equal(status, expected, path);
  }
});

test('catalog searches, copies exact text, links examples, and handles clipboard denial', async () => {
  let browser;
  try { browser = await chromium.launch({ channel: 'msedge', headless: true }); }
  catch { browser = await chromium.launch({ headless: true }); }
  try {
    const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await context.newPage();
    const clipboard = async () => (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n');
    const errors = [];
    const requests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => requests.push(request.url()));
    await page.goto(url);
    await page.waitForFunction(() => !document.querySelector('#search').disabled);
    assert.equal(await page.locator('.module:visible').count(), entries.length);
    for (const id of ['dof', 'tonemap']) {
      assert.equal(await page.locator(`#${id} .run`).getAttribute('href'), `../demos/${id}/`);
      assert.equal(await page.locator(`#${id} .source`).isVisible(), false, 'A built route with bundled assets must not be called a complete copyable HTML example');
      assert.match(await page.locator(`#${id} .requirements`).textContent(), /\^0\.1\.0/);
    }
    for (const [term, id] of [['conveyor', 'machinery'], ['SectionPlanes', 'machinery'], ['loadGLTF', 'gltf'], ['particle', 'creative'], ['useFrame', 'react'], ['Camera', 'core']]) {
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
    assert.equal(await page.locator('#search').evaluate(element => element === document.activeElement), true);
    for (const card of await page.locator('.module').all()) {
      for (const kind of ['install', 'imports']) {
        await card.locator(`[data-copy="${kind}"]`).click();
        assert.equal(await clipboard(), await card.locator(`.${kind}`).textContent());
      }
      if (!await card.locator('.source').isVisible()) continue;
      await card.locator('.source summary').click();
      await card.locator('[data-copy="example"]').click();
      const example = await clipboard();
      const response = await fetch(new URL(await card.locator('.run').getAttribute('href'), url));
      assert.equal(example, (await response.text()).replace(/\r\n/g, '\n'));
      assert.match(example, /^<!doctype html>/);
      await card.locator('.source summary').click();
    }
    await page.locator('#machinery .exports summary').click();
    await page.getByRole('button', { name: 'Copy import for Kinematics', exact: true }).click();
    assert.equal(await clipboard(), "import { Kinematics } from '@margoengine/machinery';");
    await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error('Denied'); }; });
    await page.getByRole('button', { name: 'Copy import for SectionPlanes', exact: true }).click();
    assert.equal(await page.evaluate(() => window.getSelection().toString()), "import { SectionPlanes } from '@margoengine/machinery';");
    assert.match(await page.locator('#copy-status').textContent(), /Ctrl\+C/);
    for (const width of [375, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `overflow at ${width}px`);
    }
    assert.deepEqual(errors, []);
    assert.equal(requests.some(request => /cdn\.jsdelivr|esm\.sh/.test(request)), false, 'catalog must not load engine packages');
    await context.close();
  } finally { await browser.close(); }
});
