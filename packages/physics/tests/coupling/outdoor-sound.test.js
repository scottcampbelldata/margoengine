import assert from 'node:assert/strict';
import test from 'node:test';
import { BoundaryLayerWind } from '@margoengine/weather/boundary-layer';
import { TerrainBed } from '../../dist/earth.js';
import {
  OUTDOOR_SOUND_BANDS,
  OUTDOOR_SOUND_LAYOUT,
  OutdoorSound,
  aviationNWave,
  outdoorAirAbsorption,
  outdoorDiffractionLoss,
} from '../../dist/outdoor-sound.js';
import { PhysicsWorld, worldMemory } from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

const speed = Math.sqrt(1.4 * 287.05 * 293.15);
const rate = { num: 60, den: 1 };
const tolerance = 24 * Number.EPSILON;
function close(actual, expected, allowed = tolerance * Math.max(1, Math.abs(expected))) {
  assert.ok(Math.abs(actual - expected) <= allowed, `${actual} versus ${expected} ± ${allowed}`);
}
function make(links, params = {}, options = {}) {
  const solver = new OutdoorSound();
  const world = new PhysicsWorld({ rate, ...options }).add(solver, { links, ...params });
  return { world, solver };
}

test('PA-64: the three-kilometre acoustic arrival follows sound speed and ISO absorption', () => {
  const { world, solver } = make([{ source: [0, 5, 0], listener: [3000, 5, 0] }]);
  world.advance(1);
  const path = solver.read();
  close(path.delaySeconds, 3000 / speed);
  close(path.distance, 3000);
  const expectedLoss = outdoorAirAbsorption(1000) * 3000;
  close(path.airLossDb[4], expectedLoss);
  close(path.gainDb[4], -20 * Math.log10(3000) - expectedLoss);
  assert.ok(path.airLossDb[7] > 10 * path.airLossDb[4]);
  const [port] = solver.exportPorts(1);
  assert.equal(port.field, solver.field.name);
  assert.equal(port.region.layout, OUTDOOR_SOUND_LAYOUT);
  assert.equal(port.region.type, 'f64');
});

test('air absorption agrees with ISO 9613-1 Table 1(e) at zero Celsius', () => {
  // 1,000 Hz and 50% humidity at one atmosphere: 6.83 dB/km, printed to two decimal places.
  close(outdoorAirAbsorption(1000, 273.15, 0.5) * 1000, 6.83, 0.005);
  assert.equal(outdoorAirAbsorption(0), 0);
  assert.throws(() => outdoorAirAbsorption(1000, 293.15, -0.2), /humidity/);
});

test('an oppositely directed wind changes time of flight and a vertical gradient bends the path', () => {
  const forward = { source: [0, 20, 0], listener: [400, 20, 0] };
  const backward = { source: forward.listener, listener: forward.source };
  const air = {
    medium: 'air',
    cell: [0, 0, 0],
    sample: () => ({ velocity: [10, 0, 0], density: 101325 / (287.05 * 293.15), temperature: 293.15 }),
  };
  const still = make([forward, backward], { air });
  still.world.advance(1);
  close(still.solver.read(0).delaySeconds, 400 / (speed + 10));
  close(still.solver.read(1).delaySeconds, 400 / (speed - 10));
  const gradient = make([forward], {
    air: { ...air, sample: (_x, y) => ({ ...air.sample(), velocity: [10 + 0.01 * (y - 20), 0, 0] }) },
  });
  gradient.world.advance(1);
  const path = gradient.solver.read();
  close(path.midpointY, 20 + (0.01 * 400 * 400) / (8 * (speed + 10)));
});

test('a real terrain ridge delays arrival and diffracts octave bands by their wavelengths', () => {
  const world = new PhysicsWorld({ rate });
  const terrain = new TerrainBed();
  world.add(terrain, { rows: 1, columns: 2, width: 10, depth: 8, centre: [0, 0], elevations: [0, 0, 10, 10, 0, 0] });
  const solver = new OutdoorSound();
  world.add(solver, { bed: terrain.bed, links: [{ source: [-20, 2, 0], listener: [20, 2, 0] }] });
  world.advance(1);
  const path = solver.read();
  assert.equal(path.blocked, true);
  close(path.delaySeconds, (2 * Math.hypot(20, 8)) / speed);
  for (let i = 0; i < OUTDOOR_SOUND_BANDS.length; i++)
    close(path.diffractionDb[i], outdoorDiffractionLoss(8 * Math.sqrt((2 * OUTDOOR_SOUND_BANDS[i]) / (10 * speed))));
  assert.ok(path.diffractionDb[7] > path.diffractionDb[0]);
});

