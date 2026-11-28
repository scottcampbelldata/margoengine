// KB-3MF-PARTLIMIT1: parse3MF refused a package of more than 1,024 model parts with no option to lift it, so Margo
// could not read its own NodePerformanceTest export of 10,000 parts. The limit is now `maxModelParts`, default 65,535
// (every part a ZIP without ZIP64 can hold), and the 3MF entry limit follows it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parse3MF } from '../dist/index.js';
import { zip } from './threemf-surface.js';

const NS =
  'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"';
const part = (i) =>
  `<?xml version="1.0"?><model unit="millimeter" ${NS}><resources><object id="1" type="model"><mesh><vertices>` +
  `<vertex x="${i}" y="0" z="0"/><vertex x="${i + 1}" y="0" z="0"/><vertex x="${i}" y="1" z="0"/>` +
  `</vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object></resources><build/></model>`;

/** A package whose root names `count` parts, each one triangle. */
const pack = (count) => {
  const files = {
    '[Content_Types].xml':
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>',
  };
  const components = [];
  for (let i = 0; i < count; i++) {
    files[`3D/Objects/p${i}.model`] = part(i);
    components.push(`<component p:path="/3D/Objects/p${i}.model" objectid="1"/>`);
  }
  files['3D/3dmodel.model'] =
    `<?xml version="1.0"?><model unit="millimeter" ${NS}><resources><object id="1"><components>${components.join('')}` +
    `</components></object></resources><build><item objectid="1"/></build></model>`;
  return zip(files);
};

test('parse3MF reads 10,000 model parts by default (KB-3MF-PARTLIMIT1)', async () => {
  const result = await parse3MF(pack(10_000));
  assert.equal(result.indices.length, 10_000 * 3);
  assert.equal(new Set(result.groups.map((g) => g.modelPath)).size, 10_000);
});

test('maxModelParts refuses a package naming more parts, the root counted', async () => {
  const file = pack(4);
  await assert.rejects(parse3MF(file, { maxModelParts: 4 }), (e) => e.code === 'limit' && /maxModelParts/.test(e.message));
  assert.equal((await parse3MF(file, { maxModelParts: 5 })).indices.length, 12);
  for (const bad of [0, -1, 1.5, NaN])
    await assert.rejects(parse3MF(file, { maxModelParts: bad }), (e) => e.code === 'range');
  // An explicit entry limit still wins over the 3MF default.
  await assert.rejects(parse3MF(file, { maxEntries: 5 }), (e) => e.code === 'limit' && /entries/.test(e.message));
});
