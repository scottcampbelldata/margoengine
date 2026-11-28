// The mechanism rigs step a physics world and match the closed forms of ./mechanisms: the solver's followers against the exact pose.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadRigs,
  scotchYokeRig,
  genevaRig,
  oldhamRig,
  epicyclicRig,
  openRig,
  keyedRig,
  signedReading,
  describeCheck,
  harmonicDriveRig,
  integratorRig,
  archimedesScrewRig,
  stroboscopeRig,
  togglePressRig,
  gimbalRig,
  differentialRig,
  wattGovernorRig,
  roseEngineRig,
  reuleauxRig,
} from '../dist/rigs.js';
import {
  genevaPose,
  epicyclicSpeeds,
  genevaCrankRadius,
  harmonicDriveRatio,
  ballDiskIntegrator,
  archimedesScrewPose,
  stroboscopicPose,
  togglePressPose,
  gimbalPose,
  differentialPose,
  wattGovernorEquilibrium,
  roseEnginePose,
  reuleauxPose,
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
  assert.ok(
    Math.abs(pose.wheel - genevaPose(-Math.PI / 2, { slots: 4, centerDistance: c }).wheel) < 1e-4,
    'dwell before the stroke',
  );
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
    assert.ok(
      Math.hypot(pose.center[0] - 0.104 * c * c, pose.center[1] - 0.104 * c * Math.sin(pose.input)) < 1e-5,
      `centre at ${target}`,
    );
  }
  assert.ok(rig.check.ever < 1e-5, `worst gap ${rig.check.ever} m`);
  const pose = rig.drive(1);
  assert.ok(
    Math.abs(pose.inputSlide - 0.104 * Math.cos(1)) < 1e-5 && Math.abs(pose.outputSlide - 0.104 * Math.sin(1)) < 1e-5,
    'slides',
  );
  using coaxial = oldhamRig(0, { angle: 1 });
  assert.ok(Math.abs(coaxial.drive(2).output - 2) < 1e-4, 'coaxial shafts turn together');
});

