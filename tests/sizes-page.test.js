// margoengine.com/sizes.html (scripts/build-sizes.js): every catalog package, grouped by layer, every file loaded later
// and the basic glTF scene's network log, with numbers from the one entry-sizes.json measurement, the network record of
// the same commit, and that commit. Checks the committed records; `npm run build:site` re-measures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { readSizesInputs, sizesPage } from '../scripts/build-sizes.js';
import { LAZY_FILES, lazyFileDrift, unmeasuredLazyFiles } from '../scripts/lazy-files.js';
import { CORE_STAGE_GZIP_LIMIT } from '../scripts/core-budget.js';
import { sceneGraph } from '../scripts/support/basic-scene-graph.mjs';

const inputs = readSizesInputs(),
  { catalog, sizes, network } = inputs;
const { document } = new JSDOM(sizesPage(inputs)).window;
const number = (cell) => Number(cell.textContent.replaceAll(',', ''));

test('lazy file package groups stay contiguous in table order', () => {
  const groups = new Set();
  let previous;
  for (const { package: name } of LAZY_FILES) {
    if (name === previous) continue;
    assert.ok(!groups.has(name), `${name}: keep all lazy files together in the package row group`);
    groups.add(name);
    previous = name;
  }
});

test('every lazy file names what it leaves out as patterns, or entry-sizes.mjs cannot measure it', () => {
  for (const { file, measure, external } of LAZY_FILES)
    if (measure === 'bundle')
      assert.ok(
        external.every((pattern) => pattern instanceof RegExp),
        file,
      );
});

test('sizes page lists every catalog package with numbers from the same measured commit', () => {
  assert.match(sizes.commit, /^[0-9a-f]{7,}$/);
  assert.equal(typeof sizes.dirty, 'boolean');
  assert.match(
    document.querySelector('.sizes-intro .section-lede').textContent,
    new RegExp(`commit ${sizes.commit}\\b`),
  );
  const listed = [...document.querySelectorAll('tbody[data-package]')];
  assert.deepEqual(
    listed.map((body) => body.dataset.package),
    catalog.map((entry) => entry.package),
    'every package once, in catalog order',
  );
  for (const body of listed) {
    const measured = Object.values(sizes.packages[body.dataset.package]),
      rows = [...body.rows];
    assert.ok(measured.length, `${body.dataset.package} has a measurement`);
    assert.equal(rows.length, measured.length, body.dataset.package);
    rows.forEach((row, i) => {
      const [raw, gzip] = row.querySelectorAll('.num');
      assert.deepEqual(
        [number(raw), number(gzip)],
        [measured[i].raw, measured[i].gzip],
        `${body.dataset.package} row ${i}`,
      );
      assert.ok(measured[i].gzip > 0 && measured[i].raw > 0);
    });
  }
});

test('sizes page leads with core + stage under its limit, groups by layer and runs no script', () => {
  const { gzip, limit } = sizes.coreStage;
  assert.equal(limit, CORE_STAGE_GZIP_LIMIT);
  assert.ok(gzip < limit);
  const meter = document.querySelector('meter');
  assert.deepEqual([Number(meter.getAttribute('value')), Number(meter.getAttribute('max'))], [gzip, limit]);
  assert.match(document.querySelector('.budget-figure').textContent, new RegExp(`${gzip.toLocaleString('en-US')} B`));
  assert.ok(
    document.querySelector('.budget').compareDocumentPosition(document.querySelector('.layer')) & 4,
    'core + stage comes first',
  );
  const layers = [...document.querySelectorAll('.layer')];
  assert.deepEqual(
    layers.map((layer) => layer.querySelector('h2').textContent),
    [...new Set(catalog.map((entry) => entry.category))],
  );
  assert.equal(layers[0].querySelector('h2').textContent, 'Start here');
  for (const layer of layers) {
    const region = layer.querySelector('.table-scroll');
    assert.equal(region.getAttribute('role'), 'region');
    assert.equal(region.getAttribute('aria-labelledby'), layer.querySelector('h2').id);
    assert.ok(region.querySelector('table > caption'));
    assert.equal(region.querySelectorAll('thead th[scope="col"]').length, 5);
    for (const body of region.querySelectorAll('tbody')) {
      const category = catalog.find((entry) => entry.package === body.dataset.package).category;
      assert.equal(category, layer.querySelector('h2').textContent, body.dataset.package);
      assert.equal(body.querySelector('th[scope="rowgroup"]').getAttribute('rowspan'), String(body.rows.length));
    }
  }
  assert.equal(document.querySelectorAll('script, [style]').length, 0, 'CSP: no scripts or inline styles');
  for (const element of document.querySelectorAll('*'))
    for (const { name } of element.attributes) assert.doesNotMatch(name, /^on/i);
});

