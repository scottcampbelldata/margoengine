// The mechanism rigs step a physics world and match the closed forms of ./mechanisms: the solver's followers against the exact pose.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadRigs, scotchYokeRig, genevaRig, oldhamRig, epicyclicRig, openRig, keyedRig, signedReading, describeCheck,
  harmonicDriveRig, integratorRig, archimedesScrewRig, stroboscopeRig,
} from '../dist/rigs.js';
import {
  genevaPose, epicyclicSpeeds, genevaCrankRadius, harmonicDriveRatio, ballDiskIntegrator, archimedesScrewPose, stroboscopicPose,
} from '../dist/mechanisms.js';

await loadRigs();
const deg = Math.PI / 180;

test('Scotch yoke rig: the slide follows r cos(t) through a turn and back, both ways round', () => {
  using rig = scotchYokeRig(0.142, { angle: 112 * deg });
  for (const target of [180, 359, 10, 270, 112]) {
    const pose = rig.drive(target * deg);
    assert.ok(Math.abs(pose.slide - 0.142 * Math.cos(rig.input)) < 1e-5, `slide at ${target}`);
    assert.ok(Math.abs(pose.slot - 0.142 * Math.sin(rig.input)) < 1e-5, `slot at ${target}`);
  }
  assert.ok(rig.check.ever < 1e-5, `worst gap ${rig.check.ever} m`);
  assert.ok(rig.check.steps > 100, 'the world stepped');
  assert.equal(rig.check.unit, 'm');
});

test('Geneva rig: the wheel indexes a slot pitch per crank turn and dwells, matching genevaPose', () => {
  const c = 0.32;
  using rig = genevaRig({ slots: 4, centerDistance: c, angle: -Math.PI });
  let pose = rig.drive(-Math.PI / 2);
  assert.equal(pose.indexing, false);
  assert.ok(Math.abs(pose.wheel - genevaPose(-Math.PI / 2, { slots: 4, centerDistance: c }).wheel) < 1e-4, 'dwell before the stroke');
  pose = rig.drive(0);
  assert.equal(pose.indexing, true);
  pose = rig.drive(Math.PI - 1e-6, false);
  // Two full turns forward, one back: the wheel counts slots like the closed form.
  pose = rig.drive(3 * Math.PI, false);
  pose = rig.drive(Math.PI, false);
  const exact = genevaPose(rig.input, { slots: 4, centerDistance: c }).wheel;
  assert.ok(Math.abs(pose.wheel - exact) < 5e-4, `wheel ${pose.wheel} against ${exact}`);
  assert.ok(rig.check.ever < 5e-4, `worst gap ${rig.check.ever} rad`);
  assert.ok(genevaCrankRadius(4, c) > 0);
});

test('Oldham rig: the disc centre runs on d cos(t) (cos t, sin t) and the output turns with the input', () => {
  using rig = oldhamRig(0.104, { angle: 0.4 });
  for (const target of [1.2, 3, -2, 0.4]) {
    const pose = rig.drive(target);
    assert.ok(Math.abs(pose.output - pose.input) < 5e-4, `output at ${target}`);
    const c = Math.cos(pose.input);
    assert.ok(Math.hypot(pose.center[0] - 0.104 * c * c, pose.center[1] - 0.104 * c * Math.sin(pose.input)) < 1e-5, `centre at ${target}`);
  }
  assert.ok(rig.check.ever < 1e-5, `worst gap ${rig.check.ever} m`);
  const pose = rig.drive(1);
  assert.ok(Math.abs(pose.inputSlide - 0.104 * Math.cos(1)) < 1e-5 && Math.abs(pose.outputSlide - 0.104 * Math.sin(1)) < 1e-5, 'slides');
  using coaxial = oldhamRig(0, { angle: 1 });
  assert.ok(Math.abs(coaxial.drive(2).output - 2) < 1e-4, 'coaxial shafts turn together');
});

