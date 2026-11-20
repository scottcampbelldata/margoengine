// @margoengine/procedural/gears: involute outlines hold the involute's geometry, radii follow the standard rack, the
// compound train search is exhaustive and honours the frame, and meshing wheels interleave at every angle.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compoundModules,
  compoundRatio,
  compoundTrainMisfit,
  compoundWheelAngles,
  designCompoundTrain,
  gearRadii,
  involute,
  involuteOutline,
  meshAngle,
  toothPhase,
} from '../dist/gears.js';

const PA = (20 * Math.PI) / 180;

test('gearRadii: pitch m z / 2, tip one module out, root 1.25 modules in, base at the pressure angle', () => {
  const r = gearRadii(40, 0.001);
  assert.equal(r.pitch, 0.02);
  assert.equal(r.tip, 0.021);
  assert.equal(r.root, 0.01875);
  assert.equal(r.base, 0.02 * Math.cos(PA));
  const stub = gearRadii(40, 0.001, { addendum: 0.8, dedendum: 1, pressureAngle: (25 * Math.PI) / 180 });
  assert.ok(Math.abs(stub.tip - 0.0208) < 1e-15 && Math.abs(stub.root - 0.019) < 1e-15);
  assert.throws(() => gearRadii(2, 0.001), /3 or more/);
  assert.throws(() => gearRadii(12.5, 0.001), RangeError);
  assert.throws(() => gearRadii(12, 0), /positive length/);
});

test('involuteOutline: a closed counterclockwise loop with the tooth thickness of the involute at every radius', () => {
  for (const [z, m] of [
    [12, 0.002],
    [17, 0.001],
    [40, 0.0006],
    [140, 0.0024],
  ]) {
    const loop = involuteOutline(z, m);
    const { tip, root, base, pitch } = gearRadii(z, m);
    // Six flank points each side and a root point, plus two radial feet when the root circle is inside the base circle.
    assert.equal(loop.length, z * (13 + (root < base ? 2 : 0)));
    let area = 0;
    for (let i = 0; i < loop.length; i++) {
      const [x0, y0] = loop[i],
        [x1, y1] = loop[(i + 1) % loop.length];
      area += x0 * y1 - x1 * y0;
    }
    area /= 2;
    // Counterclockwise, between the root and tip discs.
    assert.ok(area > Math.PI * root * root && area < Math.PI * tip * tip, `${z}: area ${area}`);
    for (const [x, y] of loop) {
      const rho = Math.hypot(x, y);
      assert.ok(rho >= root - 1e-12 && rho <= tip + 1e-12);
    }
    // Tooth 0 is centred on +x; on each flank point the half angle is the involute's: pi / 2z + inv(PA) - inv(phi),
    // cos(phi) = base / rho. At the pitch circle that is a quarter pitch: thickness pi m / 2.
    const flank = loop.slice(root < base ? 1 : 0, (root < base ? 1 : 0) + 6);
    for (const [x, y] of flank) {
      const rho = Math.hypot(x, y),
        want = Math.PI / (2 * z) + involute(PA) - involute(Math.acos(Math.min(1, base / Math.max(rho, base))));
      assert.ok(Math.abs(-Math.atan2(y, x) - Math.max(want, 0)) < 1e-12);
    }
    const atPitch = Math.PI / (2 * z) + involute(PA) - involute(Math.acos(base / pitch));
    assert.ok(Math.abs(2 * pitch * atPitch - (Math.PI * m) / 2) < 1e-15);
    // Every tooth is tooth 0 turned by 2 pi k / z.
    const per = loop.length / z,
      k = Math.floor(z / 3),
      turn = (2 * Math.PI * k) / z;
    for (let i = 0; i < per; i++) {
      const [x, y] = loop[i],
        [u, v] = loop[k * per + i];
      assert.ok(Math.abs(u - (x * Math.cos(turn) - y * Math.sin(turn))) < 1e-12);
      assert.ok(Math.abs(v - (x * Math.sin(turn) + y * Math.cos(turn))) < 1e-12);
    }
  }
  assert.equal(involuteOutline(20, 0.001, { flankPoints: 3 }).length, 20 * (7 + 2));
  assert.throws(() => involuteOutline(20, 0.001, { flankPoints: 1 }), /flankPoints/);
});

const frame = { drive: [0.05, 0.04], stud: [0.05, 0], teeth: [12, 60] };