test('sizes page refuses a catalog package without a measurement', () => {
  const packages = { ...sizes.packages };
  delete packages['@margoengine/core'];
  assert.throws(() => sizesPage({ ...inputs, sizes: { ...sizes, packages } }), /no sizes for @margoengine\/core/);
});

// Regression (2026-11-10): 9de13807a built hdr6.worker.js and hdr6.wasm with no LAZY_FILES row and main failed this file
// for hours; the drift check now also runs in `npm run quality`, which every lane runs before a push.
test('lazy file drift finds an unlisted worker, Wasm or URL-loaded file and a listed file that was not built', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'margo-lazy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, text = '') => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  write('packages/a/dist/index.js', "new Worker(new URL('./tile.worker.js?no-inline', import.meta.url));\n");
  write('packages/a/dist/tile.worker.js', "fetch(new URL('./model.data', import.meta.url));\n");
  write('packages/a/dist/model.data');
  write('packages/a/dist/codec.wasm');
  write('packages/a/dist/listed.wasm');
  write('packages/margoengine/dist/umbrella.wasm');
  const row = (file) => ({ package: '@margoengine/a', file, label: file, kind: 'Wasm', measure: 'file', when: '-' });
  assert.deepEqual(lazyFileDrift(root, [row('packages/a/dist/listed.wasm'), row('packages/a/dist/gone.worker.js')]), {
    unlisted: ['packages/a/dist/codec.wasm', 'packages/a/dist/model.data', 'packages/a/dist/tile.worker.js'],
    unbuilt: ['packages/a/dist/gone.worker.js'],
  });
  // A row with no measurement (b3e5e8f7d listed cpu-kernel.wasm without measuring it, and this file failed to load).
  write(
    'examples/package-benchmarks/results/entry-sizes.json',
    JSON.stringify({ lazyFiles: { 'packages/a/dist/listed.wasm': {} } }),
  );
  assert.deepEqual(unmeasuredLazyFiles(root, [row('packages/a/dist/listed.wasm'), row('packages/a/dist/codec.wasm')]), [
    'packages/a/dist/codec.wasm',
  ]);
  const gate = readFileSync(new URL('../scripts/quality/sizes.js', import.meta.url), 'utf8');
  assert.match(gate, /const \{ unlisted, unbuilt \} = lazyFileDrift\(root\);/, 'npm run quality checks the drift');
  assert.match(gate, /const unmeasured = unmeasuredLazyFiles\(root\);/, 'npm run quality checks the measurements');
});