test('Epicyclic rig: each held member gives Willis ratio on the gear joint', () => {
  const teeth = { sun: 21, planet: 18, ring: 57 };
  for (const held of ['ring', 'carrier', 'sun']) {
    using rig = epicyclicRig(teeth, { held });
    const pose = rig.drive(2 * Math.PI, false);
    const known = held === 'carrier' ? { sun: rig.input, carrier: 0 } : held === 'sun' ? { ring: rig.input, sun: 0 } : { sun: rig.input, ring: 0 };
    const exact = epicyclicSpeeds(teeth, known);
    for (const key of ['sun', 'ring', 'carrier', 'planet'])
      assert.ok(Math.abs(pose[key] - exact[key]) < 1e-4, `${held} held: ${key} ${pose[key]} against ${exact[key]}`);
    assert.ok(rig.check.ever < 1e-4, `${held} held: worst gap ${rig.check.ever}`);
  }
});

test('rigs reject bad input', () => {
  assert.throws(() => scotchYokeRig(0), RangeError);
  assert.throws(() => genevaRig({ slots: 2 }), RangeError);
  assert.throws(() => oldhamRig(-1), RangeError);
  assert.throws(() => oldhamRig(Number.NaN), RangeError);
  assert.throws(() => epicyclicRig({ sun: 20, planet: 18, ring: 57 }), RangeError);
  assert.throws(() => scotchYokeRig(1, { maxStep: 0 }), RangeError);
});

test('openRig, keyedRig, turnWheel, orbit and signedReading', async () => {
  using yoke = await openRig(scotchYokeRig, 0.1, { angle: 0 });
  assert.ok(Math.abs(yoke.drive(Math.PI / 2).slide) < 1e-5);
  assert.match(describeCheck(yoke.check), /µm$/);
  using train = keyedRig((held, angle) => epicyclicRig({ sun: 21, planet: 18, ring: 57 }, { held, angle }));
  assert.equal(train.check, null);
  assert.equal(train.drive(1, 'ring', false).ring, 0);
  assert.equal(train.drive(1, 'carrier', false).carrier, 0);
  assert.equal(train.check.steps, 0, 'a new key builds at the angle asked, with no steps');
  using geneva = genevaRig({ centerDistance: 0.32, angle: 0.5 });
  // Two crank turns on, asked as the same angle: the wheel counted two pitches, turnWheel reads within the turn.
  const pose = geneva.drive(0.5 + 4 * Math.PI, false);
  assert.ok(Math.abs(pose.wheel - genevaPose(0.5 + 4 * Math.PI, { centerDistance: 0.32 }).wheel) < 5e-4);
  const back = geneva.drive(0.5);
  assert.ok(Math.abs(back.turnWheel - genevaPose(0.5, { centerDistance: 0.32 }).wheel) < 5e-4, `turnWheel ${back.turnWheel}`);
  using coupling = oldhamRig(0.1);
  const o = coupling.drive(1);
  assert.deepEqual([o.orbitCenter, o.orbitRadius], [[0.05, 0], 0.05]);
  assert.equal(signedReading(-0.04, ' mm'), '0.0 mm');
  assert.equal(signedReading(53.24, ' mm'), '+53.2 mm');
  assert.equal(signedReading(-12, '°'), '−12.0°');
});

test('a signal disposes a rig and a keyed rig when it aborts', async () => {
  await loadRigs();
  const stop = new AbortController();
  const yoke = scotchYokeRig(0.1, { signal: stop.signal });
  const train = keyedRig((held, angle) => epicyclicRig({ sun: 21, planet: 18, ring: 57 }, { held, angle, signal: stop.signal }), {
    signal: stop.signal,
  });
  const built = train.drive(0.5, 'ring') && train;
  assert.ok(built.check);
  assert.equal(yoke.physics.isDisposed, false);
  stop.abort(new Error('left the page'));
  assert.equal(yoke.physics.isDisposed, true);
  assert.equal(train.check, null, 'the keyed rig dropped its rig');
  assert.throws(() => train.drive(1, 'ring'), /left the page/);
  assert.throws(() => scotchYokeRig(0.1, { signal: stop.signal }), /left the page/, 'an aborted signal builds nothing');
});