test('designCompoundTrain: the closest ratio of every fitting train, found by checking them all', () => {
  const wanted = 1 / 11.3;
  const t = designCompoundTrain(wanted, frame);
  const error = Math.abs(compoundRatio(t) / wanted - 1);
  let best = Infinity;
  for (let a = 12; a <= 60; a++)
    for (let b = 12; b <= 60; b++)
      for (let c = 12; c <= 60; c++)
        for (let d = 12; d <= 60; d++) {
          const u = { a, b, c, d };
          if (!compoundTrainMisfit(u, frame)) best = Math.min(best, Math.abs(compoundRatio(u) / wanted - 1));
        }
  // Within the tolerance the coarser module wins, so the pick is at most 2e-6 off the closest.
  assert.ok(error <= Math.max(best, 2e-6), `${error} vs ${best}`);
  assert.equal(compoundTrainMisfit(t, frame), null);
  // Centre distances are the sums of pitch radii.
  const { A, B } = compoundModules(t, frame);
  assert.ok(Math.abs((A * (t.a + t.b)) / 2 - 0.04) < 1e-15 && Math.abs((B * (t.c + t.d)) / 2 - 0.05) < 1e-15);
});

test('compoundTrainMisfit names what does not fit', () => {
  assert.equal(compoundTrainMisfit({ a: 11, b: 30, c: 20, d: 40 }, frame), 'a has 11 teeth');
  assert.match(compoundTrainMisfit({ a: 20, b: 30, c: 20, d: 40 }, { ...frame, module: [0.002, 0.003] }), /^module /);
  assert.equal(
    compoundTrainMisfit({ a: 40, b: 15, c: 20, d: 40 }, { ...frame, outputBundle: 0.04 }),
    'a reaches the output bundle',
  );
  assert.equal(
    compoundTrainMisfit({ a: 20, b: 30, c: 50, d: 15 }, { ...frame, arbor: 0.005 }),
    'c reaches the drive arbor',
  );
  assert.equal(
    compoundTrainMisfit({ a: 20, b: 30, c: 30, d: 20 }, { ...frame, outputBundle: 0.01, outputHub: 0.01 }),
    'd is smaller than the output bundle and its hub',
  );
  assert.throws(() => designCompoundTrain(0, frame), /positive number/);
  assert.throws(() => designCompoundTrain(1, { drive: [0, 0], stud: [0, 0] }), /apart/);
  assert.throws(
    () => designCompoundTrain(1 / 500, frame),
    (e) => e.name === 'MargoError' && e.code === 'failed' && /no train fits/.test(e.message),
  );
});

test('meshing wheels interleave at any drive angle, and the output turns at the train ratio', () => {
  const t = { a: 23, b: 41, c: 19, d: 37 };
  const toStud = Math.atan2(0 - 0.04, 0),
    toOut = Math.atan2(0, -0.05);
  for (let k = 0; k < 60; k++) {
    const drive = k * 0.6131 - 9;
    const w = compoundWheelAngles(t, drive, frame);
    assert.equal(w.a, drive);
    assert.equal(w.c, w.b);
    // Where one wheel has a tooth on the line of centres the other has a gap: phases add to a half.
    assert.ok(Math.abs(((toothPhase(w.a, t.a, toStud) + toothPhase(w.b, t.b, toStud + Math.PI)) % 1) - 0.5) < 1e-9);
    assert.ok(Math.abs(((toothPhase(w.c, t.c, toOut) + toothPhase(w.d, t.d, toOut + Math.PI)) % 1) - 0.5) < 1e-9);
  }
  const d0 = compoundWheelAngles(t, 0, frame).d,
    d1 = compoundWheelAngles(t, 1, frame).d;
  assert.ok(Math.abs(d1 - d0 - compoundRatio(t)) < 1e-12);
  assert.equal(meshAngle(0, 20, 20, 0), Math.PI - Math.PI / 20);
});

test('an output level with the stud on its -x side is toward -pi, as atan2(-0, -x): wheels keep their built angle', () => {
  // The Orrery's frame: atan2(0, -x) would give +pi and turn every d by 2 pi c / d against the model it was built for.
  const f = { drive: [0.078, 0.062], stud: [0.078, 0] };
  const t = { a: 36, b: 18, c: 39, d: 26 };
  const w = compoundWheelAngles(t, 0.3, f);
  assert.equal(w.d, meshAngle(w.b, 39, 26, -Math.PI));
  assert.notEqual(w.d, meshAngle(w.b, 39, 26, Math.PI));
});
