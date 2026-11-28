// Run with built Physics: node packages/physics/scripts/earth07-creyssels-measured.mjs
// Creyssels et al. (2009), Saltating particles in a turbulent boundary layer: experiment and theory,
// J. Fluid Mech. 625, 47–74, Table 1 and §2.1–2.3. https://doi.org/10.1017/S0022112008005491
// The Pitot profile supplies u*. A separate outlet collector was weighed to obtain Q. Only u* and
// physical bed data enter the solver. Neither the held-out flux nor the paper's fitted Eq. 3.5 is a model input.
import assert from 'node:assert/strict';
import { AeolianTransport } from '../dist/aeolian.js';
import { TerrainBed } from '../dist/earth.js';
import { PhysicsWorld } from '../dist/world.js';

// The three columns are the reported Shields number, u* (m/s) and measured Q (g/(m s)).
const measurements = [
  [0.012, 0.24, 5.25],
  [0.022, 0.32, 12.84],
  [0.035, 0.4, 21.09],
  [0.05, 0.48, 32],
  [0.068, 0.56, 48.85],
  [0.098, 0.67, 79.55],
];
const gravity = 9.81;
const grainDensity = 2500;
const diameter = 242e-6;
const mobileDepth = 0.025;
const tunnelWidth = 0.6;
const reportedFraction = 0.05;
const rate = { num: 60, den: 1 };

// The original working section was 15 m. It was pre-fed with sand to approach fully developed
// saltation. No inlet concentration was reported. These open-ended flat domains approximate only
// the fully developed interior. Extending the reach keeps inflow and outflow remote from the gauge
// while the unseeded solver equilibrates. A doubled reach and halved grid spacing check the approximation.
const coarse = { columns: 64, rows: 2, width: 128, depth: tunnelWidth, centre: [0, 0] };
const fine = { columns: 256, rows: 2, width: 256, depth: tunnelWidth, centre: [0, 0] };
const transport = await AeolianTransport.load();

function equilibrium(frictionVelocity, airDensity, grid) {
  const world = new PhysicsWorld({ rate, gravity: [0, -gravity, 0] });
  const bed = new TerrainBed();
  try {
    world.add(bed, { ...grid, elevations: () => 0 });
    world.add(transport, {
      grid,
      diameter,
      grainDensity,
      mobileDepth,
      airDensity,
      frictionVelocity: [frictionVelocity, 0],
      hillStrength: 0,
      open: { minX: true, maxX: true },
    });
    const flux = (column) => {
      const { mass, velocity } = transport.read(column, grid.rows / 2);
      return 1000 * mass * velocity[0];
    };
    const centre = grid.columns / 2;
    world.advance(25 * rate.num);
    const early = flux(centre);
    world.advance(30 * rate.num);
    const late = flux(centre);
    const timeDrift = Math.abs(late - early);
    const spatialDrift = Math.max(Math.abs(late - flux(centre - 1)), Math.abs(late - flux(centre + 1)));
    assert.ok(Number.isFinite(late) && late >= 0, 'Expected a finite downwind flux.');
    assert.ok(
      timeDrift + spatialDrift <= 0.005 * Math.max(late, 1),
      `Interior has not reached steady transport at ${frictionVelocity} m/s. Extend the flat reach and integration time.`,
    );
    return { flux: late, timeDrift, spatialDrift };
  } finally {
    world.remove(transport.id);
    world.remove(bed.id);
  }
}

const results = measurements.map(([shields, frictionVelocity, observed]) => {
  // Table 1 provides the wind forcing in both units. Infer the air density from the two rounded
  // entries and the independently measured grain properties. The scored sand mass never enters it.
  const airDensity = (shields * grainDensity * gravity * diameter) / frictionVelocity ** 2;
  const nominal = equilibrium(frictionVelocity, airDensity, fine);
  const control = equilibrium(frictionVelocity, airDensity, coarse);
  const lower = equilibrium((1 - reportedFraction) * frictionVelocity, airDensity, fine);
  const upper = equilibrium((1 + reportedFraction) * frictionVelocity, airDensity, fine);
  const reachDifference = Math.abs(nominal.flux - control.flux);
  const numericalAllowance =
    reachDifference + Math.max(...[nominal, control, lower, upper].map((run) => run.timeDrift + run.spatialDrift));
  const modelMin = Math.min(lower.flux, nominal.flux, upper.flux) - numericalAllowance;
  const modelMax = Math.max(lower.flux, nominal.flux, upper.flux) + numericalAllowance;
  const observationMin = (1 - reportedFraction) * observed;
  const observationMax = (1 + reportedFraction) * observed;
  return {
    shields,
    frictionVelocity,
    airDensityInferred: airDensity,
    measuredFluxGramsPerMetreSecond: observed,
    predictedFluxGramsPerMetreSecond: nominal.flux,
    measuredFluxBand: [observationMin, observationMax],
    predictionWindAndNumericalBand: [Math.max(0, modelMin), modelMax],
    numericalAllowance,
    relativeError: nominal.flux / observed - 1,
    bandsOverlap: modelMin <= observationMax && modelMax >= observationMin,
  };
});

console.log(
  JSON.stringify(
    {
      source: 'Creyssels et al. (2009), DOI 10.1017/S0022112008005491, Table 1 and §2',
      fluxUnit: 'g m^-1 s^-1',
      comparison:
        'Settled, homogeneous tunnel interior using the published sand material and independently measured wind.',
      uncertainty:
        'Authors report 5% relative uncertainties on u* and collected flux. Air density inferred from rounded Table 1 Shields numbers; unknown systematic effects of feed, wall flow and collector efficiency are excluded from these bands.',
      setup:
        'Only fixed flat-bed wind stress is applied (hill correction off). Default saltation closure and seed, measured sand depth, open advection edges, and no observed flux or speed used in the simulation.',
      results,
    },
    null,
    2,
  ),
);