test('Harmonic drive rig: the output spline turns at the Musser ratio with either spline held', () => {
  for (const fixed of ['circular', 'flex']) {
    const spec = { flexTeeth: 60, circularTeeth: 62, fixed };
    using rig = harmonicDriveRig(spec, { angle: 0.3 });
    const pose = rig.drive(0.3 + 6 * Math.PI, false);
    assert.ok(Math.abs(pose.output - harmonicDriveRatio(spec) * pose.input) < 1e-5, `${fixed} held: ${pose.output}`);
    rig.drive(-1);
    assert.ok(rig.check.ever < 1e-5, `${fixed} held: worst gap ${rig.check.ever} rad`);
  }
  assert.throws(() => harmonicDriveRig({ flexTeeth: 60, circularTeeth: 60 }), RangeError);
});

test('Integrator rig: the roller turns the integral of r / rho over the disk, as the ball moves and after a reset', () => {
  using rig = integratorRig({ wheelRadius: 0.046, diskRadius: 0.24, radius: 0.1 });
  const exact = ballDiskIntegrator({ wheelRadius: 0.046, diskRadius: 0.24 });
  rig.drive(2 * Math.PI, false);
  exact.advance(1, 0.1);
  rig.setRadius(-0.05);
  rig.drive(5 * Math.PI, false);
  exact.advance(1.5, -0.05);
  rig.setRadius(0);
  rig.drive(6 * Math.PI, false);
  exact.advance(0.5, 0);
  rig.setRadius(0.195);
  let pose = rig.drive(8 * Math.PI, false);
  exact.advance(1, 0.195);
  assert.ok(Math.abs(pose.output - exact.outputTurns * 2 * Math.PI) < 1e-4, `output ${pose.output}`);
  assert.equal(pose.radius, 0.195);
  rig.resetOutput();
  pose = rig.drive(9 * Math.PI, false);
  assert.ok(Math.abs(pose.output - (0.195 / 0.046) * Math.PI) < 1e-4, `after a reset ${pose.output}`);
  assert.ok(rig.check.ever < 1e-4, `worst gap ${rig.check.ever} rad`);
  assert.throws(() => rig.setRadius(0.3), RangeError);
  assert.throws(() => integratorRig({ wheelRadius: 0 }), RangeError);
});

test('Archimedes screw rig: the water climbs a pitch a turn, over many buckets and back', () => {
  using rig = archimedesScrewRig(0.348, { angle: 0.2 });
  for (const target of [9.3 * Math.PI, 40 * Math.PI, 3 * Math.PI, -4 * Math.PI]) {
    const pose = rig.drive(target, false);
    const exact = archimedesScrewPose(target, 0.348);
    assert.ok(Math.abs(pose.travel - exact.travel) < 2e-5, `travel at ${target}: ${pose.travel} against ${exact.travel}`);
    const phase = Math.abs(pose.phase - exact.phase);
    assert.ok(Math.min(phase, 2 * Math.PI - phase) < 1e-3, `phase at ${target}`);
  }
  assert.ok(rig.check.ever < 2e-5, `worst gap ${rig.check.ever} m`);
  assert.equal(rig.check.unit, 'm');
  assert.throws(() => archimedesScrewRig(0), RangeError);
});

test('Stroboscope rig: the coasting rotor and the strobe samples match stroboscopicPose', () => {
  using rig = stroboscopeRig({ rpm: 120, flashRate: 14 });
  let pose;
  for (let i = 0; i < 300; i++) pose = rig.advance(1 / 60);
  const exact = stroboscopicPose(5, 120, 14);
  const near = (a, b) => Math.min(Math.abs(a - b), 2 * Math.PI - Math.abs(a - b));
  assert.equal(pose.flash, exact.flash);
  assert.ok(near(pose.reference, exact.reference) < 1e-4 && near(pose.sampled, exact.sampled) < 1e-4, 'reference and sample');
  rig.setFlashRate(20);
  rig.setSpeed(60);
  pose = rig.advance(0.25);
  assert.equal(pose.flash, 5);
  assert.ok(rig.check.ever < 1e-4, `worst gap ${rig.check.ever} rad`);
  assert.throws(() => rig.advance(-1), RangeError);
  assert.throws(() => rig.setFlashRate(0), RangeError);
});
