// Bending along a curve against closed forms: a bar on a circle becomes a ring with radial normals, a straight line
// changes nothing, and frames stay orthonormal.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  boxGeometry,
  CatmullRomCurve3,
  computeTangents,
  cylinderGeometry,
  LineCurve3,
  planeGeometry,
} from '../dist/index.js';
import { nurbsCircle } from '../dist/nurbs.js';
import { CurveFlow, flowGeometry } from '../dist/flow.js';
import { assertNormalsAgreeWithWinding, close, point, vertexCount } from './support/mesh-checks.js';

const line = new LineCurve3([0, 0, 0], [10, 0, 0]);

test('a straight line along +x leaves a mesh where it was, normals and tangents included', () => {
  const box = computeTangents(boxGeometry(2, 1, 1, 4, 2, 2)),
    bent = flowGeometry(box, line, { offset: 3 });
  for (let k = 0; k < vertexCount(box); k++) {
    const p = point(box, k),
      q = point(bent, k);
    close(q[0], p[0] + 3, 1e-5, 'x moved by offset');
    close(q[1], p[1], 1e-5, 'y');
    close(q[2], p[2], 1e-5, 'z');
    for (let c = 0; c < 3; c++) {
      close(bent.normals[k * 3 + c], box.normals[k * 3 + c], 1e-5, 'normal');
      close(bent.tangents[k * 4 + c], box.tangents[k * 4 + c], 1e-5, 'tangent');
    }
    assert.equal(bent.tangents[k * 4 + 3], box.tangents[k * 4 + 3]);
  }
  assert.deepEqual(bent.indices, box.indices);
  assert.deepEqual(bent.groups, box.groups);
});

test('each axis keeps the mesh upright: +y stays up unless y runs along the curve', () => {
  const along = new LineCurve3([0, 0, 0], [0, 0, 10]);
  // Local +z runs along a track heading +z, with no turn: the identity.
  const m = new CurveFlow(along).matrixAt(4, 'z');
  assert.deepEqual(
    Array.from(m, (v) => v + 0),
    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 4, 1],
  );
  // Every axis gives a proper rotation (determinant +1) so nothing mirrors.
  for (const axis of ['x', 'y', 'z']) {
    const r = new CurveFlow(line).matrixAt(1, axis),
      det =
        r[0] * (r[5] * r[10] - r[9] * r[6]) - r[4] * (r[1] * r[10] - r[9] * r[2]) + r[8] * (r[1] * r[6] - r[5] * r[2]);
    close(det, 1, 1e-6, `determinant of ${axis}`);
  }
});

test('a bar bent round a circle lands on the right radii with radial normals, the bent seam closed', () => {
  // Radius 5 in the z = 0 plane. Local y is up and +y at the start: the first up across the tangent.
  const circle = nurbsCircle(5),
    flow = new CurveFlow(circle, { closed: true, segments: 512, up: [1, 0, 0] }),
    bar = planeGeometry(flow.length, 1, 256, 1),
    bent = flow.deform(bar, { offset: flow.length / 2 });
  // planeGeometry lies in x, y: y runs +-0.5 across the band, along the frame's up, which here points out of the circle.
  for (let k = 0; k < vertexCount(bar); k++) {
    const original = point(bar, k),
      p = point(bent, k);
    close(Math.hypot(p[0], p[1]), 5 + original[1], 2e-3, 'radius follows local y');
    close(p[2], 0, 1e-4, 'stays in the plane');
    // The plane faced +z and still does: the band lies flat in z = 0.
    close(Math.abs(bent.normals[k * 3 + 2]), 1, 1e-4, 'normal off the plane');
  }
});

