import test from 'node:test';
import assert from 'node:assert/strict';
import { Spline } from '../dist/index.js';
import { KnotPath } from '../dist/knots.js';
import { SplineFrames, knotCount, parameterAt } from '../dist/frames.js';
import { closestPointOnSpline, distanceAt } from '../dist/closest.js';
import { placeAlongSpline, deformAlongSpline } from '../dist/mesh.js';
import { fitSpline } from '../dist/fit.js';

const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const dotv = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const wave = () =>
  new Spline(
    [
      [0, 0, 0],
      [4, 2, 1],
      [8, -1, 3],
      [12, 1, 6],
      [16, 0, 4],
    ],
    { divisions: 2000 },
  );

test('closest point matches a brute-force scan and returns consistent t and arc', () => {
  const curve = wave();
  let seed = 7;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 20 - 2;
  const scratch = new Float64Array(3);
  for (let n = 0; n < 40; n++) {
    const q = [rand(), rand(), rand()],
      hit = closestPointOnSpline(curve, q);
    let best = Infinity;
    for (let i = 0; i <= 20000; i++) best = Math.min(best, dist3(curve.at(i / 20000, scratch), q));
    assert.ok(hit.distance <= best + 1e-9, `${hit.distance} vs ${best}`);
    assert.ok(Math.abs(dist3(hit.point, q) - hit.distance) < 1e-12);
    assert.ok(Math.abs(dist3(curve.at(hit.t, scratch), hit.point)) < 1e-12);
    assert.ok(Math.abs(hit.arc - distanceAt(curve, hit.t)) < 1e-12);
    assert.ok(Math.abs(parameterAt(curve, hit.arc) - hit.t) < 1e-9);
  }
});

test('closest point on a straight line is the projection, ends clamp, bad input rejects', () => {
  const line = new Spline([
    [0, 0, 0],
    [10, 0, 0],
  ]);
  const hit = closestPointOnSpline(line, [3, 4, 0]);
  assert.ok(Math.abs(hit.t - 0.3) < 1e-9 && Math.abs(hit.distance - 4) < 1e-9 && Math.abs(hit.arc - 3) < 1e-6);
  assert.ok(closestPointOnSpline(line, [-5, 0, 0]).t < 1e-9);
  assert.ok(closestPointOnSpline(line, [50, 0, 0]).t > 1 - 1e-9);
  assert.throws(() => closestPointOnSpline(line, [NaN, 0, 0]), /finite/);
  assert.throws(() => closestPointOnSpline(line, [0, 0, 0], { samples: 1 }), /samples/);
});

test('closest point on a closed curve can land across the seam', () => {
  const loop = new Spline(
    [
      [1, 0, 0],
      [0, 0, 1],
      [-1, 0, 0],
      [0, 0, -1],
    ],
    { closed: true },
  );
  const hit = closestPointOnSpline(loop, [2, 0, 0.01]);
  assert.ok(dist3(hit.point, [1, 0, 0]) < 0.02);
});

test('frames are orthonormal, continuous and do not flip on a vertical loop that defeats a fixed up vector', () => {
  // A curve that rises straight up through the world up axis: a fixed up vector flips here.
  const curve = new Spline(
    [
      [0, 0, 0],
      [0, 3, 0.2],
      [0, 6, 0],
      [0.2, 9, 0],
      [0, 12, 0],
    ],
    { divisions: 1000 },
  );
  const frames = new SplineFrames(curve, { up: [0, 0, 1] });
  let prev = null;
  for (let i = 0; i <= 400; i++) {
    const f = frames.frameAt((i / 400) * curve.length);
    assert.ok(Math.abs(dotv(f.tangent, f.normal)) < 1e-9);
    assert.ok(Math.abs(dotv(f.tangent, f.binormal)) < 1e-9);
    assert.ok(Math.abs(Math.hypot(...f.normal) - 1) < 1e-9);
    assert.ok(Math.abs(Math.hypot(...f.binormal) - 1) < 1e-9);
    if (prev) assert.ok(dotv(prev, f.normal) > 0.99, `normal jumped at ${i}`);
    prev = Float64Array.from(f.normal);
  }
});

