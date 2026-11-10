import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { convertFBX } from '../dist/index.js';
import { surfaces } from '../dist/surfaces.js';
import { legacyFBX } from '../dist/legacy.js';
import { largeFBX } from '../dist/large.js';
import { binary, ascii, L, A } from './fixtures.js';
import { readGLB } from './native-scene-helper.js';
import { runParseWorker } from '../../../tests/support/parse-worker.js';
import validator from 'gltf-validator';
export function surfaceTree({ type = 'NurbsSurface', u = 2, v = 2, points, fields = [] } = {}) {
  points ??= Array.from({ length: u * v }, (_, i) => [(i % u) / (u - 1), Math.floor(i / u) / (v - 1), 0, 1]).flat();
  return [
    [
      'Objects',
      [],
      [
        [
          'Geometry',
          [L(1), 'Geometry::Surface', type],
          [
            ['Dimensions', [u, v]],
            ['Points', [A('d', points)]],
            ['NurbsSurfaceOrder', [2, 2]],
            ['KnotVectorU', [A('d', [0, 0, 1, 1])]],
            ['KnotVectorV', [A('d', [0, 0, 1, 1])]],
            ['Step', [2, 2]],
            ...fields,
          ],
        ],
        ['Model', [L(2), 'Model::Surface', type]],
      ],
    ],
    [
      'Connections',
      [],
      [
        ['C', ['OO', L(1), L(2)]],
        ['C', ['OO', L(2), L(0)]],
      ],
    ],
  ];
}
const encoded = (tree, format) =>
  format === 'ascii' ? new TextEncoder().encode(ascii(tree)) : binary(tree, { version: 7500, compress: true });
const convert = async (tree, format = 'binary', extensions = [surfaces]) =>
  readGLB(await convertFBX(encoded(tree, format), { extensions }));
function geometry(result) {
  const p = result.doc.meshes[0].primitives[0];
  return {
    positions: result.accessor(p.attributes.POSITION),
    normals: result.accessor(p.attributes.NORMAL),
    uvs: result.accessor(p.attributes.TEXCOORD_0),
    indices: result.accessor(p.indices),
  };
}

test('rational NURBS keeps FBX u-fastest ordering, positive weights, exact normals and parameter UVs on both front ends', async () => {
  const tree = surfaceTree({ points: [0, 0, 0, 1, 1, 0, 0, 2, 0, 1, 0, 1, 1, 1, 0, 2] });
  for (const format of ['ascii', 'binary']) {
    const g = geometry(await convert(tree, format));
    assert.equal(g.positions.length, 27);
    assert.equal(g.indices.length, 24);
    assert.ok(
      [...Array(9)].some((_, i) => Math.abs(g.positions[i * 3] - 2 / 3) < 1e-7 && g.positions[i * 3 + 1] === 0.5),
    );
    for (let i = 0; i < 9; i++) {
      assert.equal(g.positions[i * 3 + 2], 0);
      assert.equal(g.normals[i * 3 + 2], 1);
      assert.ok(g.uvs[i * 2] >= 0 && g.uvs[i * 2] <= 1);
    }
  }
  await assert.rejects(convertFBX(encoded(tree, 'binary')), /no mesh geometry/);
});

test('all five FBX patch bases and every mixed U/V pair share the NURBS tessellator', async () => {
  const modes = ['Bezier', 'BezierQuadric', 'Cardinal', 'BSpline', 'Linear'];
  const count = (t) => (t === 'Linear' ? 2 : t === 'BezierQuadric' ? 3 : 4);
  for (const a of modes)
    for (const b of modes) {
      const u = count(a),
        v = count(b),
        coord = (i, n, t) => (t === 'Cardinal' || t === 'BSpline' ? i - 1 : i / (n - 1));
      const points = Array.from({ length: u * v }, (_, i) => [
        coord(i % u, u, a),
        coord(Math.floor(i / u), v, b),
        0,
        1,
      ]).flat();
      const g = geometry(await convert(surfaceTree({ type: 'Patch', u, v, points, fields: [['PatchType', [a, b]]] })));
      assert.equal(g.indices.length, 24, `${a}/${b}`);
      const actual = [];
      for (let i = 0; i < g.positions.length; i += 3)
        actual.push(Array.from(g.positions.slice(i, i + 3)).map((x) => +x.toFixed(6)));
      actual.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
      const expected = [];
      for (const x of [0, 0.5, 1]) for (const y of [0, 0.5, 1]) expected.push([x, y, 0]);
      assert.equal(actual.length, expected.length);
      for (let i = 0; i < actual.length; i++)
        for (let k = 0; k < 3; k++)
          assert.ok(actual[i][k] === expected[i][k], `${a}/${b}: ${actual[i]} vs ${expected[i]}`);
    }
});

test('surface FlipNormals reverses both stored normals and triangle winding', async () => {
  const g = geometry(await convert(surfaceTree({ fields: [['FlipNormals', [1]]] })));
  for (let i = 2; i < g.normals.length; i += 3) assert.equal(g.normals[i], -1);
  const [a, b, c] = g.indices,
    at = (i) => g.positions.slice(i * 3, i * 3 + 3),
    p = at(a),
    q = at(b),
    r = at(c);
  assert.ok((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]) < 0);
});

