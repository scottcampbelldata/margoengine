import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { convertFBX } from '../dist/index.js';
import { surfaces } from '../dist/surfaces.js';
import { legacyFBX } from '../dist/legacy.js';
import { largeFBX } from '../dist/large.js';
import { binary, ascii, L, I, A } from './fixtures.js';
import { evaluateNurbsSurface } from '../../loaders/dist/nurbs.js';
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
// A rational biquadratic net with a heavier middle point, and its basis written out from Bernstein polynomials so the
// expected numbers do not come from the evaluator under test (The NURBS Book, eq. 4.2).
const quadNet = Array.from({ length: 9 }, (_, i) => [(i % 3) / 2, Math.floor(i / 3) / 2, 0, i === 4 ? 2 : 1]).flat();
function quadratic(points = quadNet) {
  const tree = surfaceTree({ u: 3, v: 3, points });
  const fields = tree[0][2][0][2];
  fields.find((x) => x[0] === 'NurbsSurfaceOrder')[1] = [3, 3];
  for (const axis of ['U', 'V']) fields.find((x) => x[0] === 'KnotVector' + axis)[1] = [A('d', [0, 0, 0, 1, 1, 1])];
  fields.find((x) => x[0] === 'Step')[1] = [4, 4];
  return tree;
}
const bern = (i, t) => [(1 - t) ** 2, 2 * t * (1 - t), t * t][i];
function share(cp, u, v, points = quadNet) {
  let sum = 0;
  for (let k = 0; k < 9; k++) sum += points[k * 4 + 3] * bern(k % 3, u) * bern(Math.floor(k / 3), v);
  return (points[cp * 4 + 3] * bern(cp % 3, u) * bern(Math.floor(cp / 3), v)) / sum;
}
// Each output vertex's (u, v): its UV, with the V flip the writer may apply chosen by the position it gives.
function parameters(g, points = quadNet) {
  return Array.from({ length: g.positions.length / 3 }, (_, i) => {
    const u = g.uvs[i * 2];
    for (const v of [g.uvs[i * 2 + 1], 1 - g.uvs[i * 2 + 1]]) {
      let x = 0,
        y = 0;
      for (let cp = 0; cp < 9; cp++) {
        x += share(cp, u, v, points) * points[cp * 4];
        y += share(cp, u, v, points) * points[cp * 4 + 1];
      }
      if (Math.abs(x - g.positions[i * 3]) < 1e-6 && Math.abs(y - g.positions[i * 3 + 1]) < 1e-6) return [u, v];
    }
    assert.fail(`vertex ${i} is not on the surface`);
  });
}
const loadersSurface = (points) => ({
  degreeU: 2,
  degreeV: 2,
  countU: 3,
  countV: 3,
  knotsU: [0, 0, 0, 1, 1, 1],
  knotsV: [0, 0, 0, 1, 1, 1],
  points: Array.from({ length: 27 }, (_, k) => points[(((k / 3) % 3) | 0) * 12 + Math.floor(k / 9) * 4 + (k % 3)]),
  weights: Array.from({ length: 9 }, (_, k) => points[(k % 3) * 12 + Math.floor(k / 3) * 4 + 3]),
});
test('KB5330b: a blend shape on a NURBS control net morphs every tessellated vertex exactly, at every weight', async () => {
  const tree = quadratic(),
    shape = [0, 0, 1, 0, 0, 0.5];
  tree[0][2].push(
    ['Deformer', [L(3), 'Deformer::Blend', 'BlendShape'], [['Version', [I(100)]]]],
    [
      'Deformer',
      [L(4), 'SubDeformer::Lift', 'BlendShapeChannel'],
      [
        ['Version', [I(100)]],
        ['DeformPercent', [25]],
        ['FullWeights', [A('d', [100])]],
      ],
    ],
    [
      'Geometry',
      [L(5), 'Geometry::Lift', 'Shape'],
      [
        ['Version', [I(100)]],
        ['Indexes', [A('i', [4, 1])]],
        ['Vertices', [A('d', shape)]],
      ],
    ],
  );
  tree[1][2].push(['C', ['OO', L(3), L(1)]], ['C', ['OO', L(4), L(3)]], ['C', ['OO', L(5), L(4)]]);
  const lifted = quadNet.slice();
  for (let k = 0; k < 3; k++) {
    lifted[4 * 4 + k] += shape[k];
    lifted[1 * 4 + k] += shape[3 + k];
  }
  const target = loadersSurface(lifted);
  for (const format of ['ascii', 'binary']) {
    const result = await convert(tree, format),
      p = result.doc.meshes[0].primitives[0],
      g = geometry(result),
      delta = result.accessor(p.targets[0].POSITION),
      normal = result.accessor(p.targets[0].NORMAL);
    assert.equal((result.doc.nodes.find((n) => n.mesh === 0).weights ?? result.doc.meshes[0].weights)[0], 0.25);
    assert.equal(g.positions.length, 75);
    parameters(g).forEach(([u, v], i) => {
      // Linear in the control points: the delta of each vertex is its basis share of each moved point.
      const expected = [0, 0, shape[2] * share(4, u, v) + shape[5] * share(1, u, v)];
      for (let k = 0; k < 3; k++) assert.ok(Math.abs(delta[i * 3 + k] - expected[k]) < 1e-7, `${format} delta ${i}`);
      const n = evaluateNurbsSurface(target, u, v).normal;
      for (let k = 0; k < 3; k++)
        assert.ok(Math.abs(normal[i * 3 + k] - (n[k] - g.normals[i * 3 + k])) < 2e-7, `${format} normal ${i}`);
    });
  }
});
const jointsOf = (result) => {
  const p = result.doc.meshes[0].primitives[0];
  return { joints: result.accessor(p.attributes.JOINTS_0), weights: result.accessor(p.attributes.WEIGHTS_0) };
};
function skinned(tree, sets) {
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  tree[0][2].push(
    ['Model', [L(10), 'Model::Root', 'LimbNode'], []],
    ['Model', [L(11), 'Model::Tip', 'LimbNode'], []],
    ['Deformer', [L(20), 'Deformer::Skin', 'Skin'], [['Version', [I(101)]]]],
    ...sets.map(([indexes, weights], c) => [
      'Deformer',
      [L(21 + c), 'SubDeformer::Bone' + c, 'Cluster'],
      [
        ['Version', [I(100)]],
        ['Indexes', [A('i', indexes)]],
        ['Weights', [A('d', weights)]],
        ['Transform', [A('d', identity)]],
        ['TransformLink', [A('d', identity)]],
      ],
    ]),
  );
  tree[1][2].push(
    ['C', ['OO', L(10), L(0)]],
    ['C', ['OO', L(11), L(10)]],
    ['C', ['OO', L(20), L(1)]],
    ...sets.flatMap((_, c) => [
      ['C', ['OO', L(21 + c), L(20)]],
      ['C', ['OO', L(10 + c), L(21 + c)]],
    ]),
  );
  return tree;
}
test('KB5330b: a skin whose control points give each vertex one weight set skins the tessellated surface exactly', async () => {
  // Step 1 on a linear net puts every vertex on a knot, where it reaches one column: two weight sets, both exact.
  const tree = surfaceTree({ u: 4, v: 2 }),
    fields = tree[0][2][0][2];
  fields.find((x) => x[0] === 'KnotVectorU')[1] = [A('d', [0, 0, 1, 2, 3, 3])];
  fields.find((x) => x[0] === 'Step')[1] = [1, 1];
  skinned(tree, [
    [
      [0, 1, 4, 5, 2, 3, 6, 7],
      [0.25, 0.25, 0.25, 0.25, 1, 1, 1, 1],
    ],
    [
      [0, 1, 4, 5],
      [0.75, 0.75, 0.75, 0.75],
    ],
  ]);
  for (const format of ['ascii', 'binary']) {
    const result = await convert(tree, format),
      g = geometry(result),
      { joints, weights } = jointsOf(result);
    assert.equal(g.positions.length, 24);
    for (let i = 0; i < 8; i++) {
      const column = Math.round(g.positions[i * 3] * 3),
        expected = column < 2 ? { 0: 0.25, 1: 0.75 } : { 0: 1 },
        got = {};
      for (let k = 0; k < 4; k++) if (weights[i * 4 + k] > 0) got[joints[i * 4 + k]] = weights[i * 4 + k];
      assert.deepEqual(got, expected, `${format} vertex ${i}`);
    }
  }
  // One fractional set on every point of a curved rational net is exact at every vertex, between knots too.
  const uniform = skinned(quadratic(), [
    [Array.from({ length: 9 }, (_, i) => i), new Array(9).fill(0.4)],
    [Array.from({ length: 9 }, (_, i) => i), new Array(9).fill(0.6)],
  ]);
  const { joints, weights } = jointsOf(await convert(uniform));
  for (let i = 0; i < joints.length / 4; i++) {
    const got = {};
    for (let k = 0; k < 4; k++) if (weights[i * 4 + k] > 0) got[joints[i * 4 + k]] = weights[i * 4 + k];
    assert.deepEqual(got, { 0: Math.fround(0.4), 1: Math.fround(0.6) });
  }
});
// Column-major 4x4 helpers for posing the joints a test reads back from the GLB.
const mul4 = (a, b) =>
  Array.from({ length: 16 }, (_, i) => {
    const c = Math.floor(i / 4),
      r = i % 4;
    let sum = 0;
    for (let k = 0; k < 4; k++) sum += a[k * 4 + r] * b[c * 4 + k];
    return sum;
  });
