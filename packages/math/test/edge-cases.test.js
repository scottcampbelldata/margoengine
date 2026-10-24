// Edge-case behaviour of the rewritten math functions, checked against the recorded vectors in math-edge-cases.json
// (binding sections and tolerances only) and against first-principles invariants.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  Color,
  Euler,
  Matrix4,
  MathUtils,
  Quaternion,
  Spherical,
  Vector2,
  Vector3,
  degreesToQuaternion,
  quaternionToDegrees,
} from '../dist/index.js';
import { interpolateQuaternions, rotationToQuaternion } from '../dist/quat.js';

const vectors = JSON.parse(readFileSync(new URL('./math-edge-cases.json', import.meta.url), 'utf8'));
const num = (v) =>
  v === 'NaN' ? Number.NaN : v === 'Infinity' ? Infinity : v === '-Infinity' ? -Infinity : v === '-0' ? -0 : v;
const nums = (a) => Array.from(a, num);
const q4 = (a) => new Quaternion(...nums(a));
const qArr = (q) => [q.x, q.y, q.z, q.w];

function close(actual, expected, tolerance, label) {
  assert.equal(actual.length, expected.length, label);
  for (let i = 0; i < expected.length; i++) {
    const a = actual[i],
      e = num(expected[i]);
    if (Number.isNaN(e)) assert.ok(Number.isNaN(a), `${label}[${i}]: ${a} should be NaN`);
    else assert.ok(Math.abs(a - e) <= tolerance, `${label}[${i}]: ${a} vs ${e} (tolerance ${tolerance})`);
  }
}
const exact = (actual, expected, label) => {
  assert.equal(actual.length, expected.length, label);
  for (let i = 0; i < expected.length; i++)
    assert.ok(
      Object.is(actual[i], num(expected[i])) || actual[i] === num(expected[i]),
      `${label}[${i}]: ${actual[i]} vs ${expected[i]}`,
    );
};

// Posed unit-cube vertices: the euler-poles.test.js reproduction criterion.
const cube = [-0.5, 0.5].flatMap((x) => [-0.5, 0.5].flatMap((y) => [-0.5, 0.5].map((z) => [x, y, z])));
const apply = (e, n, [x, y, z]) => [0, 1, 2].map((r) => e[r] * x + e[n + r] * y + e[2 * n + r] * z);
const reproduces = (matrix, n, angles, order, tolerance, label) => {
  const q = new Quaternion().setFromEuler(new Euler(...angles, order));
  const m = new Matrix4().makeRotationFromQuaternion(q).elements;
  for (const v of cube) close(apply(m, 4, v), apply(matrix, n, v), tolerance, label);
};

test('Matrix4.lookAt matches the vectors and keeps translation and last row', () => {
  for (const row of vectors.matrix4LookAt) {
    const m = new Matrix4().set(...(row.prefilledRowMajor ?? [9, 9, 9, 11, 9, 9, 9, 12, 9, 9, 9, 13, 21, 22, 23, 24]));
    const eye = new Vector3(...row.eye),
      target = new Vector3(...row.target),
      up = new Vector3(...row.up);
    assert.equal(m.lookAt(eye, target, up), m);
    const e = m.elements;
    for (const [i, value] of [
      [3, 21],
      [7, 22],
      [11, 23],
      [12, 11],
      [13, 12],
      [14, 13],
      [15, 24],
    ])
      assert.equal(e[i], value, `${row.note}: untouched entry ${i}`);
    if (row.elementsColumnMajor) {
      close(e, row.elementsColumnMajor, 1e-15, row.note);
      close(qArr(new Quaternion().setFromRotationMatrix(m)), row.quaternionViaSetFromRotationMatrix, 1e-15, row.note);
      continue;
    }
    // Degenerate up: binding properties only.
    assert.ok(e.every(Number.isFinite), row.note);
    const col = (c) => [e[c * 4], e[c * 4 + 1], e[c * 4 + 2]];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++)
        assert.ok(Math.abs(dot(col(i), col(j)) - (i === j ? 1 : 0)) <= 1e-15, `${row.note}: orthonormal ${i}${j}`);
    close(cross(col(0), col(1)), col(2), 1e-15, `${row.note}: right handed`);
    const back = row.eye.map((v, i) => v - row.target[i]),
      bl = Math.hypot(...back);
    assert.ok(Math.acos(Math.min(1, dot(col(2), back) / bl)) < 0.01, `${row.note}: +Z along back`);
  }
});