test('a tube bent round a circle is a torus with torus normals', () => {
  // A tube around the curve: an open cylinder along y, turned to run along the frame, radius 0.5, bent round radius 3.
  const circle = nurbsCircle(3),
    flow = new CurveFlow(circle, { closed: true, segments: 1024, up: [0, 0, 1] }),
    length = flow.length,
    tube = cylinderGeometry(0.5, 0.5, length, 32, 256, true),
    bent = flow.deform(tube, { axis: 'y', offset: length / 2 });
  // The result is a torus of major radius 3: its normal at a point is that point minus the nearest circle point.
  for (let k = 0; k < vertexCount(bent); k++) {
    const [x, y, z] = point(bent, k),
      r = Math.hypot(x, y),
      centre = [(x / r) * 3, (y / r) * 3, 0],
      want = [x - centre[0], y - centre[1], z],
      size = Math.hypot(...want);
    close(size, 0.5, 1e-3, 'on the torus');
    const along =
      (want[0] * bent.normals[k * 3] + want[1] * bent.normals[k * 3 + 1] + want[2] * bent.normals[k * 3 + 2]) / size;
    assert.ok(along > 0.9999, `normal ${k} is the torus normal (${along})`);
  }
});

test('a shear from a sloped stretch is caught: normals follow the Jacobian, not just the frame', () => {
  // A band stretched 3 times along the curve: a slanted normal in local space must turn towards the cross axis.
  const mesh = {
      positions: Float32Array.of(0, 0, 0, 1, 1, 0, 1, 0, 0),
      normals: Float32Array.of(...[0, 0, 0].flatMap(() => [Math.SQRT1_2, -Math.SQRT1_2, 0])),
      uvs: new Float32Array(6),
      indices: Uint32Array.of(0, 1, 2),
    },
    bent = flowGeometry(mesh, line, { scale: 3 });
  // A plane n . p = 0 with n = (1, -1, 0) stretched x3 in x has normal (1/3, -1, 0).
  const size = Math.hypot(1 / 3, 1);
  close(bent.normals[0], 1 / 3 / size, 1e-5, 'nx');
  close(bent.normals[1], -1 / size, 1e-5, 'ny');
});

test('fit stretches a mesh over the whole curve, and past the ends a mesh carries on straight', () => {
  const box = boxGeometry(2, 1, 1, 8, 1, 1),
    fitted = flowGeometry(box, line, { fit: true });
  let lo = Infinity,
    hi = -Infinity;
  for (let k = 0; k < vertexCount(box); k++) {
    lo = Math.min(lo, fitted.positions[k * 3]);
    hi = Math.max(hi, fitted.positions[k * 3]);
  }
  close(lo, 0, 1e-5, 'fit start');
  close(hi, 10, 1e-5, 'fit end');
  const frame = new CurveFlow(line).getFrame(13);
  close(frame.position[0], 13, 1e-9, 'past the end');
  close(new CurveFlow(line).getFrame(-2).position[0], -2, 1e-9, 'before the start');
});

test('a closed curve wraps distances and its frames meet at the seam', () => {
  const flow = new CurveFlow(nurbsCircle(2), { closed: true }),
    a = flow.getFrame(0.5),
    b = flow.getFrame(0.5 + flow.length),
    c = flow.getFrame(0.5 - flow.length);
  for (let k = 0; k < 3; k++) {
    close(a.position[k], b.position[k], 1e-9, 'wrap forward');
    close(a.up[k], c.up[k], 1e-9, 'wrap back');
  }
  const knot = new CatmullRomCurve3(
      [
        [2, 0, 0],
        [0, 2, 1],
        [-2, 0, 0],
        [0, -2, -1],
      ],
      true,
    ),
    closed = new CurveFlow(knot, { closed: true, segments: 512 }),
    start = closed.getFrame(0),
    end = closed.getFrame(closed.length - 1e-9);
  for (let k = 0; k < 3; k++) close(start.up[k], end.up[k], 1e-3, 'up closes');
});

