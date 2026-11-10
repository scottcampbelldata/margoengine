import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse3MFLattice } from '@margoengine/loaders/threemf-lattice';
import { parse3MFMaterials } from '@margoengine/loaders/threemf-materials';
import { parse3MF } from '../dist/index.js';
import { writeZip } from '../scripts/make-fixtures.js';
import { MATERIALS, LATTICE, SLICE, model, object, nativeFixtureXML } from './threemf-native-fixture.js';
const pack = (root, extra = {}) =>
  writeZip(
    Object.entries({
      '3D/3dmodel.model': root,
      ...(Object.keys(extra).some((p) => p.endsWith('.model'))
        ? {
            '3D/_rels/3dmodel.model.rels':
              '<Relationships>' +
              Object.keys(extra)
                .filter((p) => p.endsWith('.model'))
                .map(
                  (p, i) =>
                    `<Relationship Id="slice${i}" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" Target="/${p}"/>`,
                )
                .join('') +
              '</Relationships>',
          }
        : {}),
      ...extra,
    }).map(([name, text]) => ({
      name,
      data: new TextEncoder().encode(text),
    })),
  );

test('browser fixture bytes match the independently generated native source fixture', () => {
  assert.deepEqual(
    readFileSync(new URL('./fixtures/lattice-slices.3mf', import.meta.url)),
    Buffer.from(pack(nativeFixtureXML())),
  );
});
test('native lattice retains caps, tapered radii, precise coordinates, active lengths, balls and subsets', async () => {
  const xml = model(MATERIALS + object(LATTICE), '<item objectid="9" transform="2 0 0 0 3 0 0 0 4 5 6 7"/>');
  const result = await parse3MFLattice(pack(xml));
  const o = result.objects[0],
    l = o.lattice;
  assert.equal(o.vertices[0], 1.123456789012345);
  assert.equal(o.vertices.length, 12);
  assert.deepEqual([...l.activeBeams], [0]);
  assert.deepEqual(
    [l.beams[0].r1, l.beams[0].r2, l.beams[0].cap1, l.beams[0].cap2, l.beams[0].p1],
    [2, 3, 'butt', 'hemisphere', 1],
  );
  assert.equal(l.beams[1].r2, 1);
  assert.deepEqual(
    l.effectiveBalls.map((b) => [b.vertex, b.radius]),
    [
      [0, 0.5],
      [1, 0.25],
    ],
  );
  assert.deepEqual([...l.sets[0].beams], [0, 1]);
  assert.deepEqual([...l.sets[0].balls], [0]);
  assert.equal(l.sets[0].identifier, 'set-a');
  assert.equal(result.instances[0].unitScale, 0.001);
  assert.deepEqual([...result.instances[0].transform], [2, 0, 0, 0, 3, 0, 0, 0, 4, 5, 6, 7]);
  assert.equal(result.indices.length, 3);
  assert.equal(result.propertyResources.find((p) => p.id === '2').weights[0][1], 0.75);
  assert.deepEqual([...result.propertyResources.find((p) => p.id === '3').rows[1]], [0, 1]);
  assert.deepEqual(
    [...result.colors.slice(0, 3)].map((v) => +v.toFixed(6)),
    [0.537099, 0, 0.880825],
  );
});
test('triangle-free but valid built beam geometry is accepted only by the native entry', async () => {
  const bytes = pack(model(MATERIALS + object(LATTICE, '', '<triangles/>')));
  const result = await parse3MFLattice(bytes);
  assert.equal(result.indices.length, 0);
  assert.equal(result.positions.length, 0);
  assert.equal(result.objects[0].lattice.activeBeams.length, 1);
  await assert.rejects(parse3MF(bytes), { code: 'syntax' });
  await assert.rejects(parse3MFMaterials(bytes), { code: 'syntax' });
});
test('inline 2D slices do not enter the 3D vertex reader, void layers and property gradients survive', async () => {
  const result = await parse3MFLattice(pack(nativeFixtureXML()));
  const stack = result.sliceStacks[0];
  assert.equal(stack.bottom, 0);
  assert.deepEqual(
    stack.layers.map((l) => l.top),
    [1, 2],
  );
  assert.deepEqual([...stack.layers[0].vertices], [0, 0, 2, 0, 2, 2, 0, 2]);
  assert.equal(stack.layers[1].vertices.length, 0);
  assert.deepEqual(stack.layers[0].polygons[0].segments[0], { vertex: 1, pid: undefined, p1: 0, p2: 1 });
  assert.equal(result.sliceInstances[0].stack, stack);
  assert.equal(result.objects[0].slices.resolution, 'lowres');
});
test('external slices use the shared decoder and parent slice stacks override component stacks', async () => {
  const root = model(
    MATERIALS +
      '<s:slicestack id="10"><s:sliceref slicestackid="12" slicepath="/2D/layers.model"/></s:slicestack><s:slicestack id="11">' +
      SLICE +
      '</s:slicestack>' +
      object('', 's:slicestackid="11"') +
      '<object id="20" s:slicestackid="10"><components><component objectid="9" transform="1 0 0 0 1 0 0 0 1 4 5 6"/></components></object>',
    '<item objectid="20"/>',
  );
  const external = model('<s:slicestack id="12"><s:slice ztop="1"/><s:slice ztop="2"/></s:slicestack>', '');
  const result = await parse3MFLattice(pack(root, { '2D/layers.model': external }));
  assert.equal(result.sliceStacks.length, 3);
  assert.equal(result.sliceInstances.length, 1);
  assert.equal(result.sliceInstances[0].object.id, '20');
  assert.deepEqual(
    result.sliceInstances[0].stack.layers.map((l) => l.top),
    [1, 2],
  );
  assert.equal(result.instances.find((i) => i.object.id === '9').transform[9], 4);
});
test('clipping and representation resources stay exact native references to earlier source meshes', async () => {
  const clip =
    '<object id="5"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/><vertex x="0" y="0" z="1"/></vertices><triangles><triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/><triangle v1="1" v2="2" v3="3"/><triangle v1="2" v2="0" v3="3"/></triangles></mesh></object>';
  const lattice = LATTICE.replace(
    'radius="1"',
    'clippingmode="inside" clippingmesh="5" representationmesh="5" radius="1"',
  );
  const result = await parse3MFLattice(pack(model(MATERIALS + clip + object(lattice))));
  assert.equal(result.objects[1].lattice.clippingMesh, '5');
  assert.equal(result.objects[1].lattice.clippingMode, 'inside');
  assert.equal(result.objects[0].triangles.length, 12);
  await assert.rejects(parse3MFLattice(pack(model(MATERIALS + object(lattice) + clip))), { code: 'range' });
});
test('malformed native topology, material rows and native budgets reject with coded errors', async () => {
  for (const [from, to] of [
    ['v2="1"', 'v2="0"'],
    ['v2="1"', 'v2="99"'],
    ['r1="2" r2="3"', 'r2="3"'],
    ['cap1="butt"', 'cap1="flat"'],
    ['index="0"', 'index="99"'],
  ])
    await assert.rejects(
      parse3MFLattice(pack(model(MATERIALS + object(LATTICE.replace(from, to))))),
      (e) => e.name === 'LoaderError',
    );
  await assert.rejects(parse3MFLattice(pack(model(MATERIALS + object(LATTICE))), { maxBeams: 1 }), { code: 'limit' });
  await assert.rejects(parse3MFLattice(pack(nativeFixtureXML()), { maxSlices: 1 }), { code: 'limit' });
  await assert.rejects(
    parse3MFLattice(pack(model(MATERIALS.replace('pindices="0 0"', 'pindices="99"') + object(LATTICE)))),
    { code: 'range' },
  );
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(parse3MFLattice(new Uint8Array(), { signal: abort.signal }), { code: 'aborted' });
});
test('slice closure, increasing height, object references and planar build transforms are enforced', async () => {
  await assert.rejects(parse3MFLattice(pack(nativeFixtureXML().replace('requiredextensions="s b b2"', ''))), {
    code: 'syntax',
  });
  for (const [from, to] of [
    ['<s:segment v2="0"/>', '<s:segment v2="1"/>'],
    ['ztop="2"', 'ztop="1"'],
    ['s:slicestackid="10"', 's:slicestackid="99"'],
  ])
    await assert.rejects(parse3MFLattice(pack(nativeFixtureXML().replace(from, to))), { code: 'range' });
  const rotated = nativeFixtureXML().replace(
    '<item objectid="9"/>',
    '<item objectid="9" transform="1 0 0 0 0 1 0 -1 0 0 0 0"/>',
  );
  await assert.rejects(parse3MFLattice(pack(rotated)), { code: 'range' });
});
test('resolved reference expansion is bounded separately from source layer counts', async () => {
  const refs = [10, 11, 12]
    .map((id) => `<s:slicestack id="${id}"><s:sliceref slicestackid="30" slicepath="/2D/s.model"/></s:slicestack>`)
    .join('');
  const external = model(
    '<s:slicestack id="30"><s:slice ztop="1"/><s:slice ztop="2"/><s:slice ztop="3"/></s:slicestack>',
    '',
  );
  await assert.rejects(
    parse3MFLattice(pack(model(MATERIALS + refs + object()), { '2D/s.model': external }), { maxSlices: 6 }),
    { code: 'limit' },
  );
});

