// Run after building Physics: node packages/physics/scripts/sea15-jet-scour-measured.mjs
// Mohamadiyeh, Peakall, Fairweather, Barnes & Hunter (2026), AIChE Journal, doi:10.1002/aic.70336.
// Leeds measured sediment profiles, CC BY 4.0: https://doi.org/10.5518/1730
import assert from 'node:assert/strict';
import { TerrainBed } from '../dist/earth.js';
import { SWIM_WAKE_FIELD, SWIM_WAKE_LAYOUT } from '../dist/life.js';
import { TracerSolver } from '../dist/tracers.js';
import { PhysicsWorld, regionWords } from '../dist/world.js';

const duration = 90;
const sampleRate = 60;
const channelWidth = 0.5;
const waterLevel = 0.37;
const thickness = 0.03;
// §2.3 reports about 60% solids in separate material tests. Jet-run bed porosity was not measured.
const porosity = 0.4;
const density = 1000; // Nominal freshwater density; the experiment did not report water temperature.
const grainDensity = 2500;
const grainDiameter = 208e-6;
const nozzleDiameter = 0.006;
const discharge = 3.04e-3 / 60;
const nozzleArea = (Math.PI * nozzleDiameter ** 2) / 4;
const exitSpeed = discharge / nozzleArea;
const momentumPerSecond = density * discharge * exitSpeed;
const radiusOfComparison = 0.15;
const packedDensity = grainDensity * (1 - porosity);
const capacity = 32768;

// Figure_9.zip SHA-256 6125c5e8c2a3c855a7f7e78a4ff7dd6c4d4072235a9e9cb940961e06f9777d47.
// H12_7.mat and H12_8.mat are the 6 mm-nozzle profiles in Fig. 9, h/D 10 and 20, respectively.
// Their smoothed_BedHeight1 and distance.mat give mm above the tank floor and radial mm from the
// jet center. Prepend r=0 with the first depth. Exactly integrate 2*pi*r*max(0, 30 mm - z(r))
// over the published 150 mm radius with linear depth between samples. For the comparison range,
// offset the measured datum by ±0.74 mm (one UVP channel, paper Table 3) and radial samples by
// ±1 mm (one traverse sample, §2.6), clamping shifted radii at zero. This is measurement-resolution
// sensitivity. Prep thickness is nominal and neither volume repeatability nor uncertainty in
// azimuthal symmetry is published. The 20D record still approaches nominal bed level at the edge.
// Only these derived volumes are transcribed, in cm³. No original data or analysis code is bundled.
const observations = [
  { heightRatio: 10, deficitsCM3: [57.49065, 47.40727, 68.74866] },
  { heightRatio: 20, deficitsCM3: [116.47445, 101.45443, 141.0531] },
];

class LaboratoryJet {
  constructor(height) {
    this.height = height;
  }

  describe() {
    return { id: 'jet', fields: [{ field: SWIM_WAKE_FIELD, access: 'write' }], rate: 0, stableRate: () => 0 };
  }

  init(host) {
    // Layout 1 is [source xyz in m, momentum impulse xyz in N s, nozzle radius in m, active].
    this.host = host;
    this.region = host.allocate('nozzle', 8 * Float64Array.BYTES_PER_ELEMENT, 'f64', SWIM_WAKE_LAYOUT);
  }

  step({ tick }, dt) {
    const active = Number(tick < duration * sampleRate);
    regionWords(this.host.memory, this.region).set([
      0,
      this.height,
      0,
      0,
      -momentumPerSecond * dt * active,
      0,
      nozzleDiameter / 2,
      active,
    ]);
  }

  exportPorts(tick) {
    return [{ field: SWIM_WAKE_FIELD.name, region: this.region, tick, cell: [0, 0, 0] }];
  }

  importPorts() {}

  stateRegions() {
    return [this.region];
  }

  extraState() {
    return [];
  }
}