test('frames on a helix keep a constant angle to the curve; roll turns the frame about the tangent', () => {
  const pts = [];
  for (let i = 0; i <= 24; i++) pts.push([Math.cos(i * 0.4) * 3, i * 0.3, Math.sin(i * 0.4) * 3]);
  const helix = new Spline(pts, { divisions: 2000 });
  const plain = new SplineFrames(helix, { samples: 600 }),
    rolled = new SplineFrames(helix, { samples: 600, roll: (t) => Math.PI / 2 });
  for (const d of [0, helix.length / 3, helix.length]) {
    const a = plain.frameAt(d),
      b = rolled.frameAt(d);
    assert.ok(Math.abs(dotv(a.normal, b.normal)) < 1e-9, 'quarter turn between normals');
    assert.ok(dotv(b.normal, a.binormal) > 0.999999);
    assert.ok(Math.abs(dotv(b.tangent, a.tangent) - 1) < 1e-12);
  }
  const per = Array.from({ length: knotCount(helix) }, (_, i) => (i === 0 ? 0 : 1));
  const byKnot = new SplineFrames(helix, { roll: per });
  assert.equal(byKnot.rollAt(0), 0);
  assert.ok(Math.abs(byKnot.rollAt(1) - 1) < 1e-12);
  assert.ok(Math.abs(byKnot.rollAt(1 / 48) - 0.5) < 1e-9);
  assert.throws(() => new SplineFrames(helix, { roll: [0, 1] }), /roll needs/);
});

test('closed loops meet their own start frame once the twist is spread out', () => {
  const ring = [];
  for (let i = 0; i < 8; i++)
    ring.push([Math.cos((i * Math.PI) / 4) * 4, Math.sin((i * Math.PI) / 2) * 1.5, Math.sin((i * Math.PI) / 4) * 4]);
  const loop = new Spline(ring, { closed: true, divisions: 2000 });
  const frames = new SplineFrames(loop, { samples: 800 });
  const a = frames.frameAt(0),
    b = frames.frameAt(loop.length);
  assert.ok(dotv(a.normal, b.normal) > 0.999);
  const raw = new SplineFrames(loop, { samples: 800, closeLoop: false });
  const c = raw.frameAt(loop.length);
  assert.ok(dotv(a.normal, c.normal) <= dotv(a.normal, b.normal) + 1e-12);
});

test('straight-up tangent picks a valid starting normal', () => {
  const up = new Spline([
    [0, 0, 0],
    [0, 5, 0],
  ]);
  const f = new SplineFrames(up).frameAt(2);
  assert.ok(Math.abs(dotv(f.tangent, f.normal)) < 1e-9 && Math.abs(Math.hypot(...f.normal) - 1) < 1e-9);
});

test('knot paths: insertAt keeps the curve, remove and split behave, modes shape the handles', () => {
  const path = new KnotPath([
    { position: [0, 0, 0], data: [1] },
    { position: [4, 3, 0], data: [3] },
    { position: [8, 0, 0], data: [5] },
    { position: [12, 3, 2], data: [7] },
  ]);
  const before = path.toSpline({ divisions: 2000 });
  const index = path.insertAt(1, 0.4);
  assert.equal(index, 2);
  assert.equal(path.count, 5);
  const after = path.toSpline({ divisions: 2000 });
  assert.ok(Math.abs(after.length - before.length) < 1e-6);
  for (let i = 0; i <= 50; i++) {
    const p = before.at(i / 50, new Float64Array(3));
    assert.ok(closestPointOnSpline(after, p, { samples: 2000 }).distance < 1e-6);
  }
  assert.ok(Math.abs(path.knots[2].data[0] - (3 + 0.4 * 2)) < 1e-12);
  path.remove(2);
  assert.equal(path.count, 4);
  const [left, right] = path.split(2);
  assert.equal(left.count, 3);
  assert.equal(right.count, 2);
  assert.deepEqual(left.knots[2].position, right.knots[0].position);
  assert.throws(() => path.split(0), /interior/);
  assert.throws(() => new KnotPath([{ position: [0, 0, 0] }]), /needs/);
  assert.throws(() => path.insertAt(0, 1), /exclusive/);
  assert.throws(() => path.insert(9, { position: [0, 0, 0], data: [1] }), /index/);
  assert.throws(() => path.insert(0, { position: [0, 0, 0] }), /data/);
  const dataMid = path.dataAt(0.5);
  assert.ok(dataMid[0] > 1 && dataMid[0] < 7);
  assert.throws(() => path.dataAt(2), /0..1/);

  const linear = new KnotPath([
    { position: [0, 0, 0], mode: 'linear' },
    { position: [6, 0, 0], mode: 'linear' },
    { position: [6, 6, 0], mode: 'linear' },
  ]);
  const s = linear.toSpline();
  // A segment between two linear knots is a straight line.
  const m = s.at(0.25, new Float64Array(3));
  assert.ok(Math.abs(m[1]) < 1e-9 && Math.abs(m[0] - 3) < 1e-9);
  const corner = new KnotPath([
    { position: [0, 0, 0] },
    { position: [5, 0, 0], mode: 'broken', tangentIn: [-1, 0, 0], tangentOut: [0, 2, 0] },
    { position: [10, 0, 0] },
  ]);
  assert.deepEqual(corner.handles(1).tangentOut, [0, 2, 0]);
  corner.setMode(1, 'auto');
  assert.ok(corner.handles(1).tangentOut[0] > 0);
});

