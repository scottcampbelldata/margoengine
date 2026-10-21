// Checked contracts for saved data: interpolateQuaternions (quat), transformPointChecked (mat4) and decomposeAffine
// (affine). The reference functions below are copied from Margo Voxel Studio's frozen code (src/editor/animation.ts
// slerpQuaternion, src/editor/scene.ts transformPoint, src/io/glb-animation.ts matrixPose) so the engine contracts
// are checked against the exact arithmetic the app saved with.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Matrix4, Quaternion, Vector3 } from '../dist/index.js';
import { interpolateQuaternions } from '../dist/quat.js';
import { multiplyMatrices, transformPointChecked } from '../dist/mat4.js';
import { decomposeAffine } from '../dist/affine.js';
import { createLcgRandom } from '../dist/mathutils.js';

// --- Studio references (verbatim arithmetic, reformatted) ---
function studioSlerp(a, b, t) {
  let dot = a.reduce((sum, value, index) => sum + value * b[index], 0),
    end = [...b];
  if (dot < 0) {
    end = end.map((value) => -value);
    dot = -dot;
  }
  dot = Math.min(1, Math.max(-1, dot));
  let result;
  if (dot > 0.9995) result = a.map((value, index) => value + (end[index] - value) * t);
  else {
    const angle = Math.acos(dot),
      sin = Math.sin(angle),
      left = Math.sin((1 - t) * angle) / sin,
      right = Math.sin(t * angle) / sin;
    result = a.map((value, index) => value * left + end[index] * right);
  }
  const length = Math.hypot(...result);
  return result.map((value) => value / length);
}
function studioTransformPoint(matrix, point) {
  if (matrix.length !== 16) throw new RangeError('A 4×4 matrix requires sixteen values.');
  const [x, y, z] = point,
    w = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
  if (!Number.isFinite(w) || Math.abs(w) < 1e-12) throw new RangeError('Point cannot be projected by this matrix.');
  return [0, 1, 2].map((row) => (matrix[row] * x + matrix[4 + row] * y + matrix[8 + row] * z + matrix[12 + row]) / w);
}
function studioMatrixPose(matrix) {
  const m = new Matrix4().fromArray(matrix),
    position = new Vector3(),
    rotation = new Quaternion(),
    scale = new Vector3();
  m.decompose(position, rotation, scale);
  rotation.normalize();
  if (!new Matrix4().compose(position, rotation, scale).equals(m, 1e-5))
    throw new RangeError('Animated source placement contains shear; keep native parent TRS separate.');
  return { translation: position.toArray(), rotation: rotation.toArray(), scale: scale.toArray() };
}

const random = createLcgRandom(20261020);
const unitQuaternion = () => new Quaternion(random() - 0.5, random() - 0.5, random() - 0.5, random() - 0.5).normalize();
const near = (actual, expected, tolerance, label = '') =>
  expected.forEach((value, i) =>
    assert.ok(Math.abs(actual[i] - value) <= tolerance, `${label}[${i}] ${actual[i]} != ${value}`),
  );

test('interpolateQuaternions(…, 0.9995) reproduces the Studio close-angle regression; Quaternion.slerp keeps its curve', () => {
  // src/editor/current-main-formats.test.ts, "legacy close-angle interpolation remains frozen".
  const start = [0, 0, 0, 1],
    end = [Math.sin(0.025), 0, 0, Math.cos(0.025)];
  const legacy = studioSlerp(start, end, 0.25),
    engine = interpolateQuaternions(start, end, 0.25, 0.9995),
    current = new Quaternion().fromArray(start).slerp(new Quaternion().fromArray(end), 0.25).toArray();
  near(engine, legacy, 1e-8, 'close angle');
  assert.deepEqual(engine, legacy); // and in fact bit for bit
  assert.ok(Math.abs(legacy[0] - current[0]) > 1e-8, 'the default slerp still follows its own curve');
});

