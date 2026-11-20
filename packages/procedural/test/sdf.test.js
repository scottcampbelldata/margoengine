import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createSdfModeler } from '../dist/sdf.js';

function topology(mesh) {
  const { positions: p, indices } = mesh;
  assert.equal(p.length % 3, 0);
  assert.equal(indices.length % 3, 0);
  assert.ok(p.every(Number.isFinite));
  const edges = new Map();
  let volume = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const ids = [...indices.slice(i, i + 3)];
    assert.ok(ids.every((v) => v < p.length / 3));
    const [a, b, c] = ids.map((v) => p.slice(v * 3, v * 3 + 3).map((x, k) => x - p[k]));
    const u = b.map((v, k) => v - a[k]),
      v = c.map((v, k) => v - a[k]);
    const cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    assert.ok(Math.hypot(...cross) > 1e-14, 'nonzero triangle area');
    volume +=
      (a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0])) /
      6;
    for (let k = 0; k < 3; k++) {
      const x = ids[k],
        y = ids[(k + 1) % 3],
        key = `${Math.min(x, y)},${Math.max(x, y)}`;
      const e = edges.get(key) ?? [0, 0];
      e[0]++;
      e[1] += x < y ? 1 : -1;
      edges.set(key, e);
    }
  }
  for (const [count, direction] of edges.values()) {
    assert.equal(count, 2);
    assert.equal(direction, 0);
  }
  assert.equal(mesh.cellEdgeUses, mesh.edgeSolves * 4);
  assert.ok(volume > 0);
  return volume;
}

test('real Khronos Box reference: all eight corners, planar surface, closed outward mesh and volume', async () => {
  const bytes = readFileSync(new URL('./fixtures/sdf/Box.glb', import.meta.url));
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    'ed52f7192b8311d700ac0ce80644e3852cd01537e4d62241b9acba023da3d54e',
  );
  const jsonLength = bytes.readUInt32LE(12),
    json = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString());
  const accessor = json.accessors[json.meshes[0].primitives[0].attributes.POSITION];
  const view = json.bufferViews[accessor.bufferView],
    binStart = 20 + jsonLength + 8;
  assert.equal(accessor.componentType, 5126);
  const reference = [];
  for (let i = 0; i < accessor.count; i++)
    reference.push(
      [0, 1, 2].map((k) =>
        bytes.readFloatLE(
          binStart + (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0) + i * (view.byteStride ?? 12) + k * 4,
        ),
      ),
    );
  const lo = [0, 1, 2].map((k) => Math.min(...reference.map((p) => p[k]))),
    hi = [0, 1, 2].map((k) => Math.max(...reference.map((p) => p[k])));
  using modeler = await createSdfModeler();
  const mesh = modeler.mesh(
    { type: 'box', center: lo.map((v, k) => (v + hi[k]) / 2), halfSize: lo.map((v, k) => (hi[k] - v) / 2) },
    { resolution: 17 },
  );
  assert.ok(mesh.edgeSolves > 0);
  for (const ref of reference) {
    let nearest = Infinity;
    for (let i = 0; i < mesh.positions.length; i += 3)
      nearest = Math.min(nearest, Math.hypot(...ref.map((v, k) => v - mesh.positions[i + k])));
    assert.ok(nearest < 1e-9, `published corner ${ref}: ${nearest}`);
  }
  for (let i = 0; i < mesh.positions.length; i += 3) {
    let face = Infinity;
    for (let k = 0; k < 3; k++) {
      const v = mesh.positions[i + k];
      assert.ok(v >= lo[k] - 1e-9 && v <= hi[k] + 1e-9);
      face = Math.min(face, Math.abs(v - lo[k]), Math.abs(v - hi[k]));
    }
    assert.ok(face < 1e-9);
  }
  const expected = hi.reduce((v, x, k) => v * (x - lo[k]), 1);
  assert.ok(Math.abs(topology(mesh) - expected) < 1e-9);
});