test('closed knot paths wrap, insert across the closing segment and split into one open path', () => {
  const ring = new KnotPath(
    [{ position: [0, 0, 0] }, { position: [4, 0, 0] }, { position: [4, 0, 4] }, { position: [0, 0, 4] }],
    { closed: true },
  );
  const spline = ring.toSpline();
  assert.deepEqual([...spline.at(0, new Float64Array(3))], [...spline.at(1, new Float64Array(3))]);
  assert.equal(ring.segments, 4);
  assert.equal(ring.insertAt(3, 0.5), 4);
  assert.equal(ring.count, 5);
  const [open] = ring.split(2);
  assert.equal(open.count, 6);
  assert.deepEqual(open.knots[0].position, open.knots[5].position);
  ring.remove(0);
  ring.remove(0);
  assert.throws(() => ring.remove(0), /at least 3/);
});

test('B-splines stay inside the control hull and clamp at the ends; Kochanek-Bartels at zero is Catmull-Rom', () => {
  const pts = [
    [0, 0, 0],
    [2, 4, 0],
    [4, 0, 0],
    [6, 4, 0],
    [8, 0, 0],
  ];
  const b = new Spline(pts, { kind: 'bspline' });
  assert.deepEqual([...b.at(0, new Float64Array(3))], [0, 0, 0]);
  assert.ok(Math.abs(b.at(1, new Float64Array(3))[0] - 8) < 1e-12);
  const out = new Float64Array(3);
  for (let i = 0; i <= 100; i++) {
    b.at(i / 100, out);
    assert.ok(out[1] >= -1e-9 && out[1] <= 4 + 1e-9);
  }
  // A uniform cubic B-spline joins segments with matching position and tangent (C2).
  const eps = 1e-6,
    left = b.at(0.25 - eps, new Float64Array(3)),
    right = b.at(0.25 + eps, new Float64Array(3));
  assert.ok(dist3(left, right) < 1e-4);
  const cr = new Spline(pts),
    kb = new Spline(pts, { kind: 'kochanek-bartels' });
  for (let i = 0; i <= 20; i++)
    assert.ok(dist3(cr.at(i / 20, new Float64Array(3)), kb.at(i / 20, new Float64Array(3))) < 1e-12);
  // The curve still passes through every point at any setting.
  const tight = new Spline(pts, { kind: 'kochanek-bartels', tension: 1, continuity: 0.5, bias: -0.5 });
  for (let k = 0; k < pts.length; k++) assert.ok(dist3(tight.at(k / 4, out), pts[k]) < 1e-12);
  assert.ok(tight.length < cr.length, 'full tension tightens the curve');
  // Tension 1 makes zero tangents, so a segment is a straight-ish ease between points.
  assert.throws(() => new Spline(pts, { kind: 'kochanek-bartels', tension: 2 }), RangeError);
  assert.throws(() => new Spline(pts, { kind: 'wiggle' }), RangeError);
  const closed = new Spline(pts, { kind: 'bspline', closed: true });
  assert.ok(dist3(closed.at(0, out), closed.at(1, new Float64Array(3))) < 1e-12);
});