test('interpolateQuaternions matches the Studio curve bit for bit on both branches, either hemisphere and the ends', () => {
  let linear = 0,
    spherical = 0;
  for (let i = 0; i < 2000; i++) {
    const a = unitQuaternion().toArray(),
      // Half the pairs within ~0.03 rad (the linear branch), some on the far hemisphere.
      b = (
        i & 1
          ? unitQuaternion()
          : new Quaternion()
              .fromArray(a)
              .multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), (random() - 0.5) * 0.06))
      )
        .toArray()
        .map((v) => (i % 3 === 0 ? -v : v)),
      t = [0, 1, 0.5, random()][i & 3];
    const dot = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
    if (dot > 0.9995) linear++;
    else spherical++;
    assert.deepEqual(interpolateQuaternions(a, b, t, 0.9995), studioSlerp(a, b, t), `pair ${i} t=${t}`);
  }
  assert.ok(linear > 200 && spherical > 200, `both branches exercised (${linear} linear, ${spherical} spherical)`);
  const q = interpolateQuaternions([0, 0, 0, 2], [0, 0, 0, -1], 0.5, 0.9995);
  assert.deepEqual(q, [0, 0, 0, 1], 'normalized output, b taken on a side');
  for (const bad of [1, -0.1, Number.NaN, 2])
    assert.throws(() => interpolateQuaternions([0, 0, 0, 1], [0, 0, 0, 1], 0.5, bad), RangeError);
});

test('transformPointChecked matches the Studio transformPoint bit for bit and returns failures instead of throwing', () => {
  // src/editor/scene.test.ts: T·Rx·Ry·Rz·S built with the engine, as Float32 like modelLocalMatrix.
  const local = (p, r, s) =>
    [
      new Matrix4().makeTranslation(...p).elements,
      new Matrix4().makeRotationX(r[0]).elements,
      new Matrix4().makeRotationY(r[1]).elements,
      new Matrix4().makeRotationZ(r[2]).elements,
      new Matrix4().makeScale(...s).elements,
    ].reduce((a, b) => multiplyMatrices(a, b, new Float32Array(16)));
  const first = transformPointChecked(local([10, 20, 30], [0, 0, Math.PI / 2], [2, 3, 4]), [1, 0, 0]);
  assert.equal(first.ok, true);
  near(first.point, [10, 22, 30], 1e-5);
  near(
    transformPointChecked(local([0, 0, 0], [Math.PI / 2, Math.PI / 2, 0], [1, 1, 1]), [0, 1, 0]).point,
    [0, 0, 1],
    1e-5,
  );
  for (let i = 0; i < 2000; i++) {
    const m = Array.from({ length: 16 }, () => (random() - 0.5) * 8),
      p = [random() * 100 - 50, random() * 100 - 50, random() * 100 - 50];
    if (i & 1) m.splice(3, 1, 0), m.splice(7, 1, 0), m.splice(11, 1, 0), m.splice(15, 1, 1); // affine half
    const checked = transformPointChecked(new Float32Array(m), p);
    let expected;
    try {
      expected = studioTransformPoint(new Float32Array(m), p);
    } catch {
      expected = undefined;
    }
    if (expected) assert.deepEqual(checked, { ok: true, point: expected, w: checked.w }, `case ${i}`);
    else assert.equal(checked.ok, false, `case ${i}`);
  }
});

test('transformPointChecked failure reasons and its configurable |w| tolerance', () => {
  const m = new Matrix4().elements.slice();
  m[15] = 0;
  assert.deepEqual(transformPointChecked(m, [1, 2, 3]), { ok: false, reason: 'w-small', w: 0 });
  m[15] = 1e-13;
  assert.equal(transformPointChecked(m, [1, 2, 3]).reason, 'w-small');
  assert.equal(transformPointChecked(m, [1, 2, 3], 1e-14).ok, true);
  m[15] = 1e-12;
  assert.equal(transformPointChecked(m, [1, 2, 3]).ok, true, '|w| equal to the tolerance is accepted (Studio rule)');
  const projective = new Matrix4().elements.slice();
  projective[3] = 1;
  assert.equal(transformPointChecked(projective, [Number.POSITIVE_INFINITY, 0, 0]).reason, 'w-nonfinite');
  assert.equal(transformPointChecked(projective, [Number.NaN, 0, 0]).reason, 'w-nonfinite');
  const huge = new Matrix4().makeScale(1e308, 1, 1).setPosition(1e308, 0, 0).elements;
  assert.deepEqual(transformPointChecked(huge, [1, 0, 0]), { ok: false, reason: 'point-nonfinite', w: 1 });
  assert.throws(() => transformPointChecked([1, 0, 0], [0, 0, 0]), TypeError);
  assert.throws(() => transformPointChecked(m, [0, 0]), TypeError);
  for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY])
    assert.throws(() => transformPointChecked(m, [0, 0, 0], bad), RangeError);
});

