// The closed-form mechanism poses against their exact solutions: loop closure, ratios and Maxwell's governor balance.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  genevaPose,
  genevaCrankRadius,
  scotchYokePose,
  oldhamPose,
  sarrusPose,
  togglePressPose,
  reuleauxPose,
  reuleauxOutline,
  roseEnginePose,
  archimedesScrew,
  archimedesScrewPose,
  gimbalAngles,
  gimbalAxis,
  gimbalPose,
  epicyclicSpeeds,
  epicyclicAssembles,
  differentialSpeeds,
  harmonicDriveRatio,
  ballDiskIntegrator,
  wattGovernorEquilibrium,
  stroboscopicRate,
  stroboscopicPose,
} from '@margoengine/machinery/mechanisms';

const near = (a, b, tolerance = 1e-12, label = '') => assert.ok(Math.abs(a - b) <= tolerance, `${label} ${a} != ${b}`);
const sweep = (n, from, to) => Array.from({ length: n + 1 }, (_, i) => from + ((to - from) * i) / n);

test('Geneva: the pin stays on its slot line while indexing, the wheel dwells otherwise and steps one pitch a turn', () => {
  for (const slots of [3, 4, 6, 8]) {
    const pitch = (2 * Math.PI) / slots;
    let last = genevaPose(-Math.PI, { slots, centerDistance: 0.32 }).wheel;
    near(last, 0, 1e-12, 'starts at 0');
    for (const crank of sweep(4000, -Math.PI, 3 * Math.PI)) {
      const pose = genevaPose(crank, { slots, centerDistance: 0.32 });
      if (pose.indexing) near(pose.residual, 0, 1e-12, 'loop closure');
      assert.ok(pose.wheel <= last + 1e-12, 'the wheel never runs back');
      assert.ok(last - pose.wheel < pitch / 20, 'and never jumps');
      last = pose.wheel;
    }
    near(genevaPose(3 * Math.PI, { slots }).wheel, -2 * pitch, 1e-12, 'two pitches for two crank turns');
    // The engaged arc is pi - 2 pi / n of the crank turn, and the velocity ratio peaks at r / (c - r) at mid-stroke.
    const r = genevaCrankRadius(slots, 1);
    near(genevaPose(0, { slots }).velocityRatio, -r / (1 - r), 1e-12, 'peak velocity ratio');
    assert.equal(genevaPose(Math.PI / 2 - Math.PI / slots - 1e-9, { slots }).indexing, true);
    assert.equal(genevaPose(Math.PI / 2 - Math.PI / slots + 1e-9, { slots }).indexing, false);
  }
  // The pin enters tangentially: at entry the wheel's speed is 0.
  near(genevaPose(Math.PI / 4, { slots: 4 }).velocityRatio, 0, 1e-12, 'tangential entry');
  assert.throws(() => genevaPose(0, { slots: 2 }), RangeError);
});

test('Scotch yoke: simple harmonic slide, the pin on the slot line', () => {
  for (const t of sweep(64, 0, 2 * Math.PI)) {
    const p = scotchYokePose(t, 0.142);
    near(p.pin[0], p.slide);
    near(p.pin[1], p.slot);
    near(p.slide ** 2 + p.slot ** 2, 0.142 ** 2, 1e-15);
    near(p.acceleration, -p.slide, 1e-15, 'x" = -x');
  }
});

test('Oldham: constant velocity, the disc centre on both slot lines, on a circle of half the offset', () => {
  for (const t of sweep(100, 0, 2 * Math.PI)) {
    const p = oldhamPose(t, 0.104);
    near(p.output, t);
    near(p.residual[0], 0, 1e-15, 'input slot');
    near(p.residual[1], 0, 1e-15, 'output slot');
    near(Math.hypot(p.center[0] - p.orbitCenter[0], p.center[1] - p.orbitCenter[1]), p.orbitRadius, 1e-15, 'orbit');
  }
});

