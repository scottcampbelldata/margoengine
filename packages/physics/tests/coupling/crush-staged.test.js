import assert from 'node:assert/strict';
import test from 'node:test';
import { CrushSolver, resolveCrushEnvelope, resolveCrushEnvelopeStroke } from '../../dist/crush.js';
import { Physics } from '../../dist/index.js';
import { PhysicsWorld, RigidSolver, worldMemory } from '../../dist/world.js';

const material = {
  stiffness: 100,
  backingStiffness: 200,
  loading: [
    { stroke: 0.2, force: 20 },
    { stroke: 0.5, force: 30 },
    { stroke: 0.8, force: 15 },
  ],
};

function near(actual, expected, error = 1e-12) {
  assert.ok(Math.abs(actual - expected) <= error, `expected ${expected}, got ${actual}, tolerance ${error}`);
}

test('a staged crush envelope carries a trigger peak through folding and a non-damaging reload', () => {
  const x = 0.65;
  const load = resolveCrushEnvelopeStroke(material, x);
  near(load.force, 22.5);
  near(load.permanentStroke, 0.425);
  near(load.absorbedEnergy, 10.90625);
  near(load.elasticEnergy, 2.53125);
  const returned = resolveCrushEnvelopeStroke(material, 0.55, load.permanentStroke);
  near(returned.force, 12.5);
  near(returned.permanentStroke, load.permanentStroke);
  near(returned.absorbedEnergy, 0);
  near(returned.elasticEnergy, 0.78125);
  const mass = 3;
  const impact = resolveCrushEnvelope(material, mass, Math.sqrt((2 * 13.4375) / mass));
  near(impact.peakStroke, x);
  near(impact.peakForce, 30);
  near(impact.absorbedEnergy, load.absorbedEnergy);
  near(impact.elasticEnergy, load.elasticEnergy);
  const bottomed = resolveCrushEnvelopeStroke(material, 1);
  near(bottomed.permanentStroke, 0.65);
  near(bottomed.force, 55);
  near(bottomed.elasticEnergy, 8.125);
  near(bottomed.absorbedEnergy, 15.125);
});

test('a staged envelope explains invalid unloading and load point geometry', () => {
  assert.throws(() => resolveCrushEnvelopeStroke({ ...material, loading: [] }, 1), { message: /at least two/ });
  assert.throws(() => resolveCrushEnvelopeStroke({ ...material, stiffness: 50 }, 1), {
    message: /first .* point at yield/,
  });
  assert.throws(
    () => resolveCrushEnvelopeStroke({ ...material, loading: [material.loading[0], { stroke: 0.3, force: 40 }] }, 1),
    { message: /increasing total and permanent strokes/ },
  );
  assert.throws(() => new CrushSolver({ rate: 8 }), { code: 'state', message: /rate level/ });
});

const foot = 0.3048;
const kip = 4448.2216152605;
const mph = 0.44704;
const zero = [0, 0, 0];

function cemDesign() {
  // Jacobsen et al., DOT/FRA/ORD-16/37. Only the pre-test Figure 4 design trace.
  // Appendix C's pre-test barrier stiffness sets the unloading scale.
  const stiffness = (7e4 * kip) / foot;
  return {
    stiffness,
    loading: [
      { stroke: kip / stiffness, force: kip },
      ...[
        [0.167, 60],
        [0.18, 600],
        [0.2, 600],
        [0.207, 300],
        [0.757, 300],
        [0.797, 2100],
        [1, 1000],
        [3.58, 1000],
        [3.83, 3700],
        [4, 2000],
      ].map(([stroke, force]) => ({ stroke: stroke * foot, force: force * kip })),
    ],
  };
}

async function pulse(level, sampleTimes) {
  await Physics.load();
  const hz = 60 * 2 ** level;
  const world = new PhysicsWorld({ rate: { num: hz, den: 1 }, gravity: zero, memory: worldMemory(false) });
  using physics = new Physics(null, { arena: world.arena, gravity: zero, fixedTimestep: 1 / hz });
  const collisionMass = 71_650 * 0.45359237; // Appendix C, Table C1.
  const speed = 34.1 * mph; // Full-scale trial's entry speed, Table 1.
  const coach = physics.addBody(null, {
    linearVelocity: [speed, 0, 0],
    colliders: { shape: 'box', halfExtents: [1.5, 1, 1], mass: collisionMass, sensor: true },
  });
  const crush = new CrushSolver({ rate: level });
  const bodyCapacity = physics.kernel.capacity;
  world.add(new RigidSolver(), { physics, capacity: bodyCapacity });
  world.add(crush, {
    bodyCapacity,
    patches: [],
    envelopePatches: [
      {
        body: coach.row,
        anchor: [1.5, 0, 0],
        normal: [1, 0, 0],
        radius: 1,
        support: { point: [1.5, 0, 0] },
        material: cemDesign(),
        response: 'continuous',
      },
    ],
  });
  world.couple([crush.id, 'rigid'], 'staggered');
  let frame = 0;
  let before = coach.linearVelocity[0];
  let stop;
  let stroke = 0;
  const history = [];
  const frames = Math.ceil(sampleTimes.at(-1) * hz);
  for (; frame < frames; frame++) {
    world.advance(frame + 1);
    const after = coach.linearVelocity[0];
    if (stop === undefined && after <= 0) stop = (frame + before / (before - after)) / hz;
    stroke = Math.max(stroke, crush.read(0).peakStroke);
    history.push(before, after);
    before = after;
  }
  const report = sampleTimes.map((t) => {
    const x = t * hz;
    const lo = Math.min(frames - 1, Math.floor(x));
    return (history[2 * lo] + (x - lo) * (history[2 * lo + 1] - history[2 * lo])) / mph;
  });
  return { report, stop, stroke };
}

test('a time step too coarse to resolve a falling load gives an actionable rate error', async () => {
  await assert.rejects(() => pulse(0, [0.12]), { code: 'state', message: /Increase crush rate/ });
});

test('independent FRA full-scale passenger-coach data bounds a staged native crush pulse', async (t) => {
  // Figure 14's cyan measured line, sampled at fixed dates. These outputs never determine the model.
  const heldOut = [
    [0.03, 28.1],
    [0.05, 23.6],
    [0.07, 16.1],
    [0.09, 9.2],
    [0.1, 5.8],
    [0.11, 1.8],
    [0.12, -2.9],
  ];
  const timeline = [...heldOut.map(([s]) => s), 0.17];
  const first = await pulse(4, timeline);
  const fine = await pulse(5, timeline);
  for (const [label, run] of [
    ['960', first],
    ['1920', fine],
  ]) {
    const loadingError = Math.sqrt(
      heldOut.slice(0, -1).reduce((sum, [, measured], index) => sum + (run.report[index] - measured) ** 2, 0) / 6,
    );
    t.diagnostic(
      `${label} Hz: loading velocity RMSE ${loadingError.toFixed(3)} mph, zero at ${(1000 * run.stop).toFixed(2)} ms, peak stroke ${(run.stroke / foot).toFixed(3)} ft, rebound ${run.report.at(-1).toFixed(2)} mph.`,
    );
    assert.ok(loadingError < 2.0, `loading RMSE ${loadingError} mph`);
    near(run.stop, 0.114, 0.01);
    near(run.stroke / foot, 3.31, 0.15); // Figure E9, blue measured maximum.
  }
  near(first.stop, fine.stop, 0.003);
  near(first.stroke, fine.stroke, 0.02);
});
