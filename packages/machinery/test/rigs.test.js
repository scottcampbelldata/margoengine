// The mechanism rigs step a physics world and match the closed forms of ./mechanisms: the solver's followers against the exact pose.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRigs, scotchYokeRig, genevaRig, oldhamRig, epicyclicRig } from '../dist/rigs.js';
import { genevaPose, epicyclicSpeeds, genevaCrankRadius } from '../dist/mechanisms.js';

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
