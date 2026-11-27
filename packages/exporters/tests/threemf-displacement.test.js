// export3MF's displacement meshes, by the 3MF Displacement Extension specification
// (https://github.com/3MFConsortium/spec_displacement), read back through `parse3MFDisplacement`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync, crc32 } from 'node:zlib';
import { parse3MF, readZipDirectory, readZipEntry } from '@margoengine/loaders';
import { parse3MFDisplacement } from '@margoengine/loaders/threemf-displacement';
import { export3MF } from '@margoengine/exporters/threemf';
import { encodeZIP } from '../dist/archive.js';

const corners = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1];
const faces = [
  0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5,
];
const box = {
  positions: new Float32Array(corners),
  // Out from the centre, so each corner's normal is a diagonal.
  normals: new Float32Array(corners.map((v) => (v * 2 - 1) / Math.sqrt(3))),
  uvs: new Float32Array(Array.from({ length: 8 }, (_, i) => [i / 8, 0.25]).flat()),
  indices: new Uint32Array(faces),
};
const chunk = (type, data) => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length);
  out.write(type, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
};
const head = Buffer.alloc(13);
head.writeUInt32BE(1);
head.writeUInt32BE(1, 4);
head[8] = 8;
const image = new Uint8Array(
  Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', head),
    chunk('IDAT', deflateSync(Buffer.from([0, 128]))),
    chunk('IEND', Buffer.alloc(0)),
  ]),
);
const attributes = (tag) => Object.fromEntries([...tag.matchAll(/([\w:]+)="([^"]*)"/g)].map(([, k, v]) => [k, v]));
const elements = (text, name) =>
  [...text.matchAll(new RegExp(`<${name}((?: [^>]*?)?)/?>`, 'g'))].map((m) => attributes(m[1]));
const parts = async (file) => {
  const out = {};
  for (const entry of readZipDirectory(file))
    out[entry.name] = new TextDecoder().decode(await readZipEntry(file, entry));
  return out;
};
const ROOT = '3D/3dmodel.model';
const written = async (displacement, options = {}, node = {}) => {
  const file = await export3MF(
      { nodes: [{ name: 'block', geometry: box, ...node }] },
      { unit: 'millimeter', upAxis: 'y', objectInfo: () => ({ displacement }), ...options },
    ),
    all = await parts(file);
  return { file, all, text: all[ROOT] };
};
/** Every displaced corner's vector has unit length and leaves its triangle on the outer side. */
const outward = (read) => {
  const [mesh] = read.meshes;
  for (let t = 0; t < mesh.indices.length / 3; t++) {
    const [a, b, c] = [0, 1, 2].map((k) => {
        const v = mesh.indices[t * 3 + k];
        return [...mesh.positions.subarray(v * 3, v * 3 + 3)];
      }),
      e = b.map((v, i) => v - a[i]),
      f = c.map((v, i) => v - a[i]),
      n = [e[1] * f[2] - e[2] * f[1], e[2] * f[0] - e[0] * f[2], e[0] * f[1] - e[1] * f[0]],
      group = read.displacementGroups[mesh.triangleGroups[t]];
    for (let k = 0; k < 3; k++) {
      const at = mesh.triangleCoordinates[t * 3 + k],
        v = [...group.vectors.subarray(at * 3, at * 3 + 3)];
      assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-5);
      assert.ok(v[0] * n[0] + v[1] * n[1] + v[2] * n[2] > 0, `triangle ${t}`);
    }
  }
};

