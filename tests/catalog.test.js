import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { JSDOM, ResourceLoader, VirtualConsole } from 'jsdom';
import { server } from '../scripts/serve-catalog.js';

let url;
const entries = JSON.parse(await readFile(new URL('../docs/catalog.json', import.meta.url), 'utf8'));
before(async () => {
  // Node's fetch reuses idle sockets; if the server's 5 s keep-alive timer closes one first (seconds pass between
  // requests on a loaded machine), the reused request fails with ECONNRESET. Let the client close idle sockets.
  server.keepAliveTimeout = 0;
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

test('every package has a layer, in the Release presentation order', async () => {
  // docs/HANDOFF.md "Release presentation: many small packages": ten layers, "Start here" first.
  const layers = ['Start here', 'Setup and diagnostics', 'Loading and formats', 'Rendering and lighting', 'Post-processing', 'World and effects',
    'Animation and interaction', 'Simulation and games', 'CAD and engineering', 'Frameworks'];
  const dirs = [];
  for (const id of await readdir(new URL('../packages/', import.meta.url))) {
    try { if (!JSON.parse(await readFile(new URL(`../packages/${id}/package.json`, import.meta.url), 'utf8')).private) dirs.push(id); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  assert.deepEqual(entries.map(entry => entry.id).sort(), dirs.sort(), 'catalog and packages/ list the same packages');
  for (const entry of entries) assert.ok(layers.includes(entry.category), `${entry.package}: category ${entry.category}`);
  // Contiguous and in order: the page renders one section per run of equal categories.
  assert.deepEqual([...new Set(entries.map(entry => entry.category))], layers);
  assert.deepEqual(entries.slice(0, 2).map(entry => entry.package), ['margoengine', '@margoengine/core']);
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

// The page script in jsdom, served by the real preview server. jsdom has no fetch or clipboard, so both are supplied
// here; fetch is Node's, and every request is recorded. Layout and the real browser clipboard are checked in the
// browser lane (tests/browser/catalog.test.js, not in verify: headless Edge can take minutes to exit under load).
async function openCatalog(address, clipboard, errors, requests, selected) {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => errors.push(error.message));
  class Recorder extends ResourceLoader { fetch(resource, options) { requests.push(resource); return super.fetch(resource, options); } }
  const dom = await JSDOM.fromURL(address, {
    runScripts: 'dangerously', resources: new Recorder(), pretendToBeVisual: true, virtualConsole,
    beforeParse(window) {
      window.fetch = (resource, init) => { const target = new URL(resource, window.location.href).href; requests.push(target); return fetch(target, init); };
      Object.defineProperty(window.navigator, 'clipboard', { value: clipboard, configurable: true });
      window.addEventListener('error', event => errors.push(event.message));
      // jsdom collapses the selection when the page then focuses the <pre>; record the text as it is selected.
      const addRange = window.Selection.prototype.addRange;
      window.Selection.prototype.addRange = function (range) { selected.push(range.toString()); return addRange.call(this, range); };
    },
  });
  await until(() => !dom.window.document.querySelector('#search').disabled, 'the catalog to load');
  return dom;
}

// Poll for an explicit readiness condition instead of sleeping; bounded, with a message naming what never happened.
async function until(condition, what, timeout = 60_000) {
  for (const start = Date.now(); !condition();) {
    if (Date.now() - start > timeout) throw new Error(`Timed out after ${timeout / 1000} s waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('catalog searches, copies exact text, links examples, and handles clipboard denial', async () => {
  const errors = [], requests = [], copied = [], selected = [];
  const clipboard = { writeText: async text => { copied.push(text); } };
  let dom = await openCatalog(url, clipboard, errors, requests, selected);
  let { window } = dom, { document } = window;
  const $ = selector => document.querySelector(selector);
  const visible = element => { for (let node = element; node; node = node.parentElement) if (node.hidden) return false; return true; };
  const shown = () => [...document.querySelectorAll('.module')].filter(visible).length;
  const fill = value => { $('#search').value = value; $('#search').dispatchEvent(new window.Event('input', { bubbles: true })); };
  const copy = async (button, what) => {
    const count = copied.length;
    button.click();
    await until(() => copied.length > count, `${what} to reach the clipboard`);
    return copied.at(-1);
  };
  try {
    assert.equal(shown(), entries.length);
    // Grouped by layer, never one flat list: each card sits under its own layer's heading.
    assert.deepEqual([...document.querySelectorAll('.layer > h2')].map(h => h.textContent), [...new Set(entries.map(entry => entry.category))]);
    for (const entry of entries) assert.equal($(`#${entry.id}`).closest('.layer').querySelector('h2').textContent, entry.category, entry.id);
    fill('SectionPlanes');
    assert.deepEqual([...document.querySelectorAll('.layer')].filter(visible).map(layer => layer.querySelector('h2').textContent), ['CAD and engineering'], 'layers without a match hide');
    for (const id of ['dof', 'tonemap']) {
      assert.equal($(`#${id} .run`).getAttribute('href'), `../demos/${id}/`);
      assert.equal(visible($(`#${id} .source`)), false, 'A built route with bundled assets must not be called a complete copyable HTML example');
      assert.match($(`#${id} .requirements`).textContent, /\^1\.0\.0/);
    }
    for (const [term, id] of [['conveyor', 'machinery'], ['SectionPlanes', 'machinery'], ['loadGLTF', 'gltf'], ['particle', 'creative'], ['useFrame', 'react'], ['Camera', 'core']]) {
      fill(term);
      assert.equal(visible($(`#${id}`)), true, term);
    }
    const address = window.location.href;
    window.close();
    dom = await openCatalog(address, clipboard, errors, requests, selected);
    ({ window } = dom); ({ document } = window);
    assert.equal($('#search').value, 'Camera');
    fill('<img src=x onerror=alert(1)>');
    assert.equal(shown(), 0);
    assert.equal(visible($('#empty')), true);
    assert.equal(document.querySelector('img[src="x"]'), null, 'search text must never become markup');
    $('#clear').click();
    assert.equal(shown(), entries.length);
    assert.equal(document.activeElement, $('#search'));
    for (const card of document.querySelectorAll('.module')) {
      for (const kind of ['install', 'imports']) {
        assert.equal(await copy(card.querySelector(`[data-copy="${kind}"]`), `${card.id} ${kind}`), card.querySelector(`.${kind}`).textContent);
      }
      if (!visible(card.querySelector('.source'))) continue;
      card.querySelector('.source').open = true;
      const example = await copy(card.querySelector('[data-copy="example"]'), `${card.id} example`);
      const response = await fetch(new URL(card.querySelector('.run').getAttribute('href'), window.location.href));
      assert.equal(example.replace(/\r\n/g, '\n'), (await response.text()).replace(/\r\n/g, '\n'));
      assert.match(example, /^<!doctype html>/);
      card.querySelector('.source').open = false;
    }
    const exportButton = name => $(`#machinery .export-list [aria-label="Copy import for ${name}"]`);
    assert.equal(await copy(exportButton('Kinematics'), 'the Kinematics import'), "import { Kinematics } from '@margoengine/machinery';");
    clipboard.writeText = async () => { throw new Error('Denied'); };
    exportButton('SectionPlanes').click();
    await until(() => selected.length, 'the copy-denied fallback to select the text');
    assert.deepEqual(selected, ["import { SectionPlanes } from '@margoengine/machinery';"]);
    assert.equal(document.activeElement, $('#machinery .imports').closest('pre'));
    assert.match($('#copy-status').textContent, /Ctrl\+C/);
    assert.deepEqual(errors, []);
    assert.equal(requests.some(request => /cdn\.jsdelivr|esm\.sh/.test(request)), false, 'catalog must not load engine packages');
  } finally { window.close(); }
});