test('Matrix4.lookAt falls back to a finite basis for a zero up and gives the identity when eye equals target', () => {
  const m = new Matrix4().lookAt(new Vector3(0, 0, 5), new Vector3(), new Vector3(0, 0, 0));
  assert.ok(m.elements.every(Number.isFinite));
  close(Array.from(m.elements).slice(8, 11), [0, 0, 1], 0, 'back');
});

test('Quaternion.slerp, slerpQuaternions and rotateTowards match the vectors', () => {
  for (const row of vectors.quaternionSlerp) {
    if (row.note.startsWith('non-unit receiver')) continue;
    const a = q4(row.a),
      out = a.slerp(q4(row.b), row.t);
    assert.equal(out, a);
    if (row.t === 0 || row.t === 1) exact(qArr(out), row.result, `${row.note} t=${row.t}`);
    else {
      const loose = /near parallel|close/.test(row.note);
      close(qArr(out), row.result, loose ? 1e-9 : 1e-14, `${row.note} t=${row.t}`);
    }
  }
  for (const row of vectors.quaternionSlerpQuaternions)
    close(qArr(new Quaternion().slerpQuaternions(q4(row.a), q4(row.b), row.t)), row.result, 1e-14, row.note);
  for (const row of vectors.quaternionRotateTowards) {
    const out = q4(row.a).rotateTowards(q4(row.b), row.step);
    close(qArr(out), row.result, 1e-14, `${row.note} step=${row.step}`);
  }
});

test('slerp follows the great circle: constant angular speed and unit length (first principles)', () => {
  const a = new Quaternion().setFromAxisAngle({ x: 0, y: 0, z: 1 }, 0.3),
    b = new Quaternion().setFromAxisAngle({ x: 0, y: 0, z: 1 }, 2.1);
  for (const t of [-0.5, 0.1, 0.5, 0.9, 1.5]) {
    const q = a.clone().slerp(b, t);
    assert.ok(Math.abs(q.length() - 1) < 1e-15);
    assert.ok(Math.abs(q.angleTo(a) - Math.abs(t) * 1.8) < 1e-12, `t=${t}`);
  }
  // Opposite hemisphere: the short way round, and t = 1 copies q exactly (no negation).
  const negated = new Quaternion(-b.x, -b.y, -b.z, -b.w);
  assert.ok(Math.abs(a.clone().slerp(negated, 0.5).angleTo(a) - 0.9) < 1e-12);
  assert.deepEqual(qArr(a.clone().slerp(negated, 1)), qArr(negated));
});

test('interpolateQuaternions (kept) still matches its regression vectors', () => {
  for (const row of vectors.interpolateQuaternions)
    exact(interpolateQuaternions(nums(row.a), nums(row.b), row.t, row.linearAbove), row.result, row.note);
  for (const row of vectors.interpolateQuaternionsThrows)
    assert.throws(() => interpolateQuaternions([0, 0, 0, 1], [0, 0, 0, 1], 0.5, row.linearAbove), {
      name: row.threw,
      message: row.message,
    });
});

test('Quaternion.setFromUnitVectors maps from onto to', () => {
  for (const row of vectors.setFromUnitVectors) {
    const q = new Quaternion().setFromUnitVectors(new Vector3(...row.from), new Vector3(...row.to));
    const v = new Vector3(...row.from).applyQuaternion(q);
    close([v.x, v.y, v.z], row.fromRotated, 1e-12, row.note);
    assert.ok(Math.abs(q.length() - 1) < 1e-15, row.note);
    if (!row.note.includes('NOT BINDING')) close(qArr(q), row.quaternion, 1e-14, row.note);
    else assert.equal(q.w, 0, row.note);
  }
});

test('Matrix4.decompose matches the vectors and recomposes', () => {
  for (const row of vectors.decompose) {
    const m = new Matrix4().fromArray(row.matrixColumnMajor),
      p = new Vector3(),
      q = new Quaternion(),
      s = new Vector3();
    assert.equal(m.decompose(p, q, s), m);
    exact([p.x, p.y, p.z], row.position, row.note);
    if (row.note === 'zero y scale') {
      assert.ok([...qArr(q), s.x, s.y, s.z].every(Number.isFinite));
      assert.equal(s.y, 0);
      continue;
    }
    close([s.x, s.y, s.z], row.scale, 1e-15, row.note);
    close(qArr(q), row.quaternion, 1e-15, row.note);
    const back = new Matrix4().compose(p, q, s).elements;
    close(back, row.matrixColumnMajor, 1e-15, `${row.note} recomposed`);
  }
});