test('Epicyclic rig: each held member gives Willis ratio on the gear joint', () => {
  const teeth = { sun: 21, planet: 18, ring: 57 };
  for (const held of ['ring', 'carrier', 'sun']) {
    using rig = epicyclicRig(teeth, { held });
    const pose = rig.drive(2 * Math.PI, false);
    const known =
      held === 'carrier'
        ? { sun: rig.input, carrier: 0 }
        : held === 'sun'
          ? { ring: rig.input, sun: 0 }
          : { sun: rig.input, ring: 0 };
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
  assert.ok(
    Math.abs(back.turnWheel - genevaPose(0.5, { centerDistance: 0.32 }).wheel) < 5e-4,
    `turnWheel ${back.turnWheel}`,
  );
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
  const train = keyedRig(
    (held, angle) => epicyclicRig({ sun: 21, planet: 18, ring: 57 }, { held, angle, signal: stop.signal }),
    {
      signal: stop.signal,
    },
  );
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
    assert.ok(
      Math.abs(pose.travel - exact.travel) < 2e-5,
      `travel at ${target}: ${pose.travel} against ${exact.travel}`,
    );
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
  assert.ok(
    near(pose.reference, exact.reference) < 1e-4 && near(pose.sampled, exact.sampled) < 1e-4,
    'reference and sample',
  );
  rig.setFlashRate(20);
  rig.setSpeed(60);
  pose = rig.advance(0.25);
  assert.equal(pose.flash, 5);
  assert.ok(rig.check.ever < 1e-4, `worst gap ${rig.check.ever} rad`);
  assert.throws(() => rig.advance(-1), RangeError);
  assert.throws(() => rig.setFlashRate(0), RangeError);
});

test('Toggle press rig: the ram on its slide drops 2 sqrt(L^2 - x^2) through a closing stroke and back', () => {
  using rig = togglePressRig(0.231, { angle: 52 * deg });
  for (const angle of [8, 30, 52, 8]) {
    const pose = rig.drive(angle * deg);
    const exact = togglePressPose(0.231 * Math.sin(angle * deg), 0.231);
    assert.ok(Math.abs(pose.ram - exact.ram) < 2e-5, `ram at ${angle} degrees: ${pose.ram} against ${exact.ram}`);
    assert.ok(Math.abs(pose.lower - angle * deg) < 1e-3, `the lower link leans as the upper does: ${pose.lower}`);
    assert.ok(
      Math.abs(pose.advantage - exact.advantage) < 2e-3,
      `advantage ${pose.advantage} against ${exact.advantage}`,
    );
  }
  assert.ok(rig.check.ever < 2e-5, `worst gap ${rig.check.ever} m`);
});

test('Gimbal rig: free rings hold the rotor on its target while the mount tilts; locked rings turn it with the mount', () => {
  const mountAxis = [0.83, 0.38, -0.4];
  for (const locked of [false, true]) {
    using rig = gimbalRig({ mountAxis, angle: 22 * deg, locked });
    for (const tilt of [44, -44, 0, 22]) {
      const pose = rig.drive(tilt * deg);
      const exact = gimbalPose(tilt * deg, { mountAxis, locked });
      assert.ok(
        Math.abs(pose.deviation - exact.deviation) < 1e-3,
        `${locked ? 'locked' : 'free'} at ${tilt}: ${pose.deviation}`,
      );
      if (!locked) {
        assert.ok(Math.abs(pose.outer - exact.outer) < 1e-3, `outer ring ${pose.outer} against ${exact.outer}`);
        assert.ok(Math.abs(pose.inner - exact.inner) < 1e-3, `inner ring ${pose.inner} against ${exact.inner}`);
      }
    }
    assert.ok(rig.check.ever < 1e-3, `worst gap ${rig.check.ever} rad`);
  }
  assert.throws(() => gimbalRig({ mountAxis: [0, 0, 0] }), RangeError);
});

test('Differential rig: the gears share the road lead, left + right = 2 carrier, the spider at zs / zp times the lead', () => {
  using rig = differentialRig({ sideTeeth: 20, pinionTeeth: 14 });
  let lead = 0,
    from = 0;
  for (const [turns, split] of [
    [2, 0],
    [6, 0.34],
    [10, -0.34],
    [14, 0],
  ]) {
    rig.setSplit(split);
    const pose = rig.drive(turns * 2 * Math.PI, false);
    lead += split * (pose.carrier - from);
    from = pose.carrier;
    const exact = differentialPose(pose.carrier, lead, { side: 20, pinion: 14 });
    assert.ok(Math.abs(pose.left - exact.left) < 2e-4, `left after ${turns} turns`);
    assert.ok(Math.abs(pose.right - exact.right) < 2e-4, `right after ${turns} turns`);
    assert.ok(Math.abs(pose.pinion - exact.pinion) < 3e-4, `spider after ${turns} turns`);
    assert.ok(Math.abs(pose.left + pose.right - 2 * pose.carrier) < 3e-4, 'the sides average to the carrier');
  }
  assert.ok(rig.check.ever < 3e-4, `worst gap ${rig.check.ever} rad`);
});

test("Watt governor rig: the arms swing out under gravity and settle on Maxwell's balance at each speed", () => {
  using rig = wattGovernorRig({ arm: 0.292, pickoff: 0.198, link: 0.232, rpm: 68 });
  assert.ok(rig.check.last < 1e-6, 'it starts settled');
  for (const rpm of [112, 58, 90]) {
    rig.spin(rpm, 0.5);
    assert.ok(rig.check.last > 1e-3, `a speed change at ${rpm} rpm moves the arms off balance first`);
    const pose = rig.settle(rpm, 2e-4, 30);
    const exact = wattGovernorEquilibrium((rpm * Math.PI) / 30, { arm: 0.292, pickoff: 0.198, link: 0.232 });
    assert.ok(Math.abs(pose.arm - exact.angle) < 2e-4, `arms at ${rpm} rpm: ${pose.arm} against ${exact.angle}`);
    assert.ok(Math.abs(pose.sleeve - exact.sleeve) < 1e-4, `sleeve at ${rpm} rpm`);
    assert.ok(Math.abs(pose.arms[0] - pose.arms[1]) < 1e-5, 'the two arms swing alike');
  }
  assert.equal(describeCheck(rig.check, 'last').endsWith('°'), true);
  using still = wattGovernorRig({ arm: 0.292 });
  still.spin(0, 2);
  assert.ok(Math.abs(still.pose().arm - 0.05) < 1e-3, 'below lift-off the arms rest on their stop');
  assert.throws(() => rig.spin(-1, 1), RangeError);
});

test('Rose engine rig: a follower held 0.2 m off its centre in the rosette groove rocks the headstock and cuts the exact curve', () => {
  const rosette = { lobes: 6, amplitude: 0.015, overtone: 0.0028 };
  using rig = roseEngineRig(rosette, { toolRadius: 0.125 });
  let worst = 0;
  for (let degrees = 5; degrees <= 360 * 3; degrees += 5) {
    const pose = rig.drive(degrees * deg, false),
      exact = roseEnginePose(degrees * deg, rosette, 0.125);
    worst = Math.max(
      worst,
      Math.abs(pose.shift - exact.shift),
      Math.hypot(pose.cut[0] - exact.cut[0], pose.cut[1] - exact.cut[1]),
    );
    assert.equal(pose.contact, exact.contact);
    assert.equal(pose.period, exact.period);
  }
  // The rows read speeds at a substep start, so the follower own acceleration leaves a steady lag of a h^2 / (2 c): about 40 um here.
  assert.ok(worst < 8e-5, `worst gap ${worst} m over three turns`);
  assert.ok(rig.check.ever < 8e-5, `check ${rig.check.ever} m`);
  assert.equal(describeCheck(rig.check).endsWith('µm'), true);
  assert.throws(() => roseEngineRig(rosette, { toolRadius: 0.01 }), RangeError);
  assert.throws(() => roseEngineRig(rosette, { points: 4 }), RangeError);
});

test('Rose engine rig: rosettes of other lobe counts, turned both ways, keep the cut exact', () => {
  for (const rosette of [
    { lobes: 9, amplitude: 0.0125, overtone: 0.0022 },
    { lobes: 3, amplitude: 0.04 },
  ]) {
    using rig = roseEngineRig(rosette, { toolRadius: rosette.lobes === 3 ? 0.3 : 0.125 });
    for (const degrees of [90, -200, 360, 10]) {
      const pose = rig.drive(degrees * deg, false);
      assert.ok(
        Math.abs(pose.shift - roseEnginePose(degrees * deg, rosette, rosette.lobes === 3 ? 0.3 : 0.125).shift) < 1.2e-4,
        `${rosette.lobes} lobes at ${degrees}`,
      );
    }
  }
});

test('Reuleaux rig: the triangle keeps its centre on the exact nearly square path, in contact with all four walls', () => {
  using rig = reuleauxRig(0.456);
  let worst = 0;
  for (let degrees = 3; degrees <= 360 * 2; degrees += 3) {
    const pose = rig.drive(degrees * deg, false),
      exact = reuleauxPose(degrees * deg, 0.456);
    worst = Math.max(worst, Math.hypot(pose.center[0] - exact.center[0], pose.center[1] - exact.center[1]));
    assert.ok(Math.abs(pose.span[0] - 0.456) < 2e-4 && Math.abs(pose.span[1] - 0.456) < 2e-4, 'constant width');
  }
  assert.ok(worst < 2e-4, `worst gap ${worst} m over two turns`);
  assert.throws(() => reuleauxRig(-1), RangeError);
  assert.throws(() => reuleauxRig(1, { subdivisions: 2 }), RangeError);
});
