import assert from 'node:assert/strict';
import test from 'node:test';
import { LightningBolt, channelLightPoints } from '@margoengine/sky/lightning-bolt';
import { Weather } from '@margoengine/sky/weather';
import { TerrainBed } from '../../dist/earth.js';
import { LIGHTNING_LAYOUT, LightningSolver } from '../../dist/lightning.js';
import { OutdoorSound } from '../../dist/outdoor-sound.js';
import { PhysicsWorld, regionWords, worldMemory } from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

const size = [5, 7, 5];
const spacing = 20;
const eps = 8.8541878128e-12;
const rate = { num: 60, den: 1 };
const settings = { spacing, size };
const make = (solver, options = {}, playback = rate, shared = false) =>
  new PhysicsWorld({ rate: playback, memory: worldMemory(shared) }).add(solver, { ...settings, ...options });

function near(actual, expected, bound) {
  assert.ok(Math.abs(actual - expected) <= bound, `${actual} vs ${expected} ± ${bound}`);
}

test('LightningSolver solves the Laplace and uniform-charge Poisson solutions between planes', async () => {
  const voltage = -3e6;
  const height = spacing * (size[1] - 1);
  const tolerance = 1e-10;
  for (const charge of [0, 2e-10, -2e-10]) {
    const lightning = await LightningSolver.load();
    make(lightning, { cloudPotential: voltage, charge: () => charge, tolerance });
    assert.ok(lightning.residual <= tolerance);
    for (let y = 0; y < size[1]; y++) {
      const h = y * spacing;
      const exact = (voltage * h) / height + (charge / (2 * eps)) * h * (height - h);
      // Each Jacobi correction is one sixth of the discrete residual. The error is bounded by solving
      // the same discrete Poisson problem with that constant residual and zero Dirichlet error.
      const allowed = 0.75 * (size[1] - 1) ** 2 * tolerance * Math.abs(voltage) + 1e-8;
      near(lightning.potentialAt(0, y, 3), exact, allowed);
      near(lightning.potentialAt(3, y, 0), exact, allowed);
    }
  }
});

test('live field receivers see a fixed layout and the return stroke reaches the actual terrain', async () => {
  const lightning = await LightningSolver.load();
  const terrain = new TerrainBed();
  const world = new PhysicsWorld({ rate });
  world.add(terrain, { rows: 1, columns: 1, width: 80, depth: 80, centre: [40, 40], elevations: [33, 33, 33, 33] });
  world.add(lightning, { ...settings, bed: terrain.bed, start: 0.1 });
  const observations = [];
  world.add(
    {
      describe: () => ({
        id: 'lightning-field-reader',
        rate: 0,
        stableRate: () => 0,
        fields: [lightning.channelField, lightning.thunderField].map((field) => ({ field, access: 'read' })),
      }),
      init(host) {
        this.memory = host.memory;
      },
      importPorts() {},
      step({ inputs }) {
        const ports = [...inputs.values()];
        if (ports.length !== 2) return;
        observations.push(
          ports.map(({ region }) => [region.layout, region.byteLength, regionWords(this.memory, region)[0]]),
        );
      },
      exportPorts: () => [],
      stateRegions: () => [],
      extraState: () => [],
    },
    {},
  );
  world.advance(6);
  assert.equal(lightning.flash, undefined);
  assert.deepEqual(lightning.thunder(), []);
  world.advance(24);
  const flash = lightning.flash;
  const channel = lightning.channel();
  assert.ok(flash);
  assert.equal(flash.position[1], 33);
  assert.deepEqual(channel.end, flash.position);
  near(flash.time, 0.1 + (channel.count * spacing) / 200000, Number.EPSILON);
  assert.ok(channel.count > channel.trunk && channel.trunk >= 5);
  let length = 0;
  let cursor = channel.start;
  for (let i = 0; i < channel.trunk; i++) {
    const at = i * 8;
    assert.deepEqual([...channel.segments.slice(at, at + 3)], cursor);
    assert.equal(channel.segments[at + 3], 0);
    const next = [...channel.segments.slice(at + 4, at + 7)];
    length += Math.hypot(...next.map((coordinate, axis) => coordinate - cursor[axis]));
    cursor = next;
  }
  assert.deepEqual(cursor, flash.position);
  near(length, channel.length, 64 * Number.EPSILON * length);
  assert.equal(lightning.brightness(flash.time), 0);
  assert.ok(lightning.brightness(flash.time + 0.001) > lightning.brightness(flash.time + 0.05));
  const first = observations[0];
  const last = observations.at(-1);
  assert.deepEqual(
    first.map((p) => p[2]),
    [0, 0],
  );
  assert.deepEqual(
    last.map((p) => p[2]),
    [channel.count, channel.count],
  );
  assert.deepEqual(
    first.map((p) => p.slice(0, 2)),
    last.map((p) => p.slice(0, 2)),
  );
  assert.ok(last.every(([layout]) => layout === LIGHTNING_LAYOUT));
});