test('sizes page lists every file loaded later, with its measured bytes and the call that loads it', () => {
  const root = new URL('../', import.meta.url);
  // Both ways: every built worker and .wasm is listed in scripts/lazy-files.js, and every listed one was built.
  assert.deepEqual(
    lazyFileDrift(fileURLToPath(root)),
    { unlisted: [], unbuilt: [] },
    'run npm run build:packages first',
  );
  for (const entry of LAZY_FILES) assert.ok(existsSync(new URL(entry.file, root)), entry.file);
  for (const name of [
    'draco_decoder.wasm',
    'basis_transcoder.wasm',
    'rapier3d-compat',
    'gltf.js',
    'decoder.worker.js',
    'sciviz/dist/fallback.wasm',
    'sciviz/dist/flow.wasm',
  ])
    assert.ok(
      LAZY_FILES.some((entry) => entry.file.includes(name)),
      name,
    );
  const rows = [...document.querySelectorAll('#loaded-later ~ .table-scroll tbody tr:not(.group)')];
  assert.equal(rows.length, LAZY_FILES.length);
  rows.forEach((row, i) => {
    const entry = LAZY_FILES[i],
      cells = [...row.querySelectorAll('td')],
      body = row.closest('tbody');
    assert.equal(body.dataset.lazyPackage, entry.package);
    assert.equal(body.querySelector('tr.group th[scope="rowgroup"]').textContent, entry.package);
    assert.equal(row.querySelector('th[scope="row"]').textContent, entry.label);
    assert.deepEqual(
      [...row.querySelectorAll('.num')].map(number),
      ['raw', 'gzip', 'brotli'].map((key) => sizes.lazyFiles[entry.file][key]),
      entry.file,
    );
    assert.equal(cells.at(-1).textContent, entry.when.replaceAll('`', ''), `${entry.file}: when it loads`);
    assert.ok(sizes.lazyFiles[entry.file].brotli > 0);
  });
});

test('sizes page shows the basic glTF scene network log from the same build: only the HTML, core + stage, glTF and model', () => {
  assert.deepEqual([network.commit, network.dirty], [sizes.commit, sizes.dirty]);
  const paths = network.files.map((file) => file.path);
  assert.deepEqual(
    paths.filter((path) => /\.wasm$|draco|basis|rapier|recast|worker/i.test(path)),
    [],
  );
  for (const role of ['Page', 'Entry: core + stage + app', '@margoengine/gltf (addGLTF)', 'Model'])
    assert.equal(network.files.filter((file) => file.role === role).length, 1, role);
  assert.ok(
    network.files.every((file) => file.role),
    'every request is an expected file',
  );
  const graph = sceneGraph(network.buildManifest);
  const required = new Set(['index.html', 'model.glb', ...graph.entry, ...graph.gltf]);
  assert.deepEqual([...paths].sort(), [...required].sort(), 'exactly the routed basic glTF static request graph');
  const deferred = [...graph.emittedFiles].filter((path) => !required.has(path));
  assert.deepEqual(
    network.notFetched.map((file) => file.path).sort(),
    deferred.sort(),
    'every deferred file belongs to the selected glTF feature, with no unrelated asset',
  );
  assert.ok(network.notFetched.every((file) => file.raw > 0 && !required.has(file.path)));
  for (const key of ['transferred', 'raw', 'gzip', 'brotli'])
    assert.equal(
      network.total[key],
      network.files.reduce((sum, file) => sum + file[key], 0),
      key,
    );
  const rows = [...document.querySelectorAll('#basic-scene ~ .table-scroll tbody tr')];
  assert.equal(rows.length, network.files.length + 1, 'one row per request plus the total');
  [...network.files, network.total].forEach((file, i) => {
    assert.deepEqual(
      [...rows[i].querySelectorAll('.num')].map(number),
      [file.transferred, file.raw, file.gzip, file.brotli],
      file.path ?? 'total',
    );
    if (file.path) assert.equal(rows[i].querySelector('th').textContent, file.path);
  });
  assert.match(rows.at(-1).querySelector('th').textContent, new RegExp(`${network.files.length} requests`));
});

test('sizes page refuses a network record from another build', () => {
  assert.throws(
    () => sizesPage({ ...inputs, network: { ...network, commit: '0000000' } }),
    /basic-scene-network\.json measured 0000000/,
  );
  assert.throws(
    () => sizesPage({ ...inputs, network: { ...network, dirty: !network.dirty } }),
    /basic-scene-network\.json/,
  );
});

test('every external of a file loaded later is a pattern, as entry-sizes tests each id against it', () => {
  for (const { file, external = [] } of LAZY_FILES)
    for (const pattern of external)
      assert.ok(pattern instanceof RegExp, `${file} lists ${pattern}, which is no RegExp`);
});