function bedDeficit(terrain, cells) {
  const radius = radiusOfComparison;
  const spacing = (2 * radius) / cells;
  let sum = 0;
  for (let i = 0; i < cells; i++) {
    const x = -radius + (i + 0.5) * spacing;
    for (let j = 0; j < cells; j++) {
      const z = -radius + (j + 0.5) * spacing;
      if (x * x + z * z < radius * radius) sum += Math.max(0, -terrain.bed.sample(x, z).elevation);
    }
  }
  return sum * spacing ** 2;
}

function simulate(heightRatio, divisions) {
  const jet = new LaboratoryJet(heightRatio * nozzleDiameter);
  const bed = new TerrainBed();
  const tracer = TracerSolver.withBedChange();
  const world = new PhysicsWorld({ rate: { num: sampleRate, den: 1 } })
    .add(jet, {})
    .add(bed, {
      columns: divisions,
      rows: divisions,
      width: channelWidth,
      depth: channelWidth,
      elevations: () => 0,
      bedrock: () => -thickness,
    })
    .add(tracer, {
      waterLevel,
      waterDensity: density,
      viscosity: 1e-6,
      bed: bed.bed,
      bedJets: {
        grains: { density: grainDensity, diameter: grainDiameter, shape: 0.4, colour: [0.6, 0.6, 0.6] },
        mobileLayer: { thickness, porosity },
      },
      // The normal nozzle delivers pickup momentum but does not supply a resolved water velocity to the parcels.
      // Compare the actual as-shipped pickup and still-water redeposition path, without a fitted flow surrogate.
      horizontalDiffusivity: 0,
      verticalDiffusivity: 0,
      seed: 17,
      // Settled records retain their slots. The 90 s jet can emit four new parcels each 60 Hz tick.
      capacity,
    })
    .couple(['jet', 'tracers', 'bed'], 'staggered');
  world.advance(duration * sampleRate);
  const pickup = tracer.jetErosion;
  const suspended = tracer.budget.water;
  const activeDeficit = bedDeficit(bed, 4 * divisions);
  world.advance((duration + 3) * sampleRate);
  assert.equal(tracer.jetErosion, pickup, 'The laboratory jet stops at 90 s.');
  const particles = Array.from(tracer.particlesOf());
  assert.ok(particles.length < capacity, 'Expected spare parcel capacity throughout the experiment.');
  assert.ok(!particles.some(({ state }) => state === 'water'), 'Expected all parcels to settle.');
  return {
    divisions,
    pickup,
    suspended,
    parcels: particles.length,
    settledWaterLedgerKg: tracer.budget.water,
    bedrockRefusedM3: bed.refusedVolume(),
    activeDeficitCM3: 1e6 * activeDeficit,
    settledDeficitCM3: 1e6 * bedDeficit(bed, 4 * divisions),
    signedWholeTankDeficitCM3: -1e6 * bed.volume(0),
  };
}

for (const { heightRatio, deficitsCM3 } of observations) {
  const [observedDeficitCM3, lower, upper] = deficitsCM3;
  const [coarse, fine] = [50, 100].map((divisions) => simulate(heightRatio, divisions));
  const gridAllowanceCM3 = Math.abs(coarse.settledDeficitCM3 - fine.settledDeficitCM3);
  const lowerBoundOnMobilizedKg = (lower * packedDensity) / 1e6;
  console.log(
    JSON.stringify({
      heightRatio,
      exitSpeed,
      observedDeficitCM3,
      resolutionBandCM3: [lower, upper],
      settledWithinBand:
        fine.settledDeficitCM3 + gridAllowanceCM3 >= lower && fine.settledDeficitCM3 - gridAllowanceCM3 <= upper,
      lowerBoundOnMobilizedKg,
      grossExceedsObservedDeficitMassLowerBound: fine.pickup >= lowerBoundOnMobilizedKg,
      gridAllowanceCM3,
      coarse,
      fine,
    }),
  );
}