test('generated controls: spheres, CSG cavities, translations, empty/full fields and grid extremes', async () => {
  using modeler = await createSdfModeler();
  for (const resolution of [4, 16, 64]) {
    const mesh = modeler.mesh({ type: 'sphere', radius: 0.8 }, { resolution });
    topology(mesh);
    const h = 3 / resolution;
    for (let i = 0; i < mesh.positions.length; i += 3)
      assert.ok(Math.abs(Math.hypot(...mesh.positions.slice(i, i + 3)) - 0.8) <= (h * h) / 0.8);
  }
  const model = {
    type: 'difference',
    a: { type: 'box', halfSize: [0.8, 0.8, 0.8] },
    b: { type: 'sphere', radius: 0.5 },
  };
  const a = modeler.mesh(model, { resolution: 25 }),
    b = modeler.mesh(model, { resolution: 25 });
  assert.deepEqual(a, b);
  topology(a);
  const moved = modeler.mesh(
    { type: 'box', center: [9000, -9000, 100], halfSize: [0.7, 0.5, 0.3] },
    {
      bounds: [
        [8999, -9002, 99],
        [9002, -8999, 102],
      ],
      resolution: 19,
    },
  );
  assert.ok(Math.abs(topology(moved) - 8 * 0.7 * 0.5 * 0.3) < 1e-8);
  for (const type of ['union', 'intersection'])
    topology(
      modeler.mesh(
        {
          type,
          a: { type: 'sphere', center: [-0.2, 0, 0], radius: 0.7 },
          b: { type: 'sphere', center: [0.2, 0, 0], radius: 0.7 },
        },
        { resolution: 21 },
      ),
    );
  const bounds = [
    [-1.5, -1.5, -1.5],
    [1.5, 1.5, 1.5],
  ];
  const empty = modeler.mesh({ type: 'sphere', center: [5, 0, 0], radius: 0.2 }, { bounds });
  assert.equal(empty.positions.length, 0);
  assert.equal(empty.indices.length, 0);
  assert.throws(
    () => modeler.mesh({ type: 'sphere', radius: 100 }, { bounds }),
    (e) => e.code === 'failed' && /boundary/.test(e.message),
  );
  assert.ok(modeler.mesh().positions.length > 0);
});

test('hostile SDF inputs, pre-abort, cycles, bounds and owned outputs after disposal', async () => {
  const modeler = await createSdfModeler();
  const shape = { type: 'box', halfSize: [0.7, 0.7, 0.7] };
  const bad = (e) => e.code === 'failed' && e.message.includes('https://margoengine.com/errors#procedural');
  for (const resolution of [0, 3, 65, 1e99, NaN, Infinity, 4.5])
    assert.throws(() => modeler.mesh(shape, { resolution }), bad);
  for (const s of [
    null,
    {},
    { type: 'sphere', radius: 0 },
    { type: 'sphere', radius: NaN },
    { type: 'sphere', radius: Infinity },
    { type: 'box', halfSize: [] },
    { type: 'box', halfSize: [-1, 1, 1] },
    { type: 'box', halfSize: [1, 1, 1], center: [NaN, 0, 0] },
  ])
    assert.throws(() => modeler.mesh(s), bad);
  for (const bounds of [
    [],
    [
      [0, 0, 0],
      [0, 1, 1],
    ],
    [
      [0, 0, 0],
      [Infinity, 1, 1],
    ],
    [
      [0, 0, 0],
      [1e-9, 1, 1],
    ],
  ])
    assert.throws(() => modeler.mesh(shape, { bounds }), bad);
  const cycle = { type: 'union', a: shape };
  cycle.b = cycle;
  assert.throws(() => modeler.mesh(cycle), bad);
  const controller = new AbortController();
  const reason = new Error('stop');
  controller.abort(reason);
  assert.throws(
    () => modeler.mesh(shape, { signal: controller.signal }),
    (e) => e === reason,
  );
  await assert.rejects(createSdfModeler({ signal: controller.signal }), (e) => e === reason);
  const first = modeler.mesh(shape),
    saved = first.positions.slice();
  modeler.mesh({ type: 'sphere', radius: 0.8 });
  assert.deepEqual(first.positions, saved);
  modeler.dispose();
  modeler[Symbol.dispose]();
  assert.deepEqual(first.positions, saved);
  assert.throws(
    () => modeler.mesh(),
    (e) => e.code === 'disposed',
  );
});

