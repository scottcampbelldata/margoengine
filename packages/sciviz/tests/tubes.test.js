import test from 'node:test';
import assert from 'node:assert/strict';
import { streamTubeGeometry, streamRibbonGeometry, streamMeshTriangles, traceStreamPath, streamTubeColors } from '@margoengine/sciviz/tubes';

const close = (a, b, epsilon = 2e-6) => assert.ok(Math.abs(a - b) < epsilon, `${a} != ${b}`);
const straight = { positions: new Float64Array([0, 0, 0, 2, 0, 0]), scalar: [3, 9] };
function valid(mesh) {
  assert.equal(mesh.positions.length, mesh.normals.length);
  assert.equal(mesh.values.length * 3, mesh.positions.length);
  assert.equal(mesh.uvs.length, mesh.values.length * 2);
  assert(mesh.positions.every(Number.isFinite));
  assert(mesh.normals.every(Number.isFinite));
  for (let i = 0; i < mesh.normals.length; i += 3) close(Math.hypot(...mesh.normals.subarray(i, i + 3)), 1);
  assert(mesh.indices.every((i) => i < mesh.values.length));
}

test('scalar-radius tube follows an analytical cone, with smooth outward taper normals and owned inputs', () => {
  const input = straight.positions.slice();
  const mesh = streamTubeGeometry(straight, { radius: [1, 2], sides: 16, steps: 8, caps: false });
  valid(mesh);
  assert.deepEqual(straight.positions, input);
  for (let row = 0; row <= 8; row++) {
    const x = row / 4, radius = 1 + x / 2;
    for (let side = 0; side <= 16; side++) {
      const i = row * 17 + side, p = mesh.positions.subarray(i * 3, i * 3 + 3), n = mesh.normals.subarray(i * 3, i * 3 + 3);
      close(p[0], x); close(Math.hypot(p[1], p[2]), radius);
      close(mesh.values[i], 3 + 3 * x);
      assert(n[1] * p[1] + n[2] * p[2] > 0, 'normal faces away from the axis');
      close(n[0] + (n[1] * p[1] + n[2] * p[2]) / radius / 2, 0);
    }
  }
  assert.deepEqual(Array.from(mesh.positions.subarray(0, 3)), Array.from(mesh.positions.subarray(16 * 3, 17 * 3)));
  mesh.positions.fill(0);
  assert.deepEqual(straight.positions, input);
});

test('caps keep endpoint scalars, including a single cap when the opposite radius is zero', () => {
  for (const radius of [[1, 2], [0, 2], [1, 0]]) {
    const mesh = streamTubeGeometry(straight, { radius, sides: 8, steps: 4 });
    valid(mesh);
    const caps = mesh.groups.find((g) => g.materialIndex === 0);
    assert(caps);
    for (let j = caps.start; j < caps.start + caps.count; j++) {
      const i = mesh.indices[j], x = mesh.positions[i * 3];
      close(mesh.values[i], x === 0 ? 3 : 9);
      close(Math.abs(mesh.normals[i * 3]), 1);
    }
  }
});

test('ribbon spin uses half vorticity divided by speed, with a quadratic partial integral', () => {
  const path = { positions: [0, 0, 0, 0, 0, 2] };
  for (const omega of [[2, 2], [0, 4]]) {
    const mesh = streamRibbonGeometry(path, { steps: 8, width: 2, streamwiseVorticity: omega, speeds: [1, 1] });
    valid(mesh);
    for (let row = 0; row <= 8; row++) {
      const s = row / 4, angle = omega[0] === 2 ? s : s * s / 2;
      const p = mesh.positions.subarray((row * 2 + 1) * 3, (row * 2 + 2) * 3);
      close(p[0], Math.cos(angle)); close(p[1], Math.sin(angle)); close(p[2], s);
    }
  }
  const reverse = streamRibbonGeometry(path, { steps: 8, width: 2, streamwiseVorticity: [-2, -2], speeds: [1, 1] });
  close(reverse.positions[reverse.positions.length - 2], -Math.sin(2));
});

test('transported frames cross an inflection without flips and closed tube positions/normals share a seam', () => {
  const positions = Array.from({ length: 41 }, (_, i) => {
    const t = (i - 20) / 10; return [t, t * t * t / 4, 0];
  }).flat();
  const ribbon = streamRibbonGeometry({ positions }, { steps: 80 }); valid(ribbon);
  for (let i = 2; i < ribbon.values.length; i += 2) {
    let dot = 0;
    for (let c = 0; c < 3; c++) dot += ribbon.normals[i * 3 + c] * ribbon.normals[(i - 2) * 3 + c];
    assert(dot > 0.95, `inflection normal flipped at ${i}`);
  }
  const loop = Array.from({ length: 65 }, (_, i) => i === 64 ? [1, 0, 0] :
    [Math.cos(i * Math.PI / 32), Math.sin(i * Math.PI / 32), 0.2 * Math.sin(i * Math.PI / 8)]).flat();
  const tube = streamTubeGeometry({ positions: loop }, { closed: true, steps: 128, radius: 0.03, sides: 8 }); valid(tube);
  assert.deepEqual(tube.positions.slice(0, 27), tube.positions.slice(-27));
  assert.deepEqual(tube.normals.slice(0, 27), tube.normals.slice(-27));
});

test('sampling uses actual polyline arc length and carries scalars on unequal intervals', () => {
  const mesh = streamTubeGeometry({ positions: [0, 0, 0, 1, 0, 0, 3, 0, 0], scalar: [0, 1, 5] },
    { steps: 6, sides: 4, caps: false });
  for (let row = 0; row <= 6; row++) {
    const x = row / 2; close(mesh.positions[row * 15], x);
    close(mesh.values[row * 5], x < 1 ? x : 1 + 2 * (x - 1));
  }
});