test('rotationToQuaternion and setFromRotationMatrix follow Shepperd with the fixed branch rule', () => {
  for (const row of vectors.rotationToQuaternion) {
    const m4 = row.matrixColumnMajor,
      m3 = [0, 1, 2, 4, 5, 6, 8, 9, 10].map((i) => m4[i]);
    close(qArr(new Quaternion().setFromRotationMatrix({ elements: m4 })), row.fromMatrix4, 1e-15, 'm4');
    close(qArr(new Quaternion().setFromRotationMatrix({ elements: m3 })), row.fromMatrix3, 1e-15, 'm3');
    close(rotationToQuaternion(m4), row.fromMatrix4, 1e-15, 'array m4');
    close(
      rotationToQuaternion(nums(row.scaledColumns), [0, 0, 0, 0], 2, -3, 4),
      row.arrayHelperWithScale_2_neg3_4,
      1e-15,
      'scaled',
    );
  }
});

test('Euler reads every order from 4x4, 3x3 and quaternion', () => {
  for (const row of vectors.eulerFromMatrix) {
    const m4 = row.matrixColumnMajor,
      m3 = [0, 1, 2, 4, 5, 6, 8, 9, 10].map((i) => m4[i]),
      label = `${row.order} ${row.authoredDegrees_first_middle_last}`,
      middle = Math.abs(row.authoredDegrees_first_middle_last[1]);
    const e = new Euler(0, 0, 0, row.order === 'XYZ' ? 'ZYX' : 'XYZ');
    assert.equal(e.setFromRotationMatrix({ elements: m4 }, row.order), e);
    assert.equal(e.order, row.order);
    const from4 = e.toArray(),
      from3 = new Euler(0, 0, 0, row.order).setFromRotationMatrix({ elements: m3 }).toArray();
    const quat = q4(row.quaternion),
      before = qArr(quat),
      fromQ = new Euler(0, 0, 0, row.order).setFromQuaternion(quat).toArray(),
      fromNegQ = new Euler(0, 0, 0, row.order).setFromQuaternion(new Quaternion(...before.map((v) => -v))).toArray();
    assert.deepEqual(qArr(quat), before, 'quaternion not mutated');
    assert.deepEqual(fromNegQ, fromQ, 'negated quaternion');
    if (middle <= 89.9999) {
      close(from4, row.fromMatrix4, 1e-12, `${label} m4`);
      close(from3, row.fromMatrix3, 1e-12, `${label} m3`);
      close(fromQ, row.fromQuaternion, 1e-12, `${label} q`);
    }
    for (const angles of [from4, from3]) {
      assert.ok(angles.every(Number.isFinite));
      reproduces(m4, 4, angles, row.order, 1e-11, label);
    }
    reproduces(m4, 4, fromQ, row.order, 1e-11, `${label} q`);
    if (row.exactPoleMatrix) {
      const pole = new Euler(0, 0, 0, row.order).setFromRotationMatrix({ elements: row.exactPoleMatrix }).toArray();
      assert.equal(Math.abs(pole[[0, 1, 2].find((i) => 'XYZ'[i] === row.order[2])]), 0, `${label} exact pole C`);
      reproduces(row.exactPoleMatrix, 4, pole, row.order, 1e-11, `${label} exact pole`);
    }
  }
});

test('quaternionToDegrees and degreesToQuaternion (kept) through the new Euler code', () => {
  for (const row of vectors.quaternionToDegrees) {
    const degrees = quaternionToDegrees(row.quaternion, row.order);
    const back = degreesToQuaternion(degrees, row.order);
    const q = row.quaternion,
      l = Math.hypot(...q),
      d = back.reduce((sum, v, i) => sum + (v * q[i]) / l, 0);
    assert.ok(Math.abs(Math.abs(d) - 1) <= 1e-12, `${row.order} ${q}: round trip`);
    if (Math.abs(Math.abs(row.degrees[1]) - 90) > 1e-6) close(degrees, row.degrees, 1e-10, `${row.order} ${q}`);
  }
  for (const row of vectors.conversionThrows) {
    const fn = row.fn === 'quaternionToDegrees' ? quaternionToDegrees : degreesToQuaternion;
    assert.throws(() => fn(nums(row.input)), { name: row.threw, message: row.message });
  }
});