test('placeAlongSpline spaces instances by arc length with orthonormal right-handed bases', () => {
  const curve = wave();
  const placed = placeAlongSpline(curve, { spacing: 2 });
  assert.equal(placed.count, Math.floor(curve.length / 2) + 1);
  const p = new Float64Array(3);
  for (let i = 0; i < placed.count; i++) {
    assert.ok(Math.abs(placed.distances[i] - i * 2) < 1e-12);
    const m = placed.matrices.subarray(i * 16, i * 16 + 16);
    curve.atDistance(placed.distances[i], p);
    assert.ok(dist3([m[12], m[13], m[14]], p) < 1e-4);
    const x = [m[0], m[1], m[2]],
      y = [m[4], m[5], m[6]],
      z = [m[8], m[9], m[10]];
    assert.ok(Math.abs(dotv(x, y)) < 1e-5 && Math.abs(dotv(y, z)) < 1e-5 && Math.abs(dotv(x, z)) < 1e-5);
    const cross = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
    assert.ok(dotv(cross, z) > 0.9999, 'right-handed');
    assert.ok(Math.abs(Math.hypot(...z) - 1) < 1e-5);
  }
  const fitted = placeAlongSpline(curve, { spacing: 3, fit: true });
  assert.ok(Math.abs(fitted.distances[fitted.count - 1] - curve.length) < 1e-9);
  const counted = placeAlongSpline(curve, {
    count: 5,
    start: 2,
    end: 10,
    forward: 'x',
    scale: [1, 2, 3],
    align: false,
  });
  assert.equal(counted.count, 5);
  assert.equal(counted.matrices[0], 1);
  assert.equal(counted.matrices[5], 2);
  assert.equal(counted.matrices[10], 3);
  assert.throws(() => placeAlongSpline(curve, {}), /exactly one/);
  assert.throws(() => placeAlongSpline(curve, { spacing: 0 }), /spacing/);
  assert.throws(() => placeAlongSpline(curve, { spacing: 1, end: 1e9 }), /end/);
  assert.throws(() => placeAlongSpline(curve, { spacing: 1, forward: 'q' }), /axis/);
});

test('every forward axis maps the mesh axis onto the tangent', () => {
  const line = new Spline([
    [0, 0, 0],
    [0, 0, 10],
  ]);
  for (const axis of ['x', 'y', 'z']) {
    const placed = placeAlongSpline(line, { count: 1, start: 5, forward: axis });
    const col = { x: 0, y: 4, z: 8 }[axis];
    assert.ok(Math.abs(placed.matrices[col + 2] - 1) < 1e-4, axis);
  }
});

test('deformAlongSpline bends a bar onto a quarter circle, keeps radius and stretches on request', () => {
  const r = 10,
    arc = [];
  for (let i = 0; i <= 32; i++) arc.push([r * Math.sin((i * Math.PI) / 64), 0, r * (1 - Math.cos((i * Math.PI) / 64))]);
  const curve = new Spline(arc, { divisions: 4000 });
  const verts = [],
    N = 60,
    L = curve.length;
  for (let i = 0; i <= N; i++)
    for (const [x, y] of [
      [0.5, 0],
      [-0.5, 0],
      [0, 0.5],
      [0, -0.5],
    ])
      verts.push(x, y, (i / N) * L);
  const bent = deformAlongSpline(curve, new Float32Array(verts), { frames: { up: [0, 1, 0] } });
  const out = bent.positions;
  assert.ok(out instanceof Float32Array);
  const centre = [0, 0, r];
  for (let i = 0; i <= N; i++) {
    // Offsets along the frame's third axis (the bar's local x) lie in the bend plane: radius r +- 0.5.
    const px = [out[i * 12], out[i * 12 + 1], out[i * 12 + 2]];
    const d = Math.hypot(px[0] - centre[0], px[2] - centre[2]);
    assert.ok(Math.abs(Math.abs(d - r) - 0.5) < 0.02, `radius ${d} at ring ${i}`);
    // Offsets along the frame normal (local y) stay vertical.
    assert.ok(Math.abs(out[i * 12 + 7] - 0.5) < 1e-3);
  }
  const stretched = deformAlongSpline(curve, new Float64Array([0, 0, 0, 0, 0, 2]), { fit: 'stretch' });
  assert.ok(dist3(stretched.positions.subarray(3), arc[32]) < 1e-3);
  const past = deformAlongSpline(curve, new Float64Array([0, 0, 0, 0, 0, L + 5]), { overflow: 'extend' });
  assert.ok(Math.abs(dist3(past.positions.subarray(3), arc[32]) - 5) < 1e-3);
  const held = deformAlongSpline(curve, new Float64Array([0, 0, 0, 0, 0, L + 5]), { overflow: 'clamp' });
  assert.ok(dist3(held.positions.subarray(3), arc[32]) < 1e-3);
  const normals = deformAlongSpline(curve, new Float64Array([0, 0, L, 0, 0, L]), {
    normals: new Float64Array([0, 0, 1, 1, 0, 0]),
  });
  assert.ok(Math.abs(Math.hypot(...normals.normals.subarray(3)) - 1) < 1e-9);
  assert.throws(() => deformAlongSpline(curve, new Float32Array(4)), /3 numbers/);
  assert.throws(() => deformAlongSpline(curve, new Float32Array([NaN, 0, 0])), /finite/);
});

