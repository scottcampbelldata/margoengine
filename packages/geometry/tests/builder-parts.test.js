import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GeometryBuilder,
  parseColor,
  placeGeometry,
  placementMatrix,
  tintGeometry,
} from '@margoengine/geometry/builder';
import {
  arrowGeometry,
  chamferBoxGeometry,
  gridSheetGeometry,
  helixGeometry,
  pipeGeometry,
  prismGeometry,
  ribbonGeometry,
  ringSectorGeometry,
  rotationMinimizingFrames,
  scaleMarksGeometry,
  strokeGeometry,
  turnedGeometry,
} from '@margoengine/geometry/parts';
import { applyMatrix4, extractGroups, mergeGeometries, mergeVertices, toNonIndexed } from '@margoengine/geometry/utils';
import { lerp } from '@margoengine/math/vec3';

const close = (a, b, eps = 1e-5) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

/** Every triangle's winding normal agrees with its corners' stored normals (no inside-out faces). */
function assertOutward(data, minDot = 0) {
  const P = data.positions,
    N = data.normals,
    I = data.indices;
  let checked = 0;
  for (let t = 0; t < I.length; t += 3) {
    const [a, b, c] = [I[t], I[t + 1], I[t + 2]];
    const u = [0, 1, 2].map((k) => P[b * 3 + k] - P[a * 3 + k]),
      v = [0, 1, 2].map((k) => P[c * 3 + k] - P[a * 3 + k]);
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const l = Math.hypot(...n);
    if (l < 1e-12) continue;
    for (const k of [a, b, c]) {
      const d = (n[0] * N[k * 3] + n[1] * N[k * 3 + 1] + n[2] * N[k * 3 + 2]) / l;
      assert.ok(d > minDot, `triangle ${t / 3} faces against its normals (${d})`);
    }
    checked++;
  }
  assert.ok(checked > 0);
}
/** Signed volume by the divergence theorem: positive when the closed surface winds outward. */
function volume(data) {
  const P = data.positions,
    I = data.indices;
  let v = 0;
  for (let t = 0; t < I.length; t += 3) {
    const [a, b, c] = [I[t] * 3, I[t + 1] * 3, I[t + 2] * 3];
    v +=
      P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) -
      P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) +
      P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c]);
  }
  return v / 6;
}
/** Every edge is shared by exactly two triangles in opposite directions (a closed, consistently wound surface). */
function assertClosed(data) {
  const welded = mergeVertices(data, { positionOnly: true, tolerance: 1e-6 });
  const edges = new Map();
  const I = welded.indices;
  for (let t = 0; t < I.length; t += 3)
    for (let k = 0; k < 3; k++) {
      const a = I[t + k],
        b = I[t + ((k + 1) % 3)];
      if (a === b) continue;
      const key = `${a},${b}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  for (const [key, n] of edges) {
    const [a, b] = key.split(',');
    assert.equal(n, edges.get(`${b},${a}`), `edge ${key} is open or doubled`);
  }
}

test('lerp in math/vec3 interpolates componentwise', () => {
  assert.deepEqual(lerp([0, 2, 4], [10, 4, 0], 0.5), [5, 3, 2]);
  assert.deepEqual(lerp([1, 1, 1], [3, 3, 3], 0), [1, 1, 1]);
});

test('parseColor decodes sRGB hex to linear and keeps linear arrays', () => {
  const [r, g, b, a] = parseColor('#ff8000');
  close(r, 1);
  close(g, 0.21586, 1e-4); // sRGB 128/255 decoded by the IEC 61966-2-1 curve
  close(b, 0);
  close(a, 1);
  assert.deepEqual(parseColor('#ffffff88'), [1, 1, 1, 0x88 / 255]);
  assert.deepEqual(parseColor('#fff'), [1, 1, 1, 1]);
  assert.deepEqual(parseColor([0.5, 0.25, 0]), [0.5, 0.25, 0, 1]);
  assert.throws(() => parseColor('red'), RangeError);
  assert.throws(() => parseColor([1, 2]), RangeError);
});

test('GeometryBuilder: flat faces take their normal from the winding, colours and UVs per vertex', () => {
  const b = new GeometryBuilder({ colors: true, color: [0.2, 0.4, 0.6] });
  b.triangle([0, 0, 0], [1, 0, 0], [0, 1, 0]);
  b.quad([0, 0, 1], [0, 0, 2], [0, 1, 2], [0, 1, 1], { color: '#000000', flip: true });
  const d = b.data();
  assert.equal(d.indices.length, 9);
  const normal = (i) => Array.from(d.normals.subarray(i * 3, i * 3 + 3)).map((v) => v + 0);
  assert.deepEqual(normal(d.indices[0]), [0, 0, 1]);
  // The flipped quad on x = 0 winds toward -x reversed, so it faces +x.
  const q = d.indices[3];
  assert.deepEqual(normal(q), [1, 0, 0]);
  assert.deepEqual(Array.from(d.colors.subarray(0, 4)).map((v) => +v.toFixed(3)), [0.2, 0.4, 0.6, 1]);
  assert.deepEqual(Array.from(d.colors.subarray(q * 4, q * 4 + 4)), [0, 0, 0, 1]);
  assertOutward(d);
  // Without colours: none stored.
  assert.equal(new GeometryBuilder().triangle([0, 0, 0], [1, 0, 0], [0, 1, 0]).data().colors, undefined);
});

test('GeometryBuilder: polygon with a hole triangulates to the right area, facing its winding', () => {
  const square = [
    [-1, 0, -1],
    [-1, 0, 1],
    [1, 0, 1],
    [1, 0, -1],
  ]; // counter-clockwise seen from +y
  const hole = [
    [-0.5, 0, -0.5],
    [0.5, 0, -0.5],
    [0.5, 0, 0.5],
    [-0.5, 0, 0.5],
  ];
  const d = new GeometryBuilder({ weld: false }).polygon(square, { holes: [hole] }).data();
  let area = 0;
  for (let t = 0; t < d.indices.length; t += 3) {
    const [a, b, c] = [d.indices[t], d.indices[t + 1], d.indices[t + 2]].map((i) => [d.positions[i * 3], d.positions[i * 3 + 2]]);
    area += Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
  }
  close(area, 3);
  for (let i = 0; i < d.normals.length; i += 3) assert.deepEqual(Array.from(d.normals.subarray(i, i + 3)), [0, 1, 0]);
  assertOutward(d);
});

test('GeometryBuilder: smooth averages faces under the crease and keeps sharper ones', () => {
  // Two faces folded by 20 degrees share a smooth normal at 30; a 90 degree fold stays sharp.
  const fold = (deg, smooth) => {
    const a = (deg * Math.PI) / 180;
    return new GeometryBuilder({ smooth })
      .quad([0, 0, 0], [1, 0, 0], [1, 0, -1], [0, 0, -1])
      .quad([0, 0, 0], [0, 0, -1], [-Math.cos(a), Math.sin(a), -1], [-Math.cos(a), Math.sin(a), 0])
      .data();
  };
  // The normals at the shared corner (the origin): one direction when smooth, two when creased.
  const atOrigin = (d) => {
    const seen = new Set();
    for (let i = 0; i < d.positions.length; i += 3)
      if (!d.positions[i] && !d.positions[i + 1] && !d.positions[i + 2])
        seen.add(Array.from(d.normals.subarray(i, i + 3), (v) => v.toFixed(5)).join());
    return seen.size;
  };
  const soft = fold(20, 30),
    hard = fold(90, 30);
  assert.equal(atOrigin(soft), 1);
  assert.equal(atOrigin(hard), 2);
  assert.equal(atOrigin(fold(20, false)), 2);
  assertOutward(soft);
  assertOutward(hard);
});

test('GeometryBuilder.grid: a unit sphere patch has outward unit normals and (u, v) UVs', () => {
  const sphere = (u, v) => {
    const t = u * 2 * Math.PI,
      p = (v - 0.5) * Math.PI * 0.98;
    return [Math.cos(p) * Math.cos(t), Math.sin(p), -Math.cos(p) * Math.sin(t)];
  };
  const d = new GeometryBuilder().grid(32, 16, sphere).data();
  for (let i = 0; i < d.positions.length; i += 3) {
    const dotp = d.positions[i] * d.normals[i] + d.positions[i + 1] * d.normals[i + 1] + d.positions[i + 2] * d.normals[i + 2];
    close(dotp, 1, 1e-3);
  }
  assertOutward(d);
  close(d.uvs[2 * 33 * 16 + 2 * 32], 1);
});

test('placementMatrix: yaw, pitch, roll and scale act as documented', () => {
  const m = placementMatrix({ yaw: Math.PI / 2, position: [1, 2, 3], scale: 2 });
  const p = applyMatrix4({ positions: new Float32Array([1, 0, 0]), normals: new Float32Array([1, 0, 0]), uvs: new Float32Array(2), indices: new Uint32Array(0) }, m);
  // +x yawed a quarter turn about +y goes to -z.
  close(p.positions[0], 1);
  close(p.positions[1], 2);
  close(p.positions[2], 1);
  close(p.normals[2], -1);
  const q = placementMatrix({ pitch: Math.PI / 2 });
  close(q[4 + 2], 1); // +y pitched about +x goes to +z
  const r = placementMatrix({ roll: Math.PI / 2 });
  close(r[1], 1); // +x rolled about +z goes to +y
});

test('append, placeGeometry and tintGeometry keep colours through merge, weld and expansion', () => {
  const box = chamferBoxGeometry(1, 1, 1);
  const red = tintGeometry(box, [1, 0, 0]);
  const moved = placeGeometry(red, { position: [5, 0, 0], yaw: 0.3 });
  assert.equal(moved.colors.length, (moved.positions.length / 3) * 4);
  close(moved.colors[0], 1);
  const merged = mergeGeometries([moved, box]);
  assert.equal(merged.colors.length, (merged.positions.length / 3) * 4);
  close(merged.colors[merged.colors.length - 3], 1); // box had no colours: white
  close(merged.colors[merged.colors.length - 4], 1);
  const flat = toNonIndexed(merged);
  assert.equal(flat.colors.length, flat.indices.length * 4);
  const kept = applyMatrix4(merged, placementMatrix({ scale: 2 }));
  assert.equal(kept.colors, merged.colors);
  const built = new GeometryBuilder({ colors: true }).append(box, { color: '#00ff00', position: [0, 1, 0] }).append(red).data();
  assert.equal(built.colors.length, (built.positions.length / 3) * 4);
  close(volume(built), 2 * volume(box), 1e-4);
});

test('turnedGeometry: a capped cylinder is closed, outward and of the right volume; creases stay sharp', () => {
  const r = 0.5,
    h = 2;
  const cyl = turnedGeometry(
    [
      [r, 0],
      [r, h],
    ],
    { segments: 256 },
  );
  assertClosed(cyl);
  assertOutward(cyl);
  close(volume(cyl), Math.PI * r * r * h, 2e-3);
  // The rim is a 90 degree crease: the side normals there are horizontal, the cap's vertical.
  for (let i = 0; i < cyl.normals.length; i += 3) {
    const ny = Math.abs(cyl.normals[i + 1]);
    assert.ok(ny < 1e-5 || ny > 1 - 1e-5, `mixed normal ${ny}`);
  }
  // On another axis, the same solid.
  const z = turnedGeometry(
    [
      [r, 0],
      [r, h],
    ],
    { segments: 64, axis: 'z' },
  );
  assertOutward(z);
  let maxZ = 0;
  for (let i = 2; i < z.positions.length; i += 3) maxZ = Math.max(maxZ, z.positions[i]);
  close(maxZ, h);
  for (const axis of ['x', 'y', 'z']) assert.ok(volume(turnedGeometry([[0, 0], [1, 0], [0, 1]], { axis })) > 0);
  // A ring profile loop closes on itself, and a partial sweep gets end caps.
  const ring = turnedGeometry([[1, 0], [2, 0], [2, 1], [1, 1], [1, 0]]);
  assertClosed(ring);
  // A 48-gon ring: (n / 2) sin(2 pi / n) (R^2 - r^2) h.
  close(volume(ring), 24 * Math.sin(Math.PI / 24) * 3, 1e-4);
  const half = turnedGeometry([[0, 0], [1, 0], [1, 1], [0, 1]], { sweep: Math.PI, segments: 128 });
  close(volume(half), Math.PI / 2, 1e-3);
  assert.throws(() => turnedGeometry([[1, 0]]), RangeError);
  assert.throws(() => turnedGeometry([[-1, 0], [1, 1]]), RangeError);
});

test('rotationMinimizingFrames: no twist about a planar curve, and a closed loop meets itself', () => {
  const arc = Array.from({ length: 50 }, (_, i) => [Math.cos(i / 10), 0, Math.sin(i / 10)]);
  const { normals, tangents, binormals } = rotationMinimizingFrames(arc, { up: [0, 1, 0] });
  for (const n of normals) close(n[1], 1, 1e-9);
  for (let i = 0; i < tangents.length; i++) close(Math.hypot(...binormals[i]), 1, 1e-9);
  // A helix-like closed loop (a torus knot) ends on the frame it started with.
  const knot = Array.from({ length: 400 }, (_, i) => {
    const t = (i / 400) * 2 * Math.PI;
    return [Math.cos(2 * t) * (2 + Math.cos(3 * t)), Math.sin(3 * t), Math.sin(2 * t) * (2 + Math.cos(3 * t))];
  });
  const loop = rotationMinimizingFrames(knot, { closed: true });
  const a = loop.normals[0],
    b = loop.normals[399];
  assert.ok(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] > 0.99);
});

test('pipeGeometry: a straight pipe matches the cylinder volume; bends stay closed and outward', () => {
  const pipe = pipeGeometry(
    [
      [0, 0, 0],
      [0, 3, 0],
    ],
    0.25,
    { sides: 256 },
  );
  assertClosed(pipe);
  assertOutward(pipe);
  close(volume(pipe), Math.PI * 0.0625 * 3, 2e-3);
  const bent = pipeGeometry(
    [
      [0, 0, 0],
      [0, 1, 0],
      [1, 1, 0],
      [1, 1, 1],
    ],
    0.05,
    { bend: 0.2 },
  );
  assertClosed(bent);
  assertOutward(bent, -0.2);
  assert.ok(volume(bent) > 0);
  const loop = pipeGeometry(
    Array.from({ length: 64 }, (_, i) => [Math.cos((i / 64) * 2 * Math.PI), 0, Math.sin((i / 64) * 2 * Math.PI)]),
    0.1,
    { closed: true },
  );
  assertClosed(loop);
  // A polygonal torus of radii 1 and 0.1 (Pappus over a 16-gon section and a 64-gon path).
  close(volume(loop), 8 * Math.sin(Math.PI / 8) * 0.01 * 128 * Math.sin(Math.PI / 64), 0.001);
  const square = pipeGeometry([[0, 0, 0], [0, 1, 0]], 1, { section: [[-1, -1], [1, -1], [1, 1], [-1, 1]] });
  close(volume(square), 4, 1e-4);
});

test('helixGeometry: wire length and volume of a coil', () => {
  const R = 0.5,
    pitch = 0.3,
    turns = 3,
    wire = 0.03;
  const coil = helixGeometry({ radius: R, pitch, turns, wire, sides: 64, segmentsPerTurn: 256 });
  assertClosed(coil);
  assertOutward(coil, -0.1);
  const length = turns * Math.hypot(2 * Math.PI * R, pitch);
  close(volume(coil), Math.PI * wire * wire * length, 0.03 * Math.PI * wire * wire * length);
  let top = 0;
  for (let i = 1; i < coil.positions.length; i += 3) top = Math.max(top, coil.positions[i]);
  close(top, pitch * turns + wire, 0.01);
});

test('ribbonGeometry: a flat ribbon over the ground faces up; a thick one is a closed band', () => {
  const path = Array.from({ length: 20 }, (_, i) => [i * 0.1, 0, Math.sin(i * 0.3)]);
  const sheet = ribbonGeometry(path, 0.2);
  for (let i = 1; i < sheet.normals.length; i += 3) close(sheet.normals[i], 1, 1e-6);
  assertOutward(sheet);
  const band = ribbonGeometry(path, 0.2, { thickness: 0.02 });
  assertClosed(band);
  assert.ok(volume(band) > 0);
});

test('prismGeometry: volume with bevel and holes on every axis', () => {
  const square = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ];
  for (const axis of ['x', 'y', 'z']) {
    const p = prismGeometry(square, 1, { axis });
    assertClosed(p);
    assertOutward(p);
    close(volume(p), 4, 1e-5);
  }
  // A 45 degree chamfer b on a 2 x 2 x 1 block cuts two frusta: V = 4h - 2 * (4b * (2 - b) ... ) measured exactly:
  const b = 0.1,
    bev = prismGeometry(square, 1, { bevel: b });
  assertClosed(bev);
  assertOutward(bev);
  // Each chamfer band is a frustum from side 2 - 2b to 2 over height b.
  const frustum = (b / 3) * ((2 - 2 * b) ** 2 + 4 + (2 - 2 * b) * 2);
  close(volume(bev), 4 * (1 - 2 * b) + 2 * frustum, 1e-5);
  const holed = prismGeometry(square, 1, { holes: [square.map(([x, y]) => [x / 2, y / 2])] });
  assertClosed(holed);
  close(volume(holed), 3, 1e-5);
  // Clockwise outlines are accepted.
  close(volume(prismGeometry([...square].reverse(), 1)), 4, 1e-5);
  assert.throws(() => prismGeometry(square, 1, { bevel: 0.6 }), RangeError);
});

test('chamferBoxGeometry: chamfered and rounded boxes keep their outer size', () => {
  const box = chamferBoxGeometry(2, 1, 3, { chamfer: 0.05 });
  assertClosed(box);
  assertOutward(box);
  const ext = [0, 1, 2].map((k) => {
    let lo = Infinity,
      hi = -Infinity;
    for (let i = k; i < box.positions.length; i += 3) (lo = Math.min(lo, box.positions[i])), (hi = Math.max(hi, box.positions[i]));
    return hi - lo;
  });
  ext.forEach((e, k) => close(e, [2, 1, 3][k], 1e-5));
  const round = chamferBoxGeometry(1, 0.1, 1, { chamfer: 0.01, radius: 0.2, segments: 32 });
  assertClosed(round);
  // Rounded corners take (4 - pi) r^2 of the footprint.
  close(volume(round), (1 - (4 - Math.PI) * 0.04) * 0.1, 0.004);
});

test('ringSectorGeometry: flat annulus area, solid ring volume, superellipse squareness', () => {
  const area = (d) => {
    let a = 0;
    for (let t = 0; t < d.indices.length; t += 3) {
      const [p, q, r] = [d.indices[t], d.indices[t + 1], d.indices[t + 2]].map((i) => [d.positions[i * 3], d.positions[i * 3 + 2]]);
      a += Math.abs((q[0] - p[0]) * (r[1] - p[1]) - (r[0] - p[0]) * (q[1] - p[1])) / 2;
    }
    return a;
  };
  const annulus = ringSectorGeometry(1, 2, { segments: 512 });
  close(area(annulus), Math.PI * 3, 1e-3);
  for (let i = 1; i < annulus.normals.length; i += 3) close(annulus.normals[i], 1);
  assertOutward(annulus);
  const quarter = ringSectorGeometry(0, 1, { sweep: Math.PI / 2, segments: 256 });
  close(area(quarter), Math.PI / 4, 1e-4);
  assertOutward(quarter);
  const solid = ringSectorGeometry(1, 2, { depth: 0.5, segments: 256 });
  assertClosed(solid);
  close(volume(solid), Math.PI * 3 * 0.5, 2e-3);
  // Exponent 8 is nearly a square of side 2: area near 4.
  assert.ok(area(ringSectorGeometry(0, 1, { exponent: 8, segments: 512 })) > 3.7);
  const arc = ringSectorGeometry(0.8, 1, { start: 0, sweep: Math.PI, depth: 0.1 });
  assertClosed(arc);
  assertOutward(arc);
});

test('scaleMarksGeometry: counts, major marks and placement for linear and radial scales', () => {
  const ruler = scaleMarksGeometry({ count: 11, spacing: 0.1, major: 5, length: 0.02, width: 0.002 });
  assert.equal(ruler.indices.length, 11 * 6);
  for (let i = 1; i < ruler.normals.length; i += 3) close(ruler.normals[i], 1);
  assertOutward(ruler);
  let minZ = Infinity;
  for (let i = 2; i < ruler.positions.length; i += 3) minZ = Math.min(minZ, ruler.positions[i]);
  close(minZ, -0.04); // a major mark is twice as long
  assert.equal(scaleMarksGeometry({ count: 11, major: 5, marks: 'major' }).indices.length, 3 * 6);
  assert.equal(scaleMarksGeometry({ count: 11, major: 5, marks: 'minor' }).indices.length, 8 * 6);
  const dial = scaleMarksGeometry({ kind: 'radial', count: 12, radius: 1, length: 0.1 });
  assertOutward(dial);
  let maxR = 0,
    minR = Infinity;
  for (let i = 0; i < dial.positions.length; i += 3) {
    const r = Math.hypot(dial.positions[i], dial.positions[i + 2]);
    maxR = Math.max(maxR, r);
    minR = Math.min(minR, r);
  }
  assert.ok(maxR < 1.0001 && maxR > 0.9999);
  assert.ok(minR > 0.79 && minR < 0.9);
});

test('arrowGeometry and gridSheetGeometry', () => {
  const arrow = arrowGeometry({ length: 1, radius: 0.02, headLength: 0.2, headRadius: 0.05, sides: 128 });
  assertClosed(arrow);
  assertOutward(arrow);
  close(volume(arrow), Math.PI * 0.0004 * 0.8 + (Math.PI * 0.0025 * 0.2) / 3, 1e-4);
  const sheet = gridSheetGeometry(4, 3, (u, v) => [u, 0, -v]);
  assert.equal(sheet.positions.length / 3, 20);
  assert.equal(sheet.indices.length, 4 * 3 * 6);
  for (let i = 1; i < sheet.normals.length; i += 3) close(sheet.normals[i], 1);
  assertOutward(sheet);
});

test('strokeGeometry: one quad per segment of the given width, facing the axis', () => {
  for (const [axis, k] of [
    ['x', 0],
    ['y', 1],
    ['z', 2],
  ]) {
    const s = strokeGeometry(
      [
        [[0, 0], [1, 0]],
        [[0, 0], [0, 2]],
        [[3, 3], [3, 3]],
      ],
      0.1,
      { axis },
    );
    assert.equal(s.indices.length, 12);
    for (let i = k; i < s.normals.length; i += 3) close(s.normals[i], 1);
    assertOutward(s);
  }
  const s = strokeGeometry([[[0, 0], [2, 0]]], 0.1, { axis: 'z' });
  let lo = Infinity,
    hi = -Infinity;
  for (let i = 1; i < s.positions.length; i += 3) (lo = Math.min(lo, s.positions[i])), (hi = Math.max(hi, s.positions[i]));
  close(hi - lo, 0.1);
});

test('extractGroups keeps the triangles of one material and only the vertices they use', () => {
  const a = chamferBoxGeometry(1, 1, 1),
    b = placeGeometry(tintGeometry(chamferBoxGeometry(1, 1, 1), [0, 1, 0]), { position: [3, 0, 0] });
  const both = mergeGeometries([a, b], true);
  const second = extractGroups(both, 1);
  assert.equal(second.indices.length, b.indices.length);
  assert.equal(second.positions.length, b.positions.length);
  assert.equal(second.colors.length, (second.positions.length / 3) * 4);
  close(volume(second), volume(b), 1e-6);
  assert.equal(extractGroups(both, 7).indices.length, 0);
  assert.equal(extractGroups(a, 0).indices.length, a.indices.length);
});

test('prismGeometry bevelHeight: a chamfer of different width and height', () => {
  const square = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ];
  const p = prismGeometry(square, 1, { axis: 'z', bevel: 0.1, bevelHeight: 0.05 });
  assertClosed(p);
  const frustum = (0.05 / 3) * (1.8 ** 2 + 4 + 1.8 * 2);
  close(volume(p), 4 * 0.9 + 2 * frustum, 1e-5);
  assert.throws(() => prismGeometry(square, 1, { bevel: 0.1, bevelHeight: 0.5 }), RangeError);
});
