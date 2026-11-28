// Volume data read at points: color, composite mixture and properties, with the expected values from the volumetric
// extension's rules (https://github.com/3MFConsortium/spec_volumetric, chapter 5).
import test from 'node:test';
import assert from 'node:assert/strict';
import { parse3MFEvaluated } from '../dist/threemf-evaluate.js';
import { parse3MFVolumetric } from '../dist/threemf-volumetric.js';
import { box, meshXML, zip } from './threemf-surface.js';

const NS = [
  'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"',
  'xmlns:v="http://schemas.3mf.io/3dmanufacturing/volumetric/2022/01"',
  'xmlns:i="http://schemas.3mf.io/3dmanufacturing/implicit/2023/12"',
  'xmlns:d="http://schemas.3mf.io/3dmanufacturing/displacement/2023/10"',
  'xmlns:p="http://example.com/part-properties"',
].join(' ');
const pack = (resources) =>
  zip({
    '3D/3dmodel.model': `<model unit="millimeter" ${NS} requiredextensions="v i d"><resources>${resources}</resources><build><item objectid="9" transform="1 0 0 0 1 0 0 0 1 100 0 0"/></build></model>`,
  });
// f(pos) gives `x` = pos.x, `rest` = 1 - pos.x, `where` = pos and `inverse` = 1 / pos.y.
const functions = `<i:implicitfunction id="3"><i:in><i:vector identifier="pos"/></i:in>
  <i:decomposevector identifier="parts"><i:in><i:vectorref identifier="A" ref="inputs.pos"/></i:in><i:out><i:scalar identifier="x"/><i:scalar identifier="y"/><i:scalar identifier="z"/></i:out></i:decomposevector>
  <i:constant identifier="one" value="1"><i:out><i:scalar identifier="value"/></i:out></i:constant>
  <i:subtraction identifier="rest"><i:in><i:scalarref identifier="A" ref="one.value"/><i:scalarref identifier="B" ref="parts.x"/></i:in><i:out><i:scalar identifier="result"/></i:out></i:subtraction>
  <i:division identifier="inverse"><i:in><i:scalarref identifier="A" ref="one.value"/><i:scalarref identifier="B" ref="parts.y"/></i:in><i:out><i:scalar identifier="result"/></i:out></i:division>
  <i:out><i:scalarref identifier="x" ref="parts.x"/><i:scalarref identifier="rest" ref="rest.result"/><i:vectorref identifier="where" ref="inputs.pos"/><i:scalarref identifier="inverse" ref="inverse.result"/></i:out>
</i:implicitfunction>`;
const bases =
  '<basematerials id="2"><base name="hard" displaycolor="#FF0000"/><base name="soft" displaycolor="#0000FF"/></basematerials>';
const mapping = (channel, extra = '') => `<v:materialmapping functionid="3" channel="${channel}" ${extra}/>`;
const volume = (mappings) =>
  `<v:volumedata id="5"><v:color functionid="3" channel="where"/><v:composite basematerialid="2">${mappings}</v:composite>
  <v:property name="p:density" functionid="3" channel="x" required="true"/>
  <v:property name="p:flow" functionid="3" channel="where" transform="2 0 0 0 2 0 0 0 2 1 0 0"/>
  <v:property name="p:limit" functionid="3" channel="inverse" fallbackvalue="7"/></v:volumedata>`;
const solid = (tag = '<mesh v:volumeid="5">') =>
  `<object id="9" type="model">${meshXML(box([0, 0, 0], [1, 1, 1])).replace('<mesh>', tag)}</object>`;
const close = (actual, expected) => {
  assert.equal(actual.length, expected.length);
  actual.forEach((v, i) => assert.ok(Math.abs(v - expected[i]) < 1e-6, `${[...actual]} is not ${expected}`));
};
const srgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

for (const parse of [parse3MFVolumetric, parse3MFEvaluated])
  test(`${parse.name}: volume data is read at points, inside the solid too`, async () => {
    const read = await parse(pack(bases + functions + volume(mapping('x') + mapping('rest')) + solid()), {
        units: 'file',
      }),
      [object] = read.objects,
      // Object coordinates: the item's move by 100 does not apply. The last point lies outside 0..1 in x.
      points = [0.25, 0.5, 0.5, 0.8, 0, 0.1, 3, 4, 0],
      samples = await object.sample(points);
    close(samples.colors, [srgb(0.25), srgb(0.5), srgb(0.5), srgb(0.8), 0, srgb(0.1), 1, 1, 0]);
    assert.equal(samples.composite.baseMaterialId, '2');
    assert.equal(samples.composite.materials, 2);
    // Each contribution is clipped to 0..1 before the division: x = 3 gives 1 and 0.
    close(samples.composite.ratios, [0.25, 0.75, 0.8, 0.2, 1, 0]);
    const [density, flow, limit] = samples.properties;
    assert.deepEqual(
      [density.name, density.namespace, density.required, density.size],
      ['density', 'http://example.com/part-properties', true, 1],
    );
    close(density.values, [0.25, 0.8, 3]);
    assert.equal(flow.size, 3);
    close(flow.values, [1.5, 1, 1, 2.6, 0, 0.2, 7, 8, 0]);
    // 1 / 0 is undefined, so the fallback value stands.
    close(limit.values, [2, 7, 0.25]);
    await assert.rejects(object.sample([0, 0]), TypeError);
    await assert.rejects(object.sample([0, Number.NaN, 0]), TypeError);
  });

test('a point whose contributions are all nothing has no mixture', async () => {
  const read = await parse3MFVolumetric(pack(bases + functions + volume(mapping('x') + mapping('x')) + solid())),
    { composite } = await read.objects[0].sample([0, 1, 1, 0.5, 1, 1]);
  close(composite.ratios, [0, 0, 0.5, 0.5]);
});

test('regression: a composite needs a mapping for each base material', async () => {
  for (const mappings of [mapping('x'), mapping('x') + mapping('rest') + mapping('x')])
    await assert.rejects(parse3MFVolumetric(pack(bases + functions + volume(mappings) + solid())), {
      code: 'syntax',
      message: /one materialmapping for each of 2 base materials/,
    });
});

test('regression: volume data on a displacement mesh is refused, not dropped', async () => {
  const displaced = solid('<d:displacementmesh v:volumeid="5">').replace('</mesh>', '</d:displacementmesh>'),
    input = pack(bases + functions + volume(mapping('x') + mapping('rest')) + displaced);
  for (const parse of [parse3MFVolumetric, parse3MFEvaluated])
    await assert.rejects(parse(input), { code: 'syntax', message: /takes no volume data/ });
});