// A dual quad is rarely planar or convex. Split along the wrong diagonal, one triangle folds back over its neighbour
// and faces inward (shaded dark or culled). Each of these unions of two spheres folded 3 to 10 triangles at the seam
// before the split chose the diagonal that keeps both triangles facing along the quad's edge. A triangle on a union
// surface faces outward from at least one of the two spheres at its centroid.
const seams = [
  {
    shape: {
      type: 'union',
      a: {
        type: 'sphere',
        center: [-0.26199426501989365, 0.23208573437295854, -0.2569248783402145],
        radius: 0.7117692363914103,
      },
      b: {
        type: 'sphere',
        center: [-0.2626143062246508, 0.07310519558206915, -0.5123909463246201],
        radius: 0.46095314977775903,
      },
    },
    resolution: 32,
    bounds: [
      [-1.8685296385083348, -1.3840769103495405, -1.9067383931949735],
      [1.4024261499522255, 1.8469239980913699, 1.4275978075573221],
    ],
  },
  {
    shape: {
      type: 'union',
      a: {
        type: 'sphere',
        center: [0.18462033197283745, 0.3941450600977987, -0.45777273876592517],
        radius: 0.540844172751531,
      },
      b: {
        type: 'sphere',
        center: [0.39590141554434083, 0.30027436921261846, -0.5858696861191175],
        radius: 0.3738280504972704,
      },
    },
    resolution: 43,
    bounds: [
      [-1.4358993286732584, -1.2175986799178646, -2.1302291078493],
      [1.8459756335942075, 2.051183168310672, 1.2229070915142075],
    ],
  },
  {
    shape: {
      type: 'union',
      a: {
        type: 'sphere',
        center: [0.12092800438404083, -0.07743468158878386, 0.27269640238955617],
        radius: 0.629153269296512,
      },
      b: {
        type: 'sphere',
        center: [-0.08353337477044961, 0.11380410236055352, 0.27013829839410125],
        radius: 0.414622591480612,
      },
    },
    resolution: 36,
    bounds: [
      [-1.5238361111376435, -1.6904302104143427, -1.3335287580266595],
      [1.7796766030369326, 1.557344820443541, 1.9469235548982398],
    ],
  },
  {
    shape: {
      type: 'union',
      a: {
        type: 'sphere',
        center: [0.17696866393089294, 0.0013975424226373434, 0.48036901326850057],
        radius: 0.7807272342499345,
      },
      b: {
        type: 'sphere',
        center: [0.04158198386761816, -0.25924282330422044, 0.22756072415715628],
        radius: 0.47209038552541766,
      },
    },
    resolution: 26,
    bounds: [
      [-1.444618973741308, -1.6848055748967454, -1.1870938295498492],
      [1.7890176745830104, 1.604460055474192, 2.1335129494080323],
    ],
  },
  {
    shape: {
      type: 'union',
      a: {
        type: 'sphere',
        center: [-0.45566918328404427, 0.4887620990630239, -0.030989147257059813],
        radius: 0.5154379492159933,
      },
      b: {
        type: 'sphere',
        center: [-0.6328851734250197, 0.3302474058938901, -0.15414119745421584],
        radius: 0.3094147210259931,
      },
    },
    resolution: 36,
    bounds: [
      [-2.1300825084093957, -1.174848974007182, -1.6759981287643315],
      [1.242881005140953, 2.1647570145316424, 1.6292880518594757],
    ],
  },
  {
    shape: {
      type: 'union',
      a: {
        type: 'sphere',
        center: [0.07628672942519188, 0.40436444035731256, -0.043846271466463804],
        radius: 0.5126331543084234,
      },
      b: {
        type: 'sphere',
        center: [0.2786720954618269, 0.5605986375630876, -0.14836431227074032],
        radius: 0.32315693321103633,
      },
    },
    resolution: 33,
    bounds: [
      [-1.5241551170591265, -1.2837616669712588, -1.676254159025848],
      [1.7389333105413245, 2.0284035679884256, 1.6086807040730493],
    ],
  },
];
test('no folded triangles: every triangle at a two-sphere seam faces away from one of its spheres', async () => {
  using modeler = await createSdfModeler();
  for (const { shape, resolution, bounds } of seams) {
    const mesh = modeler.mesh(shape, { resolution, bounds }),
      { positions: p, indices: ix } = mesh;
    topology(mesh);
    let folded = 0;
    for (let i = 0; i < ix.length; i += 3) {
      const [a, b, c] = [0, 1, 2].map((k) => [0, 1, 2].map((j) => p[ix[i + k] * 3 + j]));
      const u = b.map((v, k) => v - a[k]),
        v = c.map((v, k) => v - a[k]),
        face = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]],
        centroid = a.map((x, k) => (x + b[k] + c[k]) / 3),
        facing = (centre) => face.reduce((sum, f, k) => sum + f * (centroid[k] - centre[k]), 0);
      if (Math.max(facing(shape.a.center), facing(shape.b.center)) < 0) folded++;
    }
    assert.equal(folded, 0, `resolution ${resolution}`);
  }
});