test('the physical channel lights Sky and segment emission reaches SOUND-01 at acoustic time of flight', async () => {
  const lightning = await LightningSolver.load();
  const world = make(lightning);
  world.advance(12);
  const channel = lightning.channel();
  const weather = new Weather();
  using bolt = new LightningBolt({ weather, channel: () => channel });
  const strike = weather.strike({ distance: 100 });
  assert.equal(bolt.channelOf(strike), channel);
  const lights = weather.channelSource.lights(strike, 4, 600);
  assert.deepEqual(lights, channelLightPoints(channel, 4, 600));
  assert.ok(lights.some((light) => light.position[1] > 0 && light.weight > 0));

  const listener = [1000, 2, 25];
  const sources = lightning.thunder();
  const outdoor = new OutdoorSound();
  const acousticWorld = new PhysicsWorld({ rate }).add(outdoor, {
    links: sources.map(({ position }) => ({ source: position, listener })),
  });
  acousticWorld.advance(1);
  const speed = Math.sqrt(1.4 * 287.05 * 293.15);
  let arrival = Infinity;
  for (const [i, source] of sources.entries()) {
    const distance = Math.hypot(...listener.map((coordinate, axis) => coordinate - source.position[axis]));
    const expected = source.emissionTime + distance / speed;
    const heard = source.emissionTime + outdoor.read(i).delaySeconds;
    near(heard, expected, 32 * Number.EPSILON * expected);
    assert.ok(source.emissionTime > lightning.flash.time && source.weight > 0 && source.length <= spacing);
    arrival = Math.min(arrival, heard);
  }
  assert.ok(Number.isFinite(arrival) && arrival - lightning.flash.time > 2.5);
  const ground = sources.find(({ position, weight }) => position[1] === spacing / 2 && weight === 1);
  near(ground.emissionTime - lightning.flash.time, spacing / 2e8, 32 * Number.EPSILON);
});

test('LightningSolver has identical frame-rate, in-flight snapshot and shared-memory replay', async () => {
  const solver = await LightningSolver.load();
  const fresh = async () => await LightningSolver.load();
  const prepared = await Promise.all(Array.from({ length: 7 }, fresh));
  const options = { leaderSpeed: 120 };
  frameRateIndependent((playback) => make(prepared.pop(), options, playback), { seconds: 2 });
  seekEqualsContinuous(() => make(prepared.pop(), options, { num: 24, den: 1 }), { at: 12, frames: 48 });
  const a = make(solver, options);
  const b = make(prepared.pop(), options, rate, true);
  a.advance(30);
  b.advance(30);
  assert.ok(solver.channel().count > 0 && !solver.flash);
  assert.equal(a.hash(), b.hash());
  a.advance(120);
  b.advance(120);
  assert.equal(a.hash(), b.hash());
});