test('closed linear patches and end caps retain a sealed prism and flat cap normals', async () => {
  const points = [];
  for (const [x, y] of [
    [1, 0],
    [0, 1],
    [-1, 0],
    [0, -1],
  ])
    for (const z of [0, 1]) points.push(x, y, z, 1);
  const g = geometry(
    await convert(
      surfaceTree({
        type: 'Patch',
        u: 2,
        v: 4,
        points,
        fields: [
          ['PatchType', ['Linear', 'Linear']],
          ['Closed', [0, 1]],
          ['UCapped', [1, 1]],
        ],
      }),
    ),
  );
  let top = 0,
    bottom = 0;
  for (let i = 0; i < g.positions.length; i += 3) {
    if (g.normals[i + 2] > 0.99) top++;
    if (g.normals[i + 2] < -0.99) bottom++;
  }
  assert.ok(top >= 4 && bottom >= 4);
  let volume = 0;
  for (let i = 0; i < g.indices.length; i += 3) {
    const p = [0, 1, 2].map((k) => g.indices[i + k] * 3),
      a = p[0],
      b = p[1],
      c = p[2],
      v = g.positions;
    volume +=
      (v[a] * (v[b + 1] * v[c + 2] - v[b + 2] * v[c + 1]) +
        v[a + 1] * (v[b + 2] * v[c] - v[b] * v[c + 2]) +
        v[a + 2] * (v[b] * v[c + 1] - v[b + 1] * v[c])) /
      6;
  }
  assert.ok(Math.abs(Math.abs(volume) - 2) < 1e-6);
});

for (const suffix of ['plane_7500_ascii', 'plane_7500_binary', 'plane_6100_ascii', 'sphere_7500_ascii'])
  test(`real Maya NURBS ${suffix} validates, retains material and worker geometry`, async () => {
    const bytes = Uint8Array.from(
      await readFile(new URL(`./fixtures/real/maya_nurbs_surface_${suffix}.fbx`, import.meta.url)),
    );
    const output = await convertFBX(bytes, { extensions: [surfaces, legacyFBX] }),
      report = await validator.validateBytes(new Uint8Array(output));
    assert.equal(report.issues.numErrors, 0, JSON.stringify(report.issues.messages));
    const result = readGLB(output),
      g = geometry(result);
    assert.ok(g.indices.length > 100);
    assert.equal(result.doc.materials[0].name, 'lambert1');
    for (const x of [...g.positions, ...g.normals]) assert.ok(Number.isFinite(x));
    const prepared = await runParseWorker(new URL('../dist/workers/fbx.js', import.meta.url), {
      input: bytes.buffer,
      extensions: ['surfaces', 'legacy'],
    });
    assert.deepEqual(prepared.doc.meshes, result.doc.meshes);
    if (suffix.includes('plane')) assert.equal(g.positions.length / 3, 117);
    else {
      assert.ok(g.positions.length / 3 > 1000);
      assert.ok(Math.min(...g.positions) < -0.009);
    }
  });

test('surface rejects malformed dimensions, weights, steps, basis and configured output caps', async () => {
  for (const tree of [
    surfaceTree({ u: 0 }),
    surfaceTree({ points: [0, 0, 0, 0] }),
    surfaceTree({ type: 'Patch', fields: [['PatchType', ['Unknown', 'Linear']]] }),
  ])
    await assert.rejects(convert(tree), /surface|patch/);
  const tree = surfaceTree();
  tree[0][2][0][2].find((x) => x[0] === 'Step')[1] = [Number.MAX_SAFE_INTEGER, 2];
  await assert.rejects(convert(tree), /budget/);
  await assert.rejects(convert(surfaceTree(), 'binary', [surfaces, largeFBX({ vertices: 4 })]), /budget|limit/);
  const abort = new AbortController();
  abort.abort(new Error('stop surface'));
  await assert.rejects(
    convertFBX(encoded(surfaceTree(), 'binary'), { signal: abort.signal, extensions: [surfaces] }),
    /stop surface/,
  );
});
test('legacy inline Nurb migrates before surfaces even with reversed extension order', async () => {
  const tree = surfaceTree(),
    g = tree[0][2][0];
  g[2].find((x) => x[0] === 'NurbsSurfaceOrder')[0] = 'NurbOrder';
  tree[0][2] = [['Model', ['Model::Inline', 'Nurb'], g[2]]];
  tree[1][2] = [['Connect', ['OO', 'Model::Inline', 'Model::Scene']]];
  const source = new TextEncoder().encode(ascii(tree).replaceAll('7.4.0', '6.1.0').replace('7400', '6100'));
  const result = readGLB(await convertFBX(source, { extensions: [surfaces, legacyFBX] }));
  assert.equal(geometry(result).positions.length, 27);
});

test('the real Maya control net gives byte-identical tessellation when the same data uses either front end', async () => {
  // Separate DCC exports contain different near-zero control coordinates. Encode the same real net in both formats.
  const text = await readFile(
    new URL('./fixtures/real/maya_nurbs_surface_plane_7500_ascii.fbx', import.meta.url),
    'utf8',
  );
  const values = (name) => {
    const match = new RegExp(name + ': \\*\\d+ \\{\\s*a: ([^}]+)\\}').exec(text);
    assert.ok(match, name);
    return match[1].split(',').map(Number);
  };
  const tree = surfaceTree({ u: 5, v: 6, points: values('Points') });
  const fields = tree[0][2][0][2];
  fields.find((x) => x[0] === 'NurbsSurfaceOrder')[1] = [4, 4];
  for (const axis of ['U', 'V'])
    fields.find((x) => x[0] === 'KnotVector' + axis)[1] = [A('d', values('KnotVector' + axis))];
  assert.deepEqual(geometry(await convert(tree, 'ascii')), geometry(await convert(tree, 'binary')));
});
test('a control-net skin is refused before its original indices could deform tessellated vertices incorrectly', async () => {
  const tree = surfaceTree();
  tree[0][2].push(['Deformer', [L(3), 'Skin', 'Skin']]);
  tree[1][2].push(['C', ['OO', L(3), L(1)]]);
  await assert.rejects(convert(tree), (error) => error.code === 'unsupported' && /bake/.test(error.message));
});