const apply4 = (m, p) => [0, 1, 2].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]);
// A rotation by `angle` about the unit `axis` times `scale` (column-major 3x3), by Rodrigues' formula.
function r9([x, y, z], angle, scale) {
  const c = Math.cos(angle),
    s = Math.sin(angle),
    k = 1 - c;
  return [
    c + x * x * k,
    y * x * k + z * s,
    z * x * k - y * s,
    x * y * k - z * s,
    c + y * y * k,
    z * y * k + x * s,
    x * z * k + y * s,
    y * z * k - x * s,
    c + z * z * k,
  ].map((v) => v * scale);
}
// A joint world matrix: that rotation and scale, then a move by `t`.
const worldOf = (axis, angle, scale, t) => {
  const m = r9(axis, angle, scale);
  return [...m.slice(0, 3), 0, ...m.slice(3, 6), 0, ...m.slice(6), 0, ...t, 1];
};
// glTF's skinning sum (glTF 2.0 section 3.7.3.3) for every vertex, with each source joint at `worlds[name]` and every
// other joint (the helpers) at its parent's world, which needs it to carry the identity transform.
function skinGLB({ doc, accessor }, worlds) {
  const skin = doc.skins[0],
    ibm = accessor(skin.inverseBindMatrices),
    parent = new Map();
  doc.nodes.forEach((node, i) => (node.children ?? []).forEach((child) => parent.set(child, i)));
  const world = (n) => {
    const node = doc.nodes[n];
    if (worlds[node.name]) return worlds[node.name];
    const rest = { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
    assert.equal(node.matrix, undefined, node.name);
    for (const key of Object.keys(rest)) assert.deepEqual(node[key] ?? rest[key], rest[key], node.name);
    return world(parent.get(n));
  };
  const palette = skin.joints.map((n, k) => mul4(world(n), Array.from(ibm.subarray(k * 16, k * 16 + 16)))),
    p = doc.meshes[0].primitives[0],
    positions = accessor(p.attributes.POSITION),
    sets = [0, 1]
      .filter((set) => p.attributes['JOINTS_' + set] !== undefined)
      .map((set) => [accessor(p.attributes['JOINTS_' + set]), accessor(p.attributes['WEIGHTS_' + set])]);
  return Array.from({ length: positions.length / 3 }, (_, v) => {
    const out = [0, 0, 0],
      at = [positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]];
    for (const [joints, weights] of sets)
      for (let k = 0; k < 4; k++) {
        const w = weights[v * 4 + k];
        if (!w) continue;
        apply4(palette[joints[v * 4 + k]], at).forEach((value, r) => (out[r] += w * value));
      }
    return out;
  });
}
// The control net skinned point by point (normalized weights, as FBX Normalize clusters), then the surface through it.
function exactSkin(sets, worlds, names, u, v, place = (p) => p) {
  const out = [0, 0, 0];
  for (let cp = 0; cp < 9; cp++) {
    const row = sets.map(([indexes, weights]) => {
        const i = indexes.indexOf(cp);
        return i < 0 ? 0 : weights[i];
      }),
      total = row.reduce((a, b) => a + b, 0),
      point = place(quadNet.slice(cp * 4, cp * 4 + 3)),
      basis = share(cp, u, v);
    row.forEach((w, j) => {
      if (w) apply4(worlds[names[j]], point).forEach((value, r) => (out[r] += basis * (w / total) * value));
    });
  }
  return out;
}
const twoJointBlend = [
  [
    [0, 1, 2, 3, 4, 5, 6, 7, 8],
    [1, 1, 1, 1, 1, 1, 0.5, 0.5, 0.5],
  ],
  [
    [6, 7, 8],
    [0.5, 0.5, 0.5],
  ],
];
const blendPose = {
  Root: worldOf([0, 0, 1], 0.7, 1.3, [0.3, -0.2, 0.1]),
  Tip: worldOf([1, 0, 0], -0.9, 0.8, [-0.4, 0.5, 0.25]),
};
test('KB5330c: control-net skin weights that blend within one vertex skin the surface exactly through helper joints', async () => {
  for (const format of ['ascii', 'binary']) {
    const tree = skinned(quadratic(), twoJointBlend),
      buffer = await convertFBX(encoded(tree, format), { extensions: [surfaces] }),
      report = await validator.validateBytes(new Uint8Array(buffer));
    assert.equal(report.issues.numErrors, 0, JSON.stringify(report.issues.messages));
    const result = readGLB(buffer),
      p = result.doc.meshes[0].primitives[0],
      g = geometry(result);
    // Two joints whose weights change across the net: four helpers each, eight influences, the second four in JOINTS_1.
    assert.ok(p.attributes.JOINTS_1 !== undefined && p.attributes.WEIGHTS_1 !== undefined);
    assert.equal(result.doc.skins[0].joints.length, 10);
    const names = result.doc.skins[0].joints.map((n) => result.doc.nodes[n].name).sort();
    assert.deepEqual(names, [
      'Root',
      'Root blend 0',
      'Root blend 1',
      'Root blend 2',
      'Root blend 3',
      'Tip',
      'Tip blend 0',
      'Tip blend 1',
      'Tip blend 2',
      'Tip blend 3',
    ]);
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      atBind = skinGLB(result, { Root: identity, Tip: identity }),
      moved = skinGLB(result, blendPose);
    parameters(g).forEach(([u, v], i) => {
      for (let r = 0; r < 3; r++)
        assert.ok(Math.abs(atBind[i][r] - g.positions[i * 3 + r]) < 2e-6, `${format} bind ${i} ${atBind[i]}`);
      const exact = exactSkin(twoJointBlend, blendPose, ['Root', 'Tip'], u, v);
      for (let r = 0; r < 3; r++)
        assert.ok(Math.abs(moved[i][r] - exact[r]) < 4e-6, `${format} vertex ${i}: ${moved[i]} != ${exact}`);
    });
    // The blend reaches the interior, so a polygon mesh skin (one weight set a vertex) could not match it.
    let off = 0;
    parameters(g).forEach(([u, v], i) => {
      const single = [0, 0, 0],
        s = [share(6, u, v) + share(7, u, v) + share(8, u, v)];
      ['Root', 'Tip'].forEach((name, j) => {
        const w = j === 0 ? 1 - s[0] / 2 : s[0] / 2;
        apply4(blendPose[name], [g.positions[i * 3], g.positions[i * 3 + 1], g.positions[i * 3 + 2]]).forEach(
          (value, r) => (single[r] += w * value),
        );
      });
      const exact = exactSkin(twoJointBlend, blendPose, ['Root', 'Tip'], u, v);
      off = Math.max(off, Math.hypot(single[0] - exact[0], single[1] - exact[1], single[2] - exact[2]));
    });
    assert.ok(off > 1e-3, `the exact blend differs from one weight set a vertex by ${off}`);
  }
});
test('KB5330c: helper joint offsets follow the geometric transform the vertices are baked with', async () => {
  const tree = skinned(quadratic(), twoJointBlend),
    gp = (name, ...values) => ['P', [name, 'Vector3D', '', 'A', ...values]];
  tree[0][2][1][2] = [['Properties70', [], [gp('GeometricScaling', 2, 1, 0.5), gp('GeometricRotation', 0, 0, 30)]]];
  const result = await convert(tree),
    g = geometry(result),
    c = Math.cos(Math.PI / 6),
    s = Math.sin(Math.PI / 6),
    place = ([x, y, z]) => [2 * x * c - y * s, 2 * x * s + y * c, 0.5 * z],
    moved = skinGLB(result, blendPose);
  for (let i = 0; i < g.positions.length / 3; i++) {
    const u = g.uvs[i * 2],
      v = [g.uvs[i * 2 + 1], 1 - g.uvs[i * 2 + 1]].find((t) => {
        let x = 0,
          y = 0;
        for (let cp = 0; cp < 9; cp++) {
          const [px, py] = place(quadNet.slice(cp * 4, cp * 4 + 3));
          x += share(cp, u, t) * px;
          y += share(cp, u, t) * py;
        }
        return Math.abs(x - g.positions[i * 3]) < 1e-5 && Math.abs(y - g.positions[i * 3 + 1]) < 1e-5;
      });
    assert.notEqual(v, undefined, `vertex ${i} is on the transformed surface`);
    const exact = exactSkin(twoJointBlend, blendPose, ['Root', 'Tip'], u, v, place);
    for (let r = 0; r < 3; r++)
      assert.ok(Math.abs(moved[i][r] - exact[r]) < 6e-6, `vertex ${i}: ${moved[i]} != ${exact}`);
  }
});
test('KB5330c: control-net blends that need more than eight influences, or a negative share, are refused', async () => {
  // Three joints whose weights all change across one vertex need twelve influences.
  const three = skinned(quadratic(), [
    [
      [0, 1, 2, 3, 4, 5, 6, 7, 8],
      [1, 1, 1, 1, 1, 1, 0.5, 0.5, 0.5],
    ],
    [
      [6, 7],
      [0.5, 0.5],
    ],
    [[8], [0.5]],
  ]);
  three[0][2].push(['Model', [L(12), 'Model::Third', 'LimbNode'], []]);
  three[1][2].push(['C', ['OO', L(12), L(11)]]);
  await assert.rejects(
    convert(three),
    (error) => error.code === 'unsupported' && /past eight influences/.test(error.message),
  );
  // A Cardinal patch mixes neighbours with negative coefficients, so a joint's share of a vertex can go below zero,
  // which no glTF weight can hold.
  const cardinal = skinned(
    surfaceTree({ type: 'Patch', u: 4, v: 2, fields: [['PatchType', ['Cardinal', 'Linear']]] }),
    [
      [
        [0, 1, 2, 3, 4, 5, 6, 7],
        [1, 1, 1, 0, 1, 1, 1, 0],
      ],
      [
        [3, 7],
        [1, 1],
      ],
    ],
  );
  await assert.rejects(
    convert(cardinal),
    (error) => error.code === 'unsupported' && /negative share/.test(error.message),
  );
});