test('fitSpline reduces a dense stroke to a few pieces within tolerance of every input point', () => {
  const src = new Spline(
    [
      [0, 0, 0],
      [3, 4, 0],
      [7, 3, 2],
      [10, -1, 4],
    ],
    { divisions: 2000 },
  );
  const dense = [];
  for (let i = 0; i <= 500; i++) dense.push([...src.at(i / 500, new Float64Array(3))]);
  const tolerance = 0.02;
  const fit = fitSpline(dense, { tolerance });
  assert.ok(fit.pieces <= 6, `pieces ${fit.pieces}`);
  assert.ok(fitSpline(dense, { tolerance: 0.5 }).pieces < fit.pieces, 'a looser tolerance needs fewer pieces');
  const one = new Spline(
      [
        [0, 0, 0],
        [2, 5, 1],
        [6, -4, 2],
        [9, 1, 0],
      ],
      { kind: 'bezier', divisions: 2000 },
    ),
    onePts = [];
  for (let i = 0; i <= 300; i++) onePts.push([...one.at(i / 300, new Float64Array(3))]);
  assert.equal(fitSpline(onePts, { tolerance: 0.01 }).pieces, 1, 'one cubic in, one cubic out');
  assert.equal(fit.points.length, (3 * fit.pieces + 1) * 3);
  assert.ok(fit.maxError <= tolerance);
  for (const p of dense) assert.ok(closestPointOnSpline(fit.spline, p, { samples: 2000 }).distance <= tolerance + 1e-6);
  assert.deepEqual([...fit.points.subarray(0, 3)], dense[0]);
  assert.deepEqual([...fit.points.subarray(fit.points.length - 3)], dense[500]);
});

test('fitSpline follows a noisy circle and a sharp corner, and a looser tolerance gives fewer pieces', () => {
  let seed = 3;
  const noise = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32 - 0.5) * 0.01;
  const circle = [];
  for (let i = 0; i <= 400; i++)
    circle.push([Math.cos(i * 0.0157) * 5 + noise(), Math.sin(i * 0.0157) * 5 + noise(), noise()]);
  const fine = fitSpline(circle, { tolerance: 0.05 }),
    coarse = fitSpline(circle, { tolerance: 0.3 });
  assert.ok(coarse.pieces <= fine.pieces);
  for (const p of circle) assert.ok(closestPointOnSpline(fine.spline, p, { samples: 4000 }).distance <= 0.05 + 1e-6);
  const corner = [];
  for (let i = 0; i <= 50; i++) corner.push([i * 0.2, 0, 0]);
  for (let i = 1; i <= 50; i++) corner.push([10, i * 0.2, 0]);
  const cf = fitSpline(corner, { tolerance: 0.05 });
  for (const p of corner) assert.ok(closestPointOnSpline(cf.spline, p, { samples: 4000 }).distance <= 0.05 + 1e-6);
  assert.throws(() => fitSpline(corner, { tolerance: 0 }), /tolerance/);
  assert.throws(() => fitSpline([[0, 0, 0]], { tolerance: 1 }), /2 to/);
  assert.throws(
    () =>
      fitSpline(
        [
          [0, 0, 0],
          [0, 0, 0],
        ],
        { tolerance: 1 },
      ),
    /distinct/,
  );
  assert.throws(
    () =>
      fitSpline(
        [
          [0, 0, 0],
          [1, NaN, 0],
        ],
        { tolerance: 1 },
      ),
    /finite/,
  );
  const two = fitSpline(
    [
      [0, 0, 0],
      [3, 0, 0],
    ],
    { tolerance: 0.1 },
  );
  assert.equal(two.pieces, 1);
  assert.ok(Math.abs(two.spline.length - 3) < 1e-9);
});
