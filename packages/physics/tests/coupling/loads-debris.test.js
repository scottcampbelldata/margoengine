import assert from 'node:assert/strict';
import test from 'node:test';
import { collisionGroups, Physics } from '../../dist/index.js';
import { accumulateFilteredWoodyContact, sampleWoodyDebrisImpact, woodyDebrisImpact } from '../../dist/loads.js';
import {
  BODIES_FIELD,
  BODY_IMPULSES_FIELD,
  BODY_WORDS,
  IMPULSE_WORDS,
  PhysicsWorld,
  RigidSolver,
} from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

function close(actual, expected, tolerance, label) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} vs ${expected} ± ${tolerance}`);
}

test('Haehnel and Daly held-out concrete-face end-on peaks bound the stiff-support woody impact pulse', () => {
  // Haehnel & Daly 2002, ERDC/CRREL TR-02-2, Table 4 and Figure 13, printed p. 28 (2004 journal DOI below).
  // Their 2.4 MN/m envelope uses Series 1/3/4. This is load-cell data from Series 6, never used for that fit.
  // At 140 dpi, x=309..883 maps to 0..450 kg m/s; y=608..226 maps to 0..40 kN. Digitized combined marker
  // centres are at x=727.5, from y=318.5 to 333.5. Overlapping points cannot be separated at this resolution.
  // A square spans 6 px; three pixels plus half a pixel for the axis is 0.37 kN / 2.75 kg m/s.
  // https://archive.org/details/DTIC_ADA398916 ; https://doi.org/10.1061/(ASCE)0733-9429(2004)130:2(112)
  const momentum = (727.5 - 309) * (450 / (883 - 309));
  const measuredLow = (608 - 333.5) * (40000 / (608 - 226));
  const measuredHigh = (608 - 318.5) * (40000 / (608 - 226));
  const plottingError = 3.5 * (40000 / (608 - 226));
  const closingSpeed = 1.2;
  const impact = woodyDebrisImpact({
    closingSpeed,
    inverseEffectiveMass: closingSpeed / momentum,
    structureStiffness: 120e6,
  });
  // The reported stiffness predicts the upper end of the replicate band. Check that envelope, not a fit to its mean.
  assert.ok(impact.peakForce >= measuredLow - plottingError, `peak below measured replicates: ${impact.peakForce}`);
  close(impact.peakForce, measuredHigh, plottingError, 'upper replicate at independently measured momentum');
});

test('Series 8 first eccentric displacement reduces the measured peak outside the central impact calibration', () => {
  // Figure 14, printed p. 29 of the same report. Series 8 was never used for the 2.4 MN/m fit.
  // The near-centre x=423.5 group is 0.217 radii of gyration: the diamonds at y=295.5..315.5 give the
  // measured replicate interval. The axes at x=358..963 and y=605..224 span 0..2 and 0..1.2.
  const eccentricity = (423.5 - 358) * (2 / (963 - 358));
  const mass = 171;
  const central = woodyDebrisImpact({ closingSpeed: 1.2, inverseEffectiveMass: 1 / mass });
  const shifted = woodyDebrisImpact({
    closingSpeed: 1.2,
    inverseEffectiveMass: (1 + eccentricity * eccentricity) / mass,
  });
  const measuredHigh = (605 - 295.5) * (1.2 / (605 - 224));
  const plottingError = 3.5 * (1.2 / (605 - 224));
  close(shifted.peakForce / central.peakForce, measuredHigh, plottingError, 'first eccentric group upper replicate');
  assert.ok(shifted.peakForce < central.peakForce);
});

test('the sub-tick contact pulse is unilateral and its impulse and lost energy agree with restitution', () => {
  const closingSpeed = 3;
  const inverseEffectiveMass = 1 / 40;
  for (const restitution of [0, 0.4, 1]) {
    const impact = woodyDebrisImpact({
      closingSpeed,
      inverseEffectiveMass,
      woodStiffness: 2e6,
      structureStiffness: 2e6,
      restitution,
    });
    const before = 0.5 * 40 * closingSpeed * closingSpeed;
    const after = 0.5 * 40 * (restitution * closingSpeed) * (restitution * closingSpeed);
    close(impact.peakForce, 3 * Math.sqrt(40 * 1e6), 1e-10, 'peak force with two springs in series');
    close(impact.dissipatedEnergy, before - after, 1e-10, 'dissipated normal-mode energy');
    const parts = 2048;
    let integral = 0;
    for (let i = 0; i < parts; i++) {
      const sample = sampleWoodyDebrisImpact(impact, (impact.duration * (i + 0.5)) / parts);
      assert.ok(sample.force > 0);
      integral += (sample.force * impact.duration) / parts;
    }
    // The midpoint error is bounded by duration×h²/24 times max |F''|. At the join the first derivatives both vanish,
    // so the same bound holds for an interval straddling the peak.
    const maxOmega = Math.PI / 2 / (impact.timeToPeak * (restitution || 1));
    const quadratureError =
      (impact.peakForce * impact.duration * (maxOmega * impact.duration) ** 2) / (24 * parts * parts);
    close(integral, 40 * closingSpeed * (1 + restitution), quadratureError, 'integrated load');
    assert.deepEqual(sampleWoodyDebrisImpact(impact, 0), { force: 0, impulse: 0 });
    assert.deepEqual(sampleWoodyDebrisImpact(impact, impact.duration), { force: 0, impulse: impact.normalImpulse });
    if (restitution > 0)
      close(
        sampleWoodyDebrisImpact(impact, impact.timeToPeak).impulse,
        40 * closingSpeed,
        1e-10,
        'compression impulse',
      );
  }
  assert.equal(woodyDebrisImpact({ closingSpeed: -1, inverseEffectiveMass }), undefined);
  assert.throws(() => woodyDebrisImpact({ closingSpeed, inverseEffectiveMass: 0 }), {
    name: 'MargoError',
    code: 'unsupported',
    message: /Provide .+ positive finite inverse effective mass.+#hydrodynamic-loads/,
  });
  assert.throws(() => woodyDebrisImpact({ closingSpeed, inverseEffectiveMass, restitution: 1.1 }), {
    code: 'unsupported',
    message: /Choose .+ between 0 and 1.+#hydrodynamic-loads/,
  });
});

await Physics.load();

test('an eccentric point impulse accounts for the velocity and inertia of both rotating bodies', () => {
  const bodies = new Float32Array(2 * BODY_WORDS);
  const impulses = new Float64Array(2 * IMPULSE_WORDS);
  const armY = 0.25;
  // Uniform 8 and 16 kg unit cubes have Iz=m/6. The lever arm of their shared point is 0.25 m.
  bodies.set([1, -0.5, 0, 0, 3, 0, 0, 0, 0, 2, 1 / 8, 0.75, 0, 0, 0.75, 0, 0.75], 6);
  bodies.set([1, 0.5, 0, 0, 1, 0, 0, 0, 0, -1, 1 / 16, 0.375, 0, 0, 0.375, 0, 0.375], BODY_WORDS + 6);
  const hit = accumulateFilteredWoodyContact(bodies, impulses, {
    debrisRow: 0,
    supportRow: 1,
    point: [0, armY, 0],
    normal: [-1, 0, 0],
    restitution: 0.5,
  });
  const debrisClosing = 3 - 2 * armY;
  const supportClosing = 1 + armY;
  const inverseEffectiveMass = 1 / 8 + 1 / 16 + armY * armY * (0.75 + 0.375);
  const expected = (1.5 * (debrisClosing - supportClosing)) / inverseEffectiveMass;
  const impulse = hit.normalImpulse;
  close(impulse, expected, 1e-12, 'impulse including both contact levers');
  assert.deepEqual(Array.from(impulses), [-impulse, 0, 0, 0, 0, armY * impulse, impulse, 0, 0, 0, 0, -armY * impulse]);
});

// A real rigid port contributor fixture. The two spheres first touch at tick four. Their masks isolate this pair.
// An authored travel/shape-crossing detector can publish the same contact point and normal at the first collision tick.
function pairedDebris(rate = { num: 60, den: 1 }) {
  const world = new PhysicsWorld({ rate, gravity: [0, 0, 0] });
  const physics = new Physics(null, { fixedTimestep: 1 / 60, gravity: [0, 0, 0] });
  const debris = physics.addBody(null, {
    position: [-0.7, 0, 0],
    linearVelocity: [3, 0, 0],
    colliders: { shape: 'sphere', radius: 0.5, mass: 8, collisionGroups: collisionGroups([0], [0]) },
  });
  const support = physics.addBody(null, {
    position: [0.5, 0, 0],
    colliders: { shape: 'sphere', radius: 0.5, mass: 16, collisionGroups: collisionGroups([1], [1]) },
  });
  let memory;
  let ledger;
  const debrisContact = {
    describe() {
      return {
        id: 'woodyContactProof',
        rate: 0,
        stableRate: () => 0,
        fields: [
          { field: BODIES_FIELD, access: 'read' },
          { field: BODY_IMPULSES_FIELD, access: 'accumulate' },
        ],
      };
    },
    init(host) {
      memory = host.memory;
      ledger = host.allocate('woodyImpulse', host.bodyRows() * IMPULSE_WORDS * 8, 'f64', 1);
    },
    step({ tick, inputs }) {
      const out = new Float64Array(memory.buffer, ledger.byteOffset, ledger.byteLength / 8);
      out.fill(0);
      if (tick !== 4) return;
      const { region } = inputs.get(BODIES_FIELD.name);
      const bodies = new Float32Array((region.memory ?? memory).buffer, region.byteOffset, region.byteLength / 4);
      const hit = { debrisRow: debris.row, supportRow: support.row, point: [0, 0, 0], normal: [-1, 0, 0] };
      assert.throws(() => accumulateFilteredWoodyContact(bodies, out, { ...hit, normal: [-2, 0, 0] }), {
        code: 'unsupported',
        message: /Provide .+ unit normal.+#hydrodynamic-loads/,
      });
      const impact = accumulateFilteredWoodyContact(bodies, out, { ...hit, restitution: 0.5 });
      close(impact.normalImpulse, 24, 1e-6, 'reciprocal impact');
      assert.equal(accumulateFilteredWoodyContact(bodies, out, hit), undefined, 'the staged pair is already receding');
    },
    exportPorts(tick) {
      return [{ field: BODY_IMPULSES_FIELD.name, region: ledger, tick, cell: [0, 0, 0] }];
    },
    importPorts() {},
    stateRegions: () => [ledger],
    extraState: () => [],
  };
  world.add(new RigidSolver(), { physics }).add(debrisContact, {}).couple(['woodyContactProof', 'rigid'], 'staggered');
  return { world, debris, support };
}

test('the filtered rigid pair receives a single conservative momentum transfer through bodyImpulses', () => {
  const { world, debris, support } = pairedDebris();
  world.advance(5);
  close(debris.linearVelocity[0], 0, 1e-6, 'debris normal speed');
  close(support.linearVelocity[0], 1.5, 1e-6, 'support normal speed');
  close(8 * debris.linearVelocity[0] + 16 * support.linearVelocity[0], 24, 1e-6, 'total linear momentum');
  frameRateIndependent((rate) => pairedDebris(rate).world);
  seekEqualsContinuous(() => pairedDebris({ num: 24, den: 1 }).world, { frames: 4, at: 1 });
});