test('Vector3.angleTo, Quaternion.angleTo and Vector2.angle', () => {
  for (const row of vectors.vector3AngleTo) {
    if (
      [...row.a, ...row.b].some(
        (v) => typeof v === 'string' || Math.abs(v) >= 1e100 || (v !== 0 && Math.abs(v) <= 1e-100),
      )
    )
      continue;
    const angle = new Vector3(...row.a).angleTo(new Vector3(...row.b));
    if ([0, Math.PI, Math.PI / 2].includes(row.angle)) assert.equal(angle, row.angle, `${row.a} ${row.b}`);
    else close([angle], [row.angle], 1e-15, `${row.a} ${row.b}`);
  }
  for (const row of vectors.quaternionAngleTo) {
    const angle = q4(row.a).angleTo(q4(row.b));
    if (row.angle === 0) assert.equal(angle, 0);
    else close([angle], [row.angle], row.angle < 1e-6 ? 1e-7 : 1e-12, `${row.a} ${row.b}`);
  }
  for (const row of vectors.vector2Angle) {
    const v = nums(row.v);
    if (v.some((c) => Object.is(c, -0)) || (v[0] === 1 && v[1] === -1e-300)) continue;
    const angle = new Vector2(...v).angle();
    if (row.angle === 'NaN') assert.ok(Number.isNaN(angle));
    else close([angle], [row.angle], 1e-15, `${row.v}`);
  }
  // The range is [0, 2π): the previously out-of-range cases now give 0.
  assert.equal(new Vector2(1, -0).angle(), 0);
  assert.equal(new Vector2(1, -1e-300).angle(), 0);
});

test('seeded generators are bit exact', () => {
  for (const row of vectors.createRandom) {
    const random = row.seed === 'omitted' ? MathUtils.createRandom() : MathUtils.createRandom(num(row.seed));
    exact(Array.from({ length: 8 }, random), row.first8, `seed ${row.seed}`);
  }
  const r7 = MathUtils.createRandom(7);
  for (let i = 1; i < 1000; i++) r7();
  assert.equal(r7(), vectors.createRandomSeed7Value1000);
  for (const row of vectors.createLcgRandom)
    exact(Array.from({ length: 8 }, MathUtils.createLcgRandom(row.seed)), row.first8, `lcg seed ${row.seed}`);
  const s = vectors.seededRandom;
  exact([MathUtils.seededRandom(7), MathUtils.seededRandom(), MathUtils.seededRandom()], s.restart7, 'restart 7');
  exact([MathUtils.seededRandom(7.9), MathUtils.seededRandom()], s.restart7point9, 'restart 7.9');
  const h = vectors.randHelpers;
  let r = MathUtils.createRandom(3);
  exact(
    Array.from({ length: 4 }, () => MathUtils.randFloat(2, 5, r)),
    h.randFloat_2_5_seed3,
    'randFloat',
  );
  r = MathUtils.createRandom(3);
  exact(
    Array.from({ length: 10 }, () => MathUtils.randInt(1, 6, r)),
    h.randInt_1_6_seed3,
    'randInt',
  );
  r = MathUtils.createRandom(3);
  exact(
    Array.from({ length: 4 }, () => MathUtils.randFloatSpread(10, r)),
    h.randFloatSpread_10_seed3,
    'spread',
  );
});

test('Spherical.makeSafe and Color.sub', () => {
  for (const row of vectors.sphericalMakeSafe) {
    const s = new Spherical(2, num(row.phi), 0.3);
    const out = row.epsilon === 'default' ? s.makeSafe() : s.makeSafe(num(row.epsilon));
    assert.equal(out, s);
    exact([s.radius, s.phi, s.theta], [row.result.radius, row.result.phi, row.result.theta], `phi ${row.phi}`);
  }
  for (const row of vectors.colorSub) {
    const c = new Color().setRGB(...nums(row.a));
    assert.equal(c.sub({ r: num(row.b[0]), g: num(row.b[1]), b: num(row.b[2]) }), c);
    exact([c.r, c.g, c.b], row.result, `${row.a} - ${row.b}`);
  }
});