test('composite zero/short/extra rows and multi short/extra indices follow normative defaults', async () => {
  for (const [values, weights] of [
    ['0 0', [0.5, 0.5]],
    ['1', [1, 0]],
    ['0.25 0.75 99', [0.25, 0.75]],
  ]) {
    const resources = MATERIALS.replace('values="0.25 0.75"', `values="${values}"`)
      .replace('pindices="0 0"', 'pindices="0"')
      .replace('pindices="0 1"', 'pindices="0 1 999"');
    const result = await parse3MFLattice(pack(model(resources + object(LATTICE))));
    assert.deepEqual([...result.propertyResources.find((p) => p.id === '2').weights[0]], weights);
    assert.deepEqual(
      result.propertyResources.find((p) => p.id === '3').rows.map((r) => [...r]),
      [
        [0, 0],
        [0, 1],
      ],
    );
    if (values === '0 0') assert.deepEqual(result.groups.length, 1);
  }
});

test('multiply layers blend in linear RGB and preserve endpoint opacity', async () => {
  const resources = MATERIALS.replace('#00FF0000', '#80808080')
    .replace('#FFFFFF00', '#80808080')
    .replace('pids="2 4"', 'pids="2 4" blendmethods="multiply"');
  const result = await parse3MFLattice(pack(model(resources + object(LATTICE))));
  const a = 128 / 255,
    l = ((a + 0.055) / 1.055) ** 2.4,
    s = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
  [s(0.25 * l), 0, s(0.75 * l)].forEach((v, i) => assert.ok(Math.abs(result.colors[i] - v) < 1e-6));
  assert.ok(result.attributes.opacity.every((v) => Math.abs(v - a) < 1e-7));
  assert.deepEqual(result.propertyResources.find((p) => p.id === '3').blendMethods, ['multiply']);
});