test('a surface through grid points: no zero-area triangles and no two vertices on one point', async () => {
  // The default bounds put a radius-0.8 sphere's poles on grid points at every resolution that is a multiple of 12. The
  // field there rounds to about -1e-16, so the pole counted as inside, each edge from it crossed on the pole itself and
  // the tangent edges 1e-8 away: every cell around it placed a vertex on top of its neighbours' (30 of 3,708 triangles
  // had zero area at 24). A box whose faces lie on grid planes samples exactly zero along them.
  using modeler = await createSdfModeler();
  const cases = [12, 24, 36].map((resolution) => ({ shape: { type: 'sphere', radius: 0.8 }, options: { resolution } }));
  for (const resolution of [12, 24])
    cases.push({
      shape: { type: 'box', halfSize: [0.5, 0.5, 0.5] },
      options: {
        resolution,
        bounds: [
          [-1, -1, -1],
          [1, 1, 1],
        ],
      },
    });
  for (const { shape, options } of cases) {
    const label = `${shape.type} at ${options.resolution}`,
      mesh = modeler.mesh(shape, options),
      { positions: p, indices: ix } = mesh;
    let flat = 0;
    for (let i = 0; i < ix.length; i += 3) {
      const [a, b, c] = [0, 1, 2].map((k) => [0, 1, 2].map((j) => p[ix[i + k] * 3 + j]));
      const u = b.map((v, k) => v - a[k]),
        v = c.map((v, k) => v - a[k]);
      if (Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) <= 1e-14) flat++;
    }
    assert.equal(flat, 0, `${label}: zero-area triangles`);
    topology(mesh);
    const count = p.length / 3;
    for (let i = 0; i < count; i++)
      for (let j = i + 1; j < count; j++) {
        const gap = Math.hypot(p[i * 3] - p[j * 3], p[i * 3 + 1] - p[j * 3 + 1], p[i * 3 + 2] - p[j * 3 + 2]);
        assert.ok(gap > 1e-6, `${label}: vertices ${i} and ${j} are ${gap} apart`);
      }
  }
});