test('a displaced node is a displacement mesh over a map, vectors and coordinates, which read back', async () => {
  const { file, all, text } = await written({ image, height: 0.002, offset: -0.001 }),
    [model] = elements(text, 'model'),
    [map] = elements(text, 'd:displacement2d'),
    [vectors] = elements(text, 'd:normvectorgroup'),
    [group] = elements(text, 'd:disp2dgroup'),
    [triangles] = elements(text, 'd:triangles'),
    coordinates = elements(text, 'd:disp2dcoord');
  assert.equal(model['xmlns:d'], 'http://schemas.3mf.io/3dmanufacturing/displacement/2023/10');
  // The extension adds a kind of object, so a reader must support it (chapter 1).
  assert.equal(model.requiredextensions, 'd');
  assert.deepEqual(map, {
    id: map.id,
    path: '/3D/Textures/displacement1.png',
    channel: 'G',
    tilestyleu: 'wrap',
    tilestylev: 'wrap',
    filter: 'auto',
  });
  assert.deepEqual(group, { id: group.id, dispid: map.id, nid: vectors.id, height: '2', offset: '-1' });
  assert.equal(triangles.did, group.id);
  assert.equal(elements(text, 'd:triangle').length, 12);
  assert.equal(elements(text, 'd:vertex').length, 8);
  assert.ok(!text.includes('<mesh>'));
  // v points up from the picture's lower left corner.
  assert.ok(coordinates.every((c) => c.v === '0.75' && c.f === undefined));
  assert.equal(coordinates.filter((c) => c.u === '0.125').length >= 1, true);
  assert.ok(all['3D/_rels/3dmodel.model.rels'].includes('Target="/3D/Textures/displacement1.png"'));
  assert.ok(text.indexOf('<d:displacement2d') < text.indexOf('<d:disp2dgroup'));
  assert.ok(text.indexOf('<d:disp2dgroup') < text.indexOf('<object'));

  const read = await parse3MFDisplacement(file, { units: 'file' });
  assert.deepEqual([...read.maps[0].data], [...image]);
  assert.equal(read.maps[0].channel, 'G');
  assert.deepEqual([read.displacementGroups[0].height, read.displacementGroups[0].offset], [2, -1]);
  assert.equal(read.meshes[0].instances.length, 1);
  assert.ok(read.meshes[0].triangleGroups.every((g) => g === 0));
  outward(read);
  const plain = await parse3MF(file);
  assert.equal(plain.indices.length, 36);
  assert.ok(plain.groups.every((g) => g.displaced));
});

test("'normals' uses the geometry's own, and factors scale the height", async () => {
  const { file } = await written({ image, height: 0.002, vectors: 'normals', factor: ([x]) => (x > 0.5 ? 0.5 : 1) }),
    read = await parse3MFDisplacement(file, { units: 'file' }),
    [group] = read.displacementGroups,
    [mesh] = read.meshes,
    third = Math.fround(1 / Math.sqrt(3));
  for (let t = 0; t < 36; t++) {
    const v = mesh.indices[t],
      at = mesh.triangleCoordinates[t],
      p = [...mesh.positions.subarray(v * 3, v * 3 + 3)],
      // The object keeps the geometry's own frame; its build item turns it to stand on the bed.
      expected = p.map((value) => (value ? third : -third));
    group.vectors.subarray(at * 3, at * 3 + 3).forEach((value, k) => assert.ok(Math.abs(value - expected[k]) < 1e-5));
    assert.equal(group.coordinates[at * 3 + 2], p[0] ? 0.5 : 1);
  }
});

