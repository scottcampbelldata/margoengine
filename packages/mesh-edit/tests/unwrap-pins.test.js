// Pinned charts and the packer: free charts are packed around pinned ones, never on top of them.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { grid, ids, random } from './topology-helpers.js';

const K = { ...(await import('../dist/index.js')), ...(await import('../dist/modeling.js')) };

/**
 * `count` separate flat square grids (one chart each), `n` cells a side; island `i` has side `sizes[i]` (default 1)
 * and is lifted by `jitter` at random so the charts are not exactly flat. Island `i` starts at vertex `i * (n+1)^2`.
 */
function islands(count, n = 3, { sizes = [], jitter = 0, seed = 1, triangles = false } = {}) {
  const rand = random(seed),
    vertices = [],
    faces = [];
  for (let k = 0; k < count; k++) {
    const side = sizes[k] ?? 1,
      base = vertices.length,
      x0 = k * 3;
    for (let j = 0; j <= n; j++)
      for (let i = 0; i <= n; i++)
        vertices.push([x0 + (side * i) / n, jitter * (rand() - 0.5) * (side / n), (side * j) / n]);
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const a = base + j * (n + 1) + i,
          q = [a, a + n + 1, a + n + 2, a + 1];
        const loops = triangles
          ? [
              [q[0], q[1], q[2]],
              [q[0], q[2], q[3]],
            ]
          : [q];
        loops.forEach((loop, t) =>
          faces.push({ id: `i${k}-${i}-${j}-${t}`, vertices: loop, uv: loop.map(() => [0, 0]) }),
        );
      }
  }
  return { vertices, faces };
}

/** Island `k`'s first vertex and the far end of its first row: pinning both fixes a square chart of side `L`. */
const rowPins = (k, n, uv, L) => [
  { vertex: k * (n + 1) ** 2, uv },
  { vertex: k * (n + 1) ** 2 + n, uv: [uv[0] + L, uv[1]] },
];

const orient = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);

function pointSegment(p, a, b) {
  const dx = b[0] - a[0],
    dy = b[1] - a[1],
    len = dx * dx + dy * dy,
    t = len > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/** Crossing-number test, false on the boundary. */
function strictlyInside(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j],
      b = poly[i];
    if (pointSegment(p, a, b) === 0) return false;
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < a[0] + ((p[1] - a[1]) * (b[0] - a[0])) / (b[1] - a[1])) inside = !inside;
  }
  return inside;
}

/** -1 when the interiors of two UV polygons overlap, else the smallest distance between them (0 when touching). */
function gap(a, b) {
  for (let i = 0; i < a.length; i++)
    for (let j = 0; j < b.length; j++) {
      const p = a[i],
        q = a[(i + 1) % a.length],
        r = b[j],
        s = b[(j + 1) % b.length];
      if (orient(p, q, r) * orient(p, q, s) < 0 && orient(r, s, p) * orient(r, s, q) < 0) return -1;
    }
  const mid = (poly) => [(poly[0][0] + poly[1][0] + poly[2][0]) / 3, (poly[0][1] + poly[1][1] + poly[2][1]) / 3];
  if (a.some((p) => strictlyInside(p, b)) || b.some((p) => strictlyInside(p, a))) return -1;
  if (strictlyInside(mid(a), b) || strictlyInside(mid(b), a)) return -1;
  let best = Infinity;
  for (let i = 0; i < a.length; i++)
    for (let j = 0; j < b.length; j++) {
      best = Math.min(best, pointSegment(a[i], b[j], b[(j + 1) % b.length]));
      best = Math.min(best, pointSegment(b[j], a[i], a[(i + 1) % a.length]));
    }
  return best;
}

/**
 * The invariant: no two charts overlap; a chart that was packed keeps `padding` texels (at `resolution`) from every
 * other chart; pinned charts may touch each other but never overlap. Every pinned corner sits exactly on its pin.
 */