test('Sarrus and toggle press: link lengths hold through the stroke', () => {
  for (const a of sweep(50, 0.1, 1.4)) {
    const s = sarrusPose(a, 0.8);
    near(s.residual, 0, 1e-15);
    near(s.height, 1.6 * Math.sin(a), 1e-15);
  }
  for (const x of sweep(50, 0.01, 0.2)) {
    const t = togglePressPose(x, 0.231);
    near(t.residual, 0, 1e-15);
    // Virtual work: P dx = F dy with y = 2 sqrt(L^2 - x^2) gives F / P = sqrt(L^2 - x^2) / (2 x).
    const h = 1e-7,
      dy = togglePressPose(x + h, 0.231).ram - togglePressPose(x - h, 0.231).ram;
    near(t.advantage, (2 * h) / -dy, 1e-5, 'mechanical advantage by virtual work');
  }
});

test('Reuleaux: the triangle touches all four sides at every angle and its width is constant', () => {
  const w = 0.456;
  for (const t of sweep(720, 0, 2 * Math.PI)) {
    const p = reuleauxPose(t, w);
    near(p.contacts[0][0], w / 2, 1e-12, '+x side');
    near(p.contacts[1][1], w / 2, 1e-12, '+y side');
    near(p.contacts[2][0], -w / 2, 1e-12, '-x side');
    near(p.contacts[3][1], -w / 2, 1e-12, '-y side');
  }
  for (const [x, y] of reuleauxOutline(w, 32)) assert.ok(Math.hypot(x, y) <= w / Math.sqrt(3) + 1e-12);
});

test('Rose engine: the cut repeats every lobe pitch and follows the rosette', () => {
  const rosette = { lobes: 6, amplitude: 0.015, overtone: 0.0028 };
  const a = roseEnginePose(0.3, rosette, 0.125),
    b = roseEnginePose(0.3 + a.period, rosette, 0.125);
  near(a.shift, b.shift, 1e-15);
  near(Math.hypot(...a.cut), 0.125 - a.shift, 1e-15);
});

test('Archimedes screw: buckets match the slice integral, water rises a pitch a turn', () => {
  const screw = archimedesScrew({
    pitch: 0.348,
    outerRadius: 0.175,
    innerRadius: 0.061,
    incline: (26 * Math.PI) / 180,
    length: 1.43,
  });
  const fine = archimedesScrew({ ...screw.spec }, 6400).volumePerTurn;
  near(screw.volumePerTurn, fine, 1e-7, 'converged');
  assert.ok(screw.volumePerTurn > 0 && screw.volumePerTurn < Math.PI * 0.175 ** 2 * 0.348);
  near(screw.flow(30).volumePerSecond, screw.volumePerTurn / 2, 1e-15);
  near(archimedesScrewPose(4 * Math.PI, 0.348).travel, 0.696, 1e-15);
  const lower = archimedesScrew({ ...screw.spec, freeboard: 0.01 });
  near(lower.fillLevel, screw.fillLevel - 0.01, 1e-15, 'freeboard lowers the water line');
  assert.ok(lower.volumePerTurn < screw.volumePerTurn);
});

test('Gimbal: the angles point the rotor where asked and lock at 90 degrees', () => {
  for (const d of [
    [0.3, 0.2, 0.9],
    [-0.5, -0.6, 0.2],
    [0, 0, 1],
  ]) {
    const { outer, inner } = gimbalAngles(d),
      a = gimbalAxis(outer, inner),
      n = Math.hypot(...d);
    for (let i = 0; i < 3; i++) near(a[i], d[i] / n, 1e-12);
  }
  near(gimbalAngles([0, 1, 0]).lock, 0, 1e-12, 'gimbal lock');
  const free = gimbalPose(0.7, { mountAxis: [0.83, 0.38, -0.4] }),
    held = gimbalPose(0.7, { mountAxis: [0.83, 0.38, -0.4], locked: true });
  near(free.deviation, 0, 1e-7, 'free rings hold the axis');
  // Locked, the rotor turns with the mount: its axis is +z turned 0.7 rad about the mount axis.
  const k = [0.83, 0.38, -0.4].map((v) => v / Math.hypot(0.83, 0.38, -0.4));
  near(
    Math.cos(held.deviation),
    Math.cos(0.7) + k[2] * k[2] * (1 - Math.cos(0.7)),
    1e-12,
    'locked rotor follows the mount',
  );
});

