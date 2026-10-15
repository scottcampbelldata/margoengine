// margoengine.com/sizes.html (scripts/build-sizes.js): every catalog package, grouped by layer, with numbers from the one
// entry-sizes.json measurement and the commit it measured. Checks the committed record; `npm run build:site` re-measures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readSizesInputs, sizesPage } from '../scripts/build-sizes.js';

const inputs = readSizesInputs(), { catalog, sizes } = inputs;
const { document } = new JSDOM(sizesPage(inputs)).window;
const number = cell => Number(cell.textContent.replaceAll(',', ''));

test('sizes page lists every catalog package with numbers from the same measured commit', () => {
  assert.match(sizes.commit, /^[0-9a-f]{7,}$/);
  assert.equal(typeof sizes.dirty, 'boolean');
  assert.match(document.querySelector('.sizes-intro .section-lede').textContent, new RegExp(`commit ${sizes.commit}\\b`));
  const listed = [...document.querySelectorAll('tbody[data-package]')];
  assert.deepEqual(listed.map(body => body.dataset.package), catalog.map(entry => entry.package), 'every package once, in catalog order');
  for (const body of listed) {
    const measured = Object.values(sizes.packages[body.dataset.package]), rows = [...body.rows];
    assert.ok(measured.length, `${body.dataset.package} has a measurement`);
    assert.equal(rows.length, measured.length, body.dataset.package);
    rows.forEach((row, i) => {
      const [raw, gzip] = row.querySelectorAll('.num');
      assert.deepEqual([number(raw), number(gzip)], [measured[i].raw, measured[i].gzip], `${body.dataset.package} row ${i}`);
      assert.ok(measured[i].gzip > 0 && measured[i].raw > 0);
    });
  }
});

test('sizes page leads with core + stage under its limit, groups by layer and runs no script', () => {
  const { gzip, limit } = sizes.coreStage;
  assert.equal(limit, 20_000);
  assert.ok(gzip < limit);
  const meter = document.querySelector('meter');
  assert.deepEqual([Number(meter.getAttribute('value')), Number(meter.getAttribute('max'))], [gzip, limit]);
  assert.match(document.querySelector('.budget-figure').textContent, new RegExp(`${gzip.toLocaleString('en-US')} B`));
  assert.ok(document.querySelector('.budget').compareDocumentPosition(document.querySelector('.layer')) & 4, 'core + stage comes first');
  const layers = [...document.querySelectorAll('.layer')];
  assert.deepEqual(layers.map(layer => layer.querySelector('h2').textContent), [...new Set(catalog.map(entry => entry.category))]);
  assert.equal(layers[0].querySelector('h2').textContent, 'Start here');
  for (const layer of layers) {
    const region = layer.querySelector('.table-scroll');
    assert.equal(region.getAttribute('role'), 'region');
    assert.equal(region.getAttribute('aria-labelledby'), layer.querySelector('h2').id);
    assert.ok(region.querySelector('table > caption'));
    assert.equal(region.querySelectorAll('thead th[scope="col"]').length, 5);
    for (const body of region.querySelectorAll('tbody')) {
      const category = catalog.find(entry => entry.package === body.dataset.package).category;
      assert.equal(category, layer.querySelector('h2').textContent, body.dataset.package);
      assert.equal(body.querySelector('th[scope="rowgroup"]').getAttribute('rowspan'), String(body.rows.length));
    }
  }
  assert.equal(document.querySelectorAll('script, [style]').length, 0, 'CSP: no scripts or inline styles');
  for (const element of document.querySelectorAll('*')) for (const { name } of element.attributes) assert.doesNotMatch(name, /^on/i);
});

test('sizes page refuses a catalog package without a measurement', () => {
  const packages = { ...sizes.packages };
  delete packages['@margoengine/core'];
  assert.throws(() => sizesPage({ ...inputs, sizes: { ...sizes, packages } }), /no sizes for @margoengine\/core/);
});