function assertNoOverlap(result, mesh, pins, { resolution = 1024, padding = 4 } = {}) {
  const index = new Map(result.mesh.faces.map((face, f) => [face.id, f])),
    polys = result.charts.map((chart) => chart.faces.map((id) => result.mesh.faces[index.get(id)].uv)),
    limit = padding / resolution - 1e-9;
  for (const face of result.mesh.faces)
    for (const p of face.uv) assert.ok(p[0] >= 0 && p[0] <= 1 && p[1] >= 0 && p[1] <= 1, `uv ${p} outside`);
  for (let i = 0; i < polys.length; i++)
    for (let j = i + 1; j < polys.length; j++) {
      const [a0, a1, a2, a3] = result.charts[i].bounds,
        [b0, b1, b2, b3] = result.charts[j].bounds;
      if (a2 + limit < b0 || b2 + limit < a0 || a3 + limit < b1 || b3 + limit < a1) continue;
      const pinned = result.charts[i].pins > 0 && result.charts[j].pins > 0;
      let least = Infinity;
      for (const a of polys[i]) for (const b of polys[j]) least = Math.min(least, gap(a, b));
      if (pinned) assert.ok(least >= 0, `pinned charts ${i} and ${j} overlap`);
      else assert.ok(least >= limit, `charts ${i} and ${j} are ${least * resolution} texels apart, under ${padding}`);
    }
  // Pins are exact: every corner of a pinned vertex is the pin's uv.
  for (const pin of pins)
    mesh.faces.forEach((face, f) =>
      face.vertices.forEach((v, c) => {
        if (v === pin.vertex) assert.deepEqual(result.mesh.faces[f].uv[c], [pin.uv[0], pin.uv[1]]);
      }),
    );
}

const isFailed = (error) => error?.name === 'MargoError' && error.code === 'failed';

test('unwrap pins: a pinned chart where the packer starts (top left) pushes the free charts around it', () => {
  const n = 3,
    mesh = islands(6, n),
    pins = rowPins(0, n, [0.02, 0.02], 0.45),
    result = K.unwrapMesh(mesh, { pins });
  assert.equal(result.charts.filter((chart) => chart.pins === 2).length, 1);
  assertNoOverlap(result, mesh, pins);
  // The pinned chart is exactly the square its pins describe (orientation kept, not rotated or rescaled).
  const fixed = result.charts.find((chart) => chart.pins === 2);
  fixed.bounds.forEach((x, i) => assert.ok(Math.abs(x - [0.02, 0.02, 0.47, 0.47][i]) < 1e-9, `${fixed.bounds}`));
});

test('unwrap pins: several pinned charts, in the middle and at the edges, with free charts between them', () => {
  const n = 3,
    mesh = islands(10, n, { sizes: [1, 1, 1, 0.5, 2] }),
    pins = [
      ...rowPins(0, n, [0.3, 0.3], 0.3),
      ...rowPins(1, n, [0, 0.75], 0.25),
      ...rowPins(2, n, [0.8, 0], 0.2),
      { vertex: 3 * (n + 1) ** 2 + 5, uv: [0.1, 0.62] },
    ],
    result = K.unwrapMesh(mesh, { pins, padding: 2 });
  assert.equal(result.charts.filter((chart) => chart.pins > 0).length, 4);
  assertNoOverlap(result, mesh, pins, { padding: 2 });
});

test('unwrap pins: one pinned face of a cube among the packed five, at the same density and apart', () => {
  // Every cube corner is shared by three faces, so a pin on one pins three charts at one point: they may touch there
  // but never overlap, and the free charts keep their padding from all three.
  const box = K.createPrimitiveMesh('cube', 'box'),
    top = box.faces.find((face) => face.id === 'box-face-4');
  for (const uv of [
    [0.5, 0.5],
    [0.05, 0.05],
    [0.95, 0.3],
  ]) {
    const pins = [{ vertex: top.vertices[0], uv }],
      result = K.unwrapMesh(box, { pins });
    assert.equal(result.charts.filter((chart) => chart.pins === 1).length, 3);
    assert.ok(result.diagnostics.some((note) => /closer than 4 texels/.test(note)));
    // Near the border the three pinned charts can only be as large as the room the pin leaves.
    assert.ok(result.texelsPerUnit <= Math.max(Math.min(uv[0], 1 - uv[0]), Math.min(uv[1], 1 - uv[1])) * 1024 + 1e-6);
    assertNoOverlap(result, box, pins);
    for (const chart of result.charts) {
      const [u0, v0, u1, v1] = chart.bounds;
      assert.ok(Math.abs((u1 - u0) * 1024 - result.texelsPerUnit) < 1e-6);
      assert.ok(Math.abs((v1 - v0) * 1024 - result.texelsPerUnit) < 1e-6);
    }
  }
});