test('Willis: every held member gives the exact train ratio, and the planets assemble', () => {
  const teeth = { sun: 21, planet: 18, ring: 57 };
  near(epicyclicSpeeds(teeth, { sun: 1, ring: 0 }).carrier, 21 / 78, 1e-15, 'ring held');
  near(epicyclicSpeeds(teeth, { ring: 1, sun: 0 }).carrier, 57 / 78, 1e-15, 'sun held');
  near(epicyclicSpeeds(teeth, { sun: 1, carrier: 0 }).ring, -21 / 57, 1e-15, 'carrier held');
  const s = epicyclicSpeeds(teeth, { sun: 2.5, ring: -0.7 });
  near((s.sun - s.carrier) / (s.ring - s.carrier), -57 / 21, 1e-12, "Willis's relation");
  // The planet's mesh with the sun: pitch-line speeds match in the carrier's frame.
  near((s.sun - s.carrier) * 21, -(s.planet - s.carrier) * 18, 1e-12, 'sun-planet mesh');
  near((s.ring - s.carrier) * 57, (s.planet - s.carrier) * 18, 1e-12, 'planet-ring mesh');
  assert.equal(epicyclicAssembles(teeth, 3), true);
  assert.throws(() => epicyclicSpeeds({ sun: 20, planet: 18, ring: 57 }, { sun: 1, ring: 0 }), RangeError);
});

test('Differential, harmonic drive, integrator and stroboscope ratios are exact', () => {
  const d = differentialSpeeds(60, { halfTrack: 0.77, curvature: 0.2, sideTeeth: 20, pinionTeeth: 14 });
  near(d.left + d.right, 120, 1e-12);
  near(d.left / d.right, (1 / 0.2 + 0.77) / (1 / 0.2 - 0.77), 1e-12, 'wheels follow their arcs');
  near(d.spider, ((d.left - 60) * 20) / 14, 1e-12);
  assert.equal(harmonicDriveRatio({ flexTeeth: 60, circularTeeth: 62 }), -1 / 30);
  assert.equal(harmonicDriveRatio({ flexTeeth: 100, circularTeeth: 102, fixed: 'flex' }), 1 / 51);
  const integrator = ballDiskIntegrator({ wheelRadius: 0.046, diskRadius: 0.24 });
  // The ball swept 0 to 0.2 over 3 disk turns: output = integral of r / rho = 3 * 0.1 / 0.046.
  for (let i = 0; i < 30; i++) integrator.advance(0.1, (0.2 * i) / 30, (0.2 * (i + 1)) / 30);
  near(integrator.outputTurns, 0.3 / 0.046, 1e-12);
  assert.throws(() => integrator.advance(1, 0.3), RangeError);
  near(stroboscopicRate(120, 12, 6), 0, 1e-12, 'frozen at a multiple');
  near(stroboscopicRate(120, 14, 6), -20, 1e-9, 'backwards wagon wheel');
  near(stroboscopicRate(60, 61, 1), 60, 1e-12, 'true speed above Nyquist');
  const p = stroboscopicPose(1.04, 60, 10);
  assert.equal(p.flash, 10);
  near(p.sampled, 0, 1e-12);
});

test("Watt governor: Maxwell's balance w^2 L cos(a) = g, the cone height g / w^2, and lift-off at sqrt(g / L)", () => {
  const spec = { arm: 0.292, pickoff: 0.198, link: 0.232 };
  let previous = -1;
  for (const rpm of sweep(60, 58, 112)) {
    const omega = (rpm * 2 * Math.PI) / 60,
      e = wattGovernorEquilibrium(omega, spec);
    near(e.residual, 0, 1e-12, 'balance');
    near(e.height, 9.80665 / omega ** 2, 1e-15, 'cone height');
    assert.ok(e.angle > previous, 'the balls rise with speed');
    previous = e.angle;
    near(Math.hypot(e.sleeve - e.joint[1], e.joint[0]), 0.232, 1e-12, 'link length holds');
  }
  const liftOff = Math.sqrt(9.80665 / 0.292);
  assert.equal(wattGovernorEquilibrium(liftOff * 0.99, spec).angle, 0);
  assert.ok(wattGovernorEquilibrium(liftOff * 1.01, spec).angle > 0);
});