test('a mirrored node keeps its vectors outward', async () => {
  const { file } = await written(
    { image, height: 0.002, tile: ['clamp', 'none'], channel: 'R', filter: 'nearest' },
    { assembly: false },
    { matrix: [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
  );
  const read = await parse3MFDisplacement(file, { units: 'file' });
  assert.deepEqual(
    [read.maps[0].tileU, read.maps[0].tileV, read.maps[0].channel, read.maps[0].filter],
    ['clamp', 'none', 'R', 'nearest'],
  );
  outward(read);
});

test('displacement the specification rules out is refused', async () => {
  const good = { image, height: 0.001 };
  const bad = [
    [{ ...good, image: new Uint8Array(8) }, {}, /PNG bytes/],
    [{ ...good, height: NaN }, {}, /height/],
    [{ ...good, channel: 'Y' }, {}, /channel/],
    [{ ...good, texCoord: 1 }, {}, /UV set 1/],
    [{ ...good, factor: () => -1 }, {}, /0 or more/],
    [good, { geometry: { ...box, indices: new Uint32Array(faces.slice(0, 9)) } }, /four triangles/],
  ];
  for (const [given, node, message] of bad) await assert.rejects(written(given, {}, node), { message });
  await assert.rejects(written(good, { objectInfo: () => ({ displacement: good, type: 'support' }) }), {
    message: /model object/,
  });
});

/** The specification's example file (appendix D), its group's `depth` written as the `height` its schema names. */
const example = `<?xml version="1.0" encoding="UTF-8"?>
<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"
  xmlns:d="http://schemas.3mf.io/3dmanufacturing/displacement/2023/10"
  unit="millimeter" xml:lang="en-US">
  <resources>
    <d:displacement2d id="10" path="/3D/Textures/label_mono.png"/>
    <d:normvectorgroup id="24">
      <d:normvector x="-0.704662" y="-0.704662" z="-0.0830916"/>
      <d:normvector x="0.704672" y="-0.704644" z="-0.0831468"/>
      <d:normvector x="2.02911e-5" y="2.00578e-5" z="1"/>
      <d:normvector x="-0.704644" y="0.704673" z="-0.0831459"/>
      <d:normvector x="0.704655" y="0.704655" z="-0.083201"/>
    </d:normvectorgroup>
    <d:disp2dgroup id="18" dispid="10" nid="24" height="1.5">
      <d:disp2dcoord u="0" v="0" n="0"/>
      <d:disp2dcoord u="1" v="0" n="1"/>
      <d:disp2dcoord u="0.50005" v="1" n="2"/>
      <d:disp2dcoord u="1" v="1" n="3"/>
      <d:disp2dcoord u="0" v="5.96046e-008" n="1"/>
      <d:disp2dcoord u="1" v="5.96046e-008" n="0"/>
      <d:disp2dcoord u="-5.96046e-008" v="0" n="1"/>
      <d:disp2dcoord u="0" v="1" n="4"/>
      <d:disp2dcoord u="1" v="0" n="4"/>
    </d:disp2dgroup>
    <object id="9" name="Scene - DispMaps_13" type="model">
      <d:displacementmesh>
        <d:vertices>
          <d:vertex x="152.345" y="84.2476" z="16.92"/>
          <d:vertex x="192.345" y="84.2476" z="16.92"/>
          <d:vertex x="172.347" y="104.25" z="56.918"/>
          <d:vertex x="152.345" y="124.248" z="16.92"/>
          <d:vertex x="192.345" y="124.248" z="16.92"/>
        </d:vertices>
        <d:triangles did="18">
          <d:triangle v1="0" v2="1" v3="2" d1="0" d2="1" d3="2"/>
          <d:triangle v1="3" v2="1" v3="0" d1="3" d2="4" d3="5"/>
          <d:triangle v1="0" v2="2" v3="3"/>
          <d:triangle v1="1" v2="4" v3="2" d1="6" d2="8" d3="2"/>
          <d:triangle v1="4" v2="3" v3="2"/>
          <d:triangle v1="4" v2="1" v3="3" d1="7"/>
        </d:triangles>
      </d:displacementmesh>
    </object>
  </resources>
  <build>
    <item objectid="9"/>
  </build>
</model>`;
const packaged = (text) =>
  encodeZIP([
    { name: ROOT, data: new TextEncoder().encode(text) },
    { name: '3D/Textures/label_mono.png', data: image },
  ]);

test("the specification's example reads, its unnamed corners taking d1, and broken references are refused", async () => {
  const read = await parse3MFDisplacement(await packaged(example)),
    [mesh] = read.meshes,
    [group] = read.displacementGroups;
  assert.deepEqual([...mesh.triangleGroups], [0, 0, -1, 0, -1, 0]);
  assert.deepEqual([...mesh.triangleCoordinates], [0, 1, 2, 3, 4, 5, -1, -1, -1, 6, 8, 2, -1, -1, -1, 7, 7, 7]);
  assert.equal(group.coordinates.length, 27);
  assert.equal(group.height, 1.5);
  assert.equal(group.offset, 0);
  assert.equal(read.maps[0].path, '/3D/Textures/label_mono.png');
  // Four of the six triangles are displaced and subdivided; `tessellate: false` keeps the base triangles.
  assert.ok(read.indices.length > 18);
  assert.equal((await parse3MFDisplacement(await packaged(example), { tessellate: false })).indices.length, 18);
  const broken = [
    [example.replace('dispid="10"', 'dispid="11"'), /not defined before/],
    [example.replace('n="4"', 'n="5"'), /vector index/],
    [example.replace('d1="7"', 'd1="9"'), /d1 9 is outside/],
    [example.replace('<d:triangles did="18">', '<d:triangles>'), /names no disp2dgroup/],
    [example.replace('label_mono.png', 'other.png'), /missing/],
  ];
  for (const [text, message] of broken) await assert.rejects(parse3MFDisplacement(await packaged(text)), { message });
});