test('unwrap pins: a single pin by the border lowers the density until its chart fits, and says so', () => {
  const n = 3,
    mesh = islands(4, n),
    plain = K.unwrapMesh(mesh).texelsPerUnit;
  for (const [uv, limited] of [
    [[0.999, 0.5], true],
    [[0.5, 0.999], true],
    [[0.999, 0.999], true],
    [[0.001, 0.001], false],
  ]) {
    const pins = [{ vertex: 0, uv }],
      result = K.unwrapMesh(mesh, { pins });
    assertNoOverlap(result, mesh, pins);
    assert.equal(
      result.diagnostics.some((note) => /limit the texel density/.test(note)),
      limited,
    );
    if (limited) assert.ok(result.texelsPerUnit <= 0.001 * 1024 + 1e-9);
    else assert.ok(result.texelsPerUnit > 0.99 * plain);
  }
  // A pin on the border with its chart reaching past it cannot fit at any density.
  assert.throws(() => K.unwrapMesh(mesh, { pins: [{ vertex: 0, uv: [1, 0.5] }] }), RangeError);
});

test('unwrap pins: a chart pinned along the unit square border is inside, not outside by solver rounding', () => {
  // The least squares solve puts the unpinned corners of a border row about 1e-16 past the border; that once threw.
  const n = 3,
    mesh = islands(3, n);
  for (const [uv, L] of [
    [[0, 0], 0.3],
    [[0, 0.5], 0.25],
    [[0.7, 0], 0.3],
    [[0.6, 0.6], 0.4],
  ]) {
    const pins = rowPins(0, n, uv, L),
      result = K.unwrapMesh(mesh, { pins });
    assertNoOverlap(result, mesh, pins);
    const [u0, v0, u1, v1] = result.charts.find((chart) => chart.pins === 2).bounds;
    assert.ok(u0 >= uv[0] - 1e-12 && v0 >= uv[1] - 1e-12 && u1 <= uv[0] + L + 1e-12 && v1 <= uv[1] + L + 1e-12);
  }
});

test('unwrap pins: two pins that place their chart partly outside the unit square throw a RangeError', () => {
  const n = 3,
    mesh = islands(3, n);
  assert.throws(() => K.unwrapMesh(mesh, { pins: rowPins(0, n, [0.5, 0.8], 0.4) }), RangeError);
  // A row pinned upright by either side border: the chart turns to one side, and that side must be the inside.
  let threw = 0;
  for (const u of [0.05, 0.95]) {
    const pins = [
      { vertex: 0, uv: [u, 0.2] },
      { vertex: n, uv: [u, 0.6] },
    ];
    try {
      assertNoOverlap(K.unwrapMesh(mesh, { pins }), mesh, pins);
    } catch (error) {
      assert.ok(error instanceof RangeError, `${error}`);
      threw++;
    }
  }
  assert.equal(threw, 1);
});

test('unwrap pins: overlapping pinned charts and pins that leave no room are coded errors, never overlaps', () => {
  const n = 3,
    mesh = islands(4, n);
  // Two pinned charts on top of each other (user error).
  assert.throws(
    () => K.unwrapMesh(mesh, { pins: [...rowPins(0, n, [0.2, 0.2], 0.4), ...rowPins(1, n, [0.4, 0.4], 0.4)] }),
    (error) => isFailed(error) && /overlap/.test(error.message),
  );
  // Identical placement is an overlap too.
  assert.throws(
    () => K.unwrapMesh(mesh, { pins: [...rowPins(0, n, [0.2, 0.2], 0.4), ...rowPins(1, n, [0.2, 0.2], 0.4)] }),
    isFailed,
  );
  // A pinned chart over the whole square leaves the other three nowhere to go.
  assert.throws(
    () => K.unwrapMesh(mesh, { pins: rowPins(0, n, [0, 0], 1) }),
    (error) => isFailed(error) && /room/.test(error.message),
  );
  // Pinned charts that only touch are allowed, and reported in diagnostics because they are closer than padding.
  const pins = [...rowPins(0, n, [0, 0], 0.3), ...rowPins(1, n, [0.3, 0], 0.3)],
    touching = K.unwrapMesh(mesh, { pins });
  assertNoOverlap(touching, mesh, pins);
  assert.ok(touching.diagnostics.some((note) => /closer than 4 texels/.test(note)));
});