test('hostile inputs, resource limits, reversing cusps, physical speeds and exact cancellation reject', () => {
  for (const positions of [[], [0, 0], [0, 0, 0, 0, 0, 0], [0, 0, 0, NaN, 1, 0], [0, 0, 0, Infinity, 0, 0],
    [0, 0, 0, 1, 0, 0, 0, 0, 0]]) assert.throws(() => streamTubeGeometry({ positions }), /https:/);
  for (const options of [{ steps: Infinity }, { sides: 2 }, { radius: -1 }, { radius: [1] }, { radius: [0, 0] },
    { closed: true }, { steps: 16384, sides: 128 }]) assert.throws(() => streamTubeGeometry(straight, options), /https:/);
  for (const options of [{ speeds: [0, 1] }, { streamwiseVorticity: [1, 1] }, { angle: Infinity }])
    assert.throws(() => streamRibbonGeometry(straight, options), /https:/);
  const reason = { cancelled: 171 }, signal = AbortSignal.abort(reason);
  assert.throws(() => streamTubeGeometry(straight, { signal }), (e) => e === reason);
  assert.throws(() => streamRibbonGeometry(straight, { signal }), (e) => e === reason);
});

test('existing scientific mesh renderer adapter keeps every corner normal/value and snapshots its arrays', () => {
  const mesh = streamTubeGeometry(straight, { radius: [1, 2], steps: 4, sides: 8 }), set = streamMeshTriangles(mesh);
  assert.equal(set.cells.length * 9, set.positions.length);
  for (let i = 0; i < mesh.indices.length; i++) {
    const v = mesh.indices[i];
    assert.deepEqual(set.positions.slice(3 * i, 3 * i + 3), mesh.positions.slice(3 * v, 3 * v + 3));
    assert.deepEqual(set.normals.slice(3 * i, 3 * i + 3), mesh.normals.slice(3 * v, 3 * v + 3));
    assert.equal(set.values[i], mesh.values[v]);
  }
  assert.deepEqual(set.bounds, [0, 2, -2, 2, -2, 2]);
  mesh.positions.fill(0); assert(set.positions.some((x) => x !== 0));
  mesh.indices[0] = mesh.values.length; assert.throws(() => streamMeshTriangles(mesh), /https:/);
  const reason = { cancel: true };
  assert.throws(() => streamMeshTriangles(mesh, { signal: AbortSignal.abort(reason) }), (e) => e === reason);
});

test('traceStreamPath follows an exact helix and ends on the box face it leaves', () => {
  // v = (1, -z, y): x = t, (y, z) turns at unit rate on its circle. Exact: y = r cos t, z = r sin t for seed (0, r, 0).
  const r = 0.5, path = traceStreamPath(([, y, z]) => [1, -z, y], [0, r, 0], { bounds: [0, 6, -2, 2, -2, 2], maxStep: 0.4 });
  const n = path.scalar.length;
  assert.ok(n > 10 && n < 200, String(n));
  for (let i = 0; i < n; i++) {
    const t = path.times[i], [x, y, z] = path.positions.subarray(i * 3, i * 3 + 3);
    close(x, t, 1e-6);
    close(y, r * Math.cos(t), 1e-5);
    close(z, r * Math.sin(t), 1e-5);
    close(path.scalar[i], Math.hypot(1, r), 1e-5);
  }
  close(path.positions[(n - 1) * 3], 6, 1e-9);
  const back = traceStreamPath(([, y, z]) => [1, -z, y], [3, r, 0], { backward: true, bounds: [0, 6, -2, 2, -2, 2] });
  close(back.positions[back.positions.length - 3], 0, 1e-9);
  close(back.times[back.times.length - 1], -3, 1e-6);
  // A stagnation point stops the trace; a null velocity (outside the data) stops it too.
  const sink = traceStreamPath(([x]) => [-x, 0, 0], [1, 0, 0], { minSpeed: 1e-3, maxStep: 1 });
  assert.ok(sink.scalar[sink.scalar.length - 1] < 1e-3 * 1.0001 + 1e-3);
  const edge = traceStreamPath(([x]) => (x < 2 ? [1, 0, 0] : null), [0, 0, 0]);
  assert.ok(edge.positions[edge.positions.length - 3] <= 2);
  assert.throws(() => traceStreamPath(() => [1, 0, 0], [0, 0, Number.NaN]), RangeError);
  assert.throws(() => traceStreamPath(() => [1, 0, 0], [0, 0, 0], { bounds: [1, 0, 0, 1, 0, 1] }), RangeError);
  const tube = streamTubeGeometry(path, { radius: 0.05 });
  valid(tube);
});

test('streamTubeColors maps speed through OKLab stops to linear rgba', () => {
  const mesh = { values: [0, 0.5, 1, 2] };
  const c = streamTubeColors(mesh, { range: [0, 1], colors: ['#000000', '#ffffff'] });
  assert.equal(c.length, 16);
  close(c[0], 0, 1e-6);
  close(c[8], 1, 1e-5);
  close(c[12], 1, 1e-5);
  close(c[3], 1);
  // OKLab midpoint of black and white has lightness 0.5, which is linear 0.125.
  close(c[4], 0.125, 1e-4);
  assert.throws(() => streamTubeColors(mesh, { colors: ['#fff'] }), RangeError);
});