test('the weather boundary layer makes the downwind path arrive before the upwind path', () => {
  const air = new BoundaryLayerWind({ speed: 12, referenceHeight: 10, turbulence: false });
  const stillAir = new BoundaryLayerWind({ speed: 0, referenceHeight: 10, turbulence: false });
  const links = [
    { source: [0, 10, 0], listener: [100, 10, 0] },
    { source: [100, 10, 0], listener: [0, 10, 0] },
  ];
  const windy = make(links, { air }),
    still = make(links, { air: stillAir });
  windy.world.advance(1);
  still.world.advance(1);
  const calmArrival = still.solver.read(0).delaySeconds;
  assert.ok(windy.solver.read(0).delaySeconds < calmArrival && windy.solver.read(1).delaySeconds > calmArrival);
  assert.equal(calmArrival, still.solver.read(1).delaySeconds);
});

test('the ground reflection follows coherent direct and image path lengths', () => {
  const source = [0, 1, 0],
    listener = [5, 1, 0];
  const free = make([{ source, listener }]);
  const hard = make([{ source, listener }], { groundY: 0 });
  free.world.advance(1);
  hard.world.advance(1);
  const direct = 5,
    image = Math.hypot(5, 2),
    difference = 4 / (image + direct);
  for (let i = 0; i < OUTDOOR_SOUND_BANDS.length; i++) {
    const frequency = OUTDOOR_SOUND_BANDS[i];
    const ratio = (direct / image) * 10 ** ((-outdoorAirAbsorption(frequency) * difference) / 20);
    const angle = (2 * Math.PI * frequency * difference) / speed;
    const power = 1 + ratio * ratio + 2 * ratio * Math.cos(angle);
    // Two rounded logarithms are subtracted. Phase roundoff is amplified by 2 r / power at a cancellation notch.
    const roundoff = Number.EPSILON * (48 + (16 * angle * ratio * 10) / (power * Math.LN10));
    close(hard.solver.read().gainDb[i] - free.solver.read().gainDb[i], 10 * Math.log10(power), roundoff);
  }
});

test('a rigid planar reflector doubles pressure for a source on its surface', () => {
  const links = [{ source: [0, 0, 0], listener: [10, 1, 0] }];
  const free = make(links);
  const plane = make(links, { groundY: 0 });
  free.world.advance(1);
  plane.world.advance(1);
  close(plane.solver.read().gainDb[4] - free.solver.read().gainDb[4], 20 * Math.log10(2));
});

test('the civil aviation N-wave has a delayed symmetric signed pressure envelope', () => {
  const duration = 0.2,
    rise = 0.01;
  assert.equal(aviationNWave(-0.0001, duration, 5, rise), 0);
  assert.equal(aviationNWave(duration, duration, 5, rise), 0);
  close(aviationNWave(rise, duration, 5, rise), 5);
  close(aviationNWave(duration - rise, duration, 5, rise), -5);
  for (const time of [0.001, 0.03, 0.08])
    close(aviationNWave(time, duration, 5, rise), -aviationNWave(duration - time, duration, 5, rise));
});

test('moving links replay through frame rates, snapshots, and both world memory modes', () => {
  const links = [{ source: (time) => [0, 1.5, 0.8 * time], listener: [50, 1.4, 0] }];
  const worldAt = (rate, memory) => make(links, { groundY: 0, groundReflection: 0.65 }, { rate, memory }).world;
  frameRateIndependent((frameRate) => worldAt(frameRate));
  seekEqualsContinuous(() => worldAt(rate));
  const plain = worldAt(rate, worldMemory(false)),
    shared = worldAt(rate, worldMemory(true));
  plain.advance(120);
  shared.advance(120);
  assert.equal(plain.hash(), shared.hash());
});