test('decomposeAffine gives Matrix4.decompose numbers and the Studio lossless verdict', () => {
  for (let i = 0; i < 1000; i++) {
    const kind = i % 4,
      t = new Vector3(random() * 200 - 100, random() * 200 - 100, random() * 200 - 100),
      q = unitQuaternion(),
      s = new Vector3(0.1 + random() * 4, 0.1 + random() * 4, (0.1 + random() * 4) * (kind === 1 ? -1 : 1)),
      m = new Matrix4().compose(t, q, s);
    if (kind === 2)
      m.multiply(
        new Matrix4().set(1, (random() - 0.5) * 0.5, 0, 0, 0, 1, (random() - 0.5) * 0.5, 0, 0, 0, 1, 0, 0, 0, 0, 1),
      ); // shear
    if (kind === 3) m.multiply(new Matrix4().set(1, 1e-9, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)); // shear under tolerance
    const elements = i & 1 ? new Float32Array(m.elements) : m.elements,
      result = decomposeAffine(elements),
      position = new Vector3(),
      rotation = new Quaternion(),
      scale = new Vector3();
    new Matrix4().fromArray(elements).decompose(position, rotation, scale);
    rotation.normalize();
    assert.deepEqual(result.translation, position.toArray(), `translation ${i}`);
    assert.deepEqual(result.rotation, rotation.toArray(), `rotation ${i}`);
    assert.deepEqual(result.scale, scale.toArray(), `scale ${i}`);
    let studio = true;
    try {
      studioMatrixPose(elements);
    } catch {
      studio = false;
    }
    assert.equal(result.lossless, studio, `lossless ${i} (kind ${kind}, error ${result.error})`);
    assert.equal(result.lossless, kind !== 2, `kind ${kind}`);
    assert.equal(result.handedness, kind === 1 ? 'left' : 'right');
    assert.equal(result.projective, false);
  }
});

test('decomposeAffine reports shear, reflection, projective rows and non-finite input', () => {
  // M = T · Q · K · D with known unit upper-triangular K: the shear is K's three factors.
  const q = new Quaternion().setFromAxisAngle(new Vector3(0, 0.6, 0.8), 1.1),
    k = new Matrix4().set(1, 0.3, -0.2, 0, 0, 1, 0.45, 0, 0, 0, 1, 0, 0, 0, 0, 1),
    m = new Matrix4()
      .makeRotationFromQuaternion(q)
      .setPosition(4, 5, 6)
      .multiply(k)
      .multiply(new Matrix4().makeScale(2, 3, 0.5));
  const sheared = decomposeAffine(m.elements);
  near(sheared.shear, [0.3, -0.2, 0.45], 1e-12, 'shear');
  assert.equal(sheared.lossless, false);
  assert.ok(sheared.error > 0.1, `error ${sheared.error}`);
  assert.deepEqual(sheared.translation, [4, 5, 6]);
  assert.equal(sheared.handedness, 'right');

  const trs = decomposeAffine(new Matrix4().compose(new Vector3(1, 2, 3), q, new Vector3(2, -3, 4)).elements);
  assert.equal(trs.handedness, 'left');
  assert.ok(trs.scale[0] < 0, 'the reflection is carried on x, as Matrix4.decompose does');
  assert.ok(trs.lossless && trs.error < 1e-12);
  near(trs.shear, [0, 0, 0], 1e-12, 'no shear');

  const projective = new Matrix4().makePerspective(-1, 1, 1, -1, 0.1, 100).elements;
  const p = decomposeAffine(projective);
  assert.equal(p.projective, true);
  assert.equal(p.lossless, false);

  const flat = decomposeAffine(new Matrix4().makeScale(1, 1, 0).elements);
  assert.equal(flat.handedness, 'degenerate');
  assert.ok(Number.isNaN(flat.shear[1]) && Number.isNaN(flat.shear[2]), 'undefined shear is NaN');

  const broken = new Matrix4().elements.slice();
  broken[5] = Number.NaN;
  const nan = decomposeAffine(broken);
  assert.equal(nan.error, Number.POSITIVE_INFINITY);
  assert.equal(nan.lossless, false);
  assert.equal(nan.handedness, 'degenerate');

  assert.equal(decomposeAffine(m.elements, 10).lossless, true, 'tolerance is configurable');
  assert.throws(() => decomposeAffine([1, 2, 3]), TypeError);
  for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY])
    assert.throws(() => decomposeAffine(m.elements, bad), RangeError);
});
