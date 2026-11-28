// Xue, Zhong, Ni, Li, Bergström, Ringsberg and Huang (2024), A combined experimental and numerical
// approach to predict ship resistance and power demand in broken ice, Ocean Engineering 292, 116476.
// https://doi.org/10.1016/j.oceaneng.2023.116476 (CC BY 4.0). Inputs from §2, Table 1 and Fig. 1;
// only four instrument means and their reported repeat-trial uncertainties from Table 3 are transcribed.
// Version of record: https://research.chalmers.se/publication/538964/file/538964_Fulltext.pdf
// Run: node scripts/run-with-timeout.mjs --max=2 -- node packages/physics/scripts/ice04-pack-resistance-measured.mjs

import assert from 'node:assert/strict';
import { Physics } from '../dist/index.js';
import { PackIceSolver } from '../dist/pack-ice.js';
import { PhysicsWorld, RigidSolver, worldMemory } from '../dist/world.js';

const tankWidth = 2;
const iceReach = 10;
const waterline = 1.93;
const beam = 0.367;
const draft = 0.13;
const floeSide = 0.067;
const thickness = 0.01497;
const radius = floeSide / Math.sqrt(Math.PI);
const iceDensity = 917;
const gravity = [0, -9.81, 0];
const hz = 60;
const wallBeam = 0.12;
const seeds = [1, 2, 3];
const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;

// The original square PP positions are not published as coordinates. Seed a non-overlapping disk field
// with the same floe area/mass/reach and randomly thin and shift the lattice. Placement is independent
// of tow resistance. Within a seed, the lower concentration is a subset of the higher one.
function iceField(concentration, seed) {
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const positions = [];
  const pitch = 2.05 * radius;
  const rowPitch = (Math.sqrt(3) * pitch) / 2;
  const dx = pitch * random();
  const dz = rowPitch * random();
  for (let row = 0; radius + row * rowPitch < iceReach; row++) {
    for (let col = 0; radius + col * pitch < tankWidth; col++) {
      const x = radius + dx + pitch * (col + 0.5 * (row % 2)) + radius * 0.03 * (random() - 0.5);
      const z = radius + dz + rowPitch * row + radius * 0.03 * (random() - 0.5);
      if (x < radius || x > tankWidth - radius || z < radius || z > iceReach - radius) continue;
      positions.push({ order: random(), position: [x - tankWidth / 2, z], radius, thickness });
    }
  }
  const count = Math.round((concentration * tankWidth * iceReach) / floeSide ** 2);
  assert.ok(positions.length >= count, 'The equal-area field must fit without initial overlap.');
  positions.sort((a, b) => a.order - b.order);
  return positions.slice(0, count).map(({ position, radius, thickness }) => ({ position, radius, thickness }));
}

async function tow(speed, concentration, friction, seed) {
  const floes = iceField(concentration, seed);
  const pack = await PackIceSolver.load({ rigid: true });
  const world = new PhysicsWorld({ rate: { num: hz, den: 1 }, memory: worldMemory(false), gravity });
  const physics = new Physics(null, { fixedTimestep: 1 / hz, substeps: 1, gravity, arena: world.arena });
  try {
    // Constant prescribed tow and fixed side boundaries use the same live capsule interaction. The side
    // capsules' straight regions extend beyond the pack. Their transverse faces are exactly 2 m apart.
    const ship = physics.addBody(null, {
      type: 'kinematicVelocity',
      position: [0, 0, -waterline / 2],
      linearVelocity: [0, 0, speed],
      colliders: [],
    });
    const walls = [-1, 1].map((side) =>
      physics.addBody(null, {
        type: 'fixed',
        position: [side * ((tankWidth + wallBeam) / 2), 0, iceReach / 2],
        colliders: [],
      }),
    );
    world
      .add(new RigidSolver(), { physics })
      .add(pack, {
        floes,
        vessels: [
          { bodyRow: ship.row, length: waterline, beam, draft },
          ...walls.map(({ row }) => ({ bodyRow: row, length: iceReach + 2, beam: wallBeam })),
        ],
        rigidCapacity: physics.kernel.capacity,
        iceDensity,
        waterDensity: 1000,
        icebreaking: false,
        friction,
      })
      .couple(['pack-ice', 'rigid'], 'staggered');
    let resistanceImpulse = 0;
    let samples = 0;
    let z = ship.position[2];
    const end = Math.ceil((iceReach * hz) / speed) + 2;
    for (let frame = 1; frame <= end; frame++) {
      world.advance(frame);
      const next = ship.position[2];
      const centre = (z + next) / 2;
      z = next;
      // Same stable stage as §5, whole ship inside the ice reach. Read the signed Z impulse over every tick.
      if (centre < waterline / 2 || centre > iceReach - waterline / 2) continue;
      resistanceImpulse -= pack.vesselImpulse(ship.row).linear[1];
      samples++;
    }
    assert.ok(samples > 0 && z >= iceReach - waterline / 2, 'The prescribed vessel must pass through both gauges.');
    assert.ok(Number.isFinite(resistanceImpulse));
    return {
      concentration: (floes.length * floeSide ** 2) / (tankWidth * iceReach),
      count: floes.length,
      force: resistanceImpulse / (samples / hz),
      samples,
    };
  } finally {
    physics.dispose();
  }
}

await Physics.load();
// Inputs use measured speeds, concentrations, mass geometry and measured friction only. Source values called
// "Experiment U" are reported repeat-trial percentages, not a joint interval for a difference. The added
// allowance treats 0.023% of the 1 kN sensor range as a worst-case ±0.23 N per tow without assuming cancellation.
// Held-out metric subtracts actual measured tow means at one speed, canceling the common open-water baseline.
// Concentration-dependent flow, sliding beneath the hull, and free pitch are absent in the disk/capsule model.
const runs = [
  { speed: 0.5, measured: [1.386, 2.16], repeatPercent: [15.4, 11.1] },
  { speed: 0.8, measured: [3.008, 4.239], repeatPercent: [12.2, 7.04] },
];
for (const { speed, measured, repeatPercent } of runs) {
  const predicted = [];
  for (const friction of [0.138, 0.29]) {
    // The solver has one friction value for all contacts. Repeat at both independently measured coefficients
    // (wet hull-to-PP and PP-to-PP). Restitution and drag remain defaults; no parameters fit these tow results.
    const replicates = [];
    for (const seed of seeds) {
      const low = await tow(speed, 0.6, friction, seed);
      const high = await tow(speed, 0.8, friction, seed);
      replicates.push({ seed, low, high, incrementN: high.force - low.force });
    }
    predicted.push({
      friction,
      replicateMeanIncrementN: mean(replicates.map(({ incrementN }) => incrementN)),
      replicates,
    });
  }
  const measuredIncrementN = measured[1] - measured[0];
  const repeatRad = measured.reduce((total, force, i) => total + (force * repeatPercent[i]) / 100, 0);
  const sensorRad = 2 * 0.23;
  const interval = (radius) => [measuredIncrementN - radius, measuredIncrementN + radius];
  console.log(
    JSON.stringify({
      speedMps: speed,
      concentrations: [0.6, 0.8],
      measuredTotalN: measured,
      measuredRepeatPercent: repeatPercent,
      measuredIncrementN,
      repeatEnvelopeN: interval(repeatRad),
      conservativeEnvelopeN: interval(repeatRad + sensorRad),
      predicted,
    }),
  );
}