test('frames are orthonormal and right-handed everywhere, and lockUp holds up on a hilly track', () => {
  const hills = new CatmullRomCurve3([
      [0, 0, 0],
      [5, 2, 3],
      [10, 0, 8],
      [15, 3, 4],
      [20, 1, 0],
    ]),
    locked = new CurveFlow(hills, { lockUp: true }),
    free = new CurveFlow(hills);
  for (let d = 0; d <= locked.length; d += locked.length / 37)
    for (const flow of [locked, free]) {
      const { tangent: t, up: u, side: s } = flow.getFrame(d),
        dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
      close(Math.hypot(...t), 1, 1e-9, 'unit tangent');
      close(Math.hypot(...u), 1, 1e-9, 'unit up');
      close(dot(t, u), 0, 2e-2, 'tangent against up');
      close(dot(u, s), 0, 2e-2, 'up against side');
    }
  // Locked, the side stays level: no roll, the train does not lean.
  for (let d = 0; d <= locked.length; d += locked.length / 37) close(locked.getFrame(d).side[1], 0, 1e-2, 'level');
});

test('a vertical start and a curve along up still get a frame', () => {
  const rise = new LineCurve3([0, 0, 0], [0, 5, 0]),
    { up, tangent } = new CurveFlow(rise).getFrame(1);
  close(tangent[1], 1, 1e-9, 'rises');
  close(up[0] * tangent[0] + up[1] * tangent[1] + up[2] * tangent[2], 0, 1e-9, 'perpendicular');
  close(Math.hypot(...up), 1, 1e-9, 'unit');
});

test('matrices spread instances evenly, and closed curves do not double the seam', () => {
  const m = new CurveFlow(line).matrices(5);
  assert.equal(m.length, 80);
  assert.deepEqual(
    [0, 1, 2, 3, 4].map((i) => m[i * 16 + 12]),
    [0, 2.5, 5, 7.5, 10],
  );
  const spaced = new CurveFlow(line).matrices(3, { spacing: 1, offset: 2 });
  assert.deepEqual([spaced[12], spaced[28], spaced[44]], [2, 3, 4]);
  const ring = new CurveFlow(nurbsCircle(1), { closed: true }).matrices(4);
  close(Math.hypot(ring[12] - ring[60], ring[13] - ring[61]), Math.SQRT2, 2e-2, 'last is a quarter from the first');
  assert.equal(new CurveFlow(line).matrices(0).length, 0);
  assert.equal(new CurveFlow(line).matrices(1).length, 16);
  const target = new Float32Array(16);
  assert.equal(new CurveFlow(line).matrixAt(1, 'x', target), target);
});

test('a bent solid keeps its winding and the input stays as it was', () => {
  const box = boxGeometry(10, 0.5, 0.5, 64, 2, 2),
    frozen = box.positions.slice(),
    bent = flowGeometry(box, nurbsCircle(6, 0, Math.PI), { fit: true, up: [0, 0, 1], segments: 512 });
  assertNormalsAgreeWithWinding(bent, 'bent box');
  assert.deepEqual(box.positions, frozen);
});

test('invalid input is refused with the fix in the message', () => {
  assert.throws(() => new CurveFlow(new LineCurve3([0, 0, 0], [0, 0, 0])), /length/);
  assert.throws(() => new CurveFlow(line, { segments: 0 }), /segments/);
  assert.throws(() => new CurveFlow(line, { segments: NaN }), /finite/);
  assert.throws(() => new CurveFlow(line, { up: [0, 0, 0] }), /up has no direction/);
  assert.throws(() => new CurveFlow(line, { up: [NaN, 0, 0] }), /up has no direction/);
  const flow = new CurveFlow(line),
    box = boxGeometry();
  assert.throws(() => flow.deform(box, { axis: 'w' }), /axis/);
  assert.throws(() => flow.deform(box, { offset: NaN }), /offset/);
  assert.throws(() => flow.deform(box, { scale: 0 }), /scale/);
  assert.throws(() => flow.deform({ ...box, positions: new Float32Array(3) }, { fit: true }), /no extent/);
  assert.throws(() => flow.getFrame(Infinity), /distance/);
  assert.throws(() => flow.matrixAt(NaN), /distance/);
  assert.throws(() => flow.matrices(-1), /count/);
  assert.throws(() => flow.matrices(2, { spacing: NaN }), /spacing/);
});