test('unwrap pins golden: no-pin and single-chart layouts are byte-identical to before pinned packing', () => {
  // Hashes recorded from the packer before pinned charts became obstacles (commit 30bea6fa).
  const h = (x) => createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0, 16),
    un = (r) => h([r.mesh.faces.map((f) => f.uv), r.charts, r.seams, r.texelsPerUnit, r.diagnostics]),
    lm = (r) => h([r.uv, r.charts, r.seams, r.texelsPerUnit]),
    cube = () => K.createPrimitiveMesh('cube', 'box'),
    smooth = K.subdivideMesh(cube(), { levels: 2, ...ids('s') }).mesh;
  const got = {
    cube: un(K.unwrapMesh(cube())),
    smooth: un(K.unwrapMesh(smooth, { angle: 60, padding: 4 })),
    grid: un(K.unwrapMesh(grid(4))),
    gridTwoPins: un(
      K.unwrapMesh(grid(4), {
        pins: [
          { vertex: 0, uv: [0.1, 0.1] },
          { vertex: 4, uv: [0.9, 0.1] },
        ],
      }),
    ),
    gridOnePin: un(K.unwrapMesh(grid(4), { pins: [{ vertex: 12, uv: [0.5, 0.5] }], resolution: 256 })),
    lightCube: lm(K.meshLightmapUVs(cube())),
    lightSmooth: lm(K.meshLightmapUVs(smooth, { resolution: 256, padding: 2 })),
    lightSmallRes: lm(K.meshLightmapUVs(smooth, { resolution: 64, padding: 1, angle: 30 })),
  };
  assert.deepEqual(got, {
    cube: '5cb61a3960059f98',
    smooth: 'b005d36c2ac10eef',
    grid: '5a03daba5a307ebd',
    gridTwoPins: '0f4bbb96ed9c4e4f',
    gridOnePin: '308b50e064dabbe9',
    lightCube: '16f4a4b4a0e37de5',
    lightSmooth: '55210b32291b1a55',
    lightSmallRes: '81c5fc551cfe1661',
  });
});

test('unwrap pins fuzz: random meshes and pin sets never produce overlapping charts', () => {
  let laid = 0,
    pinnedLaid = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const rand = random(seed * 7919),
      n = 2 + Math.floor(rand() * 3),
      count = 2 + Math.floor(rand() * 7),
      sizes = Array.from({ length: count }, () => 0.3 + rand() * 1.7),
      tri = rand() < 0.5,
      mesh = islands(count, n, { sizes, jitter: tri ? rand() * 0.6 : 0, seed, triangles: tri }),
      padding = 1 + Math.floor(rand() * 4),
      resolution = [128, 256, 1024][Math.floor(rand() * 3)],
      pins = [];
    for (let k = 0; k < count; k++) {
      const r = rand();
      if (r < 0.3) {
        const L = 0.05 + rand() * 0.3;
        pins.push(...rowPins(k, n, [rand() * (1 - L), rand() * (1 - L)], L));
      } else if (r < 0.5)
        pins.push({ vertex: k * (n + 1) ** 2 + Math.floor(rand() * (n + 1) ** 2), uv: [rand(), rand()] });
    }
    const angle = rand() < 0.5 ? 180 : 20 + rand() * 60;
    let result;
    try {
      result = K.unwrapMesh(mesh, { pins, padding, resolution, angle });
    } catch (error) {
      assert.ok(isFailed(error) || error instanceof RangeError, `seed ${seed}: ${error}`);
      continue;
    }
    assertNoOverlap(result, mesh, pins, { padding, resolution });
    laid++;
    if (result.charts.some((chart) => chart.pins > 0)) pinnedLaid++;
  }
  assert.ok(laid >= 30 && pinnedLaid >= 20, `only ${laid} layouts (${pinnedLaid} pinned) succeeded`);
});
