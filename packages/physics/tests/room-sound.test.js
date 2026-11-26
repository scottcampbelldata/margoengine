import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acousticBox,
  renderRoomImpulse,
  roomArrivals,
  roomDecayTime,
  roomEnergyDecay,
  RoomSoundSolver,
} from '../dist/room-sound.js';
import { PhysicsWorld, worldMemory } from '../dist/world.js';

const rate = { num: 60, den: 1 };
const bands = [0.8, 0.5, -0.25];
const walls = acousticBox([0, 0, 0], [8, 4, 6], bands);
const source = [2, 1, 3];
const listener = [5, 1, 3];

function near(actual, expected, ulps = 128, scale = 1) {
  assert.ok(
    Math.abs(actual - expected) <= ulps * Number.EPSILON * Math.max(scale, Math.abs(expected)),
    `${actual} versus ${expected}`,
  );
}

test('a sealed box matches the direct and six independent Allen–Berkley first-order paths', () => {
  const responses = roomArrivals({ source, listener, surfaces: walls, order: 1 });
  assert.equal(responses.length, 7);
  const direct = responses[0];
  assert.deepEqual(direct.reflections, []);
  assert.deepEqual(direct.points, [source, listener]);
  assert.deepEqual(direct.direction, [-1, 0, 0]);
  near(direct.delay, 3 / 343);
  for (const [wall, distance] of [7, 9, Math.sqrt(13), Math.sqrt(45), Math.sqrt(45), Math.sqrt(45)].entries()) {
    const arrival = responses.find((p) => p.reflections[0] === wall);
    near(arrival.distance, distance);
    near(arrival.delay, distance / 343);
    for (let band = 0; band < 3; band++) near(arrival.gains[band], bands[band] / distance);
  }
});

test('CONCERT-HALL-1: a finite twice-reflected path exposes the correct cutaway bounce points and incident direction', () => {
  const responses = roomArrivals({ source, listener, surfaces: walls, order: 2 });
  const bounce = responses.find((p) => p.reflections.join() === '0,2');
  assert.ok(bounce, 'the source reflected first off the side then the floor');
  assert.deepEqual(bounce.points[0], source);
  near(bounce.points[1][0], 0);
  near(bounce.points[1][1], 3 / 7);
  near(bounce.points[2][0], 1.5);
  near(bounce.points[2][1], 0);
  assert.deepEqual(bounce.points[3], listener);
  near(bounce.delay, Math.sqrt(53) / 343);
  near(bounce.gains[1], 0.25 / Math.sqrt(53));
  near(bounce.direction[1], -1 / Math.sqrt(13.25));
});

test('a finite wall blocks the direct path, and an opening admits a direct ray only through its clear area', () => {
  const panel = {
    vertices: [
      [4, 0, 1],
      [4, 2, 1],
      [4, 2, 5],
      [4, 0, 5],
    ],
    reflection: 0,
  };
  assert.deepEqual(roomArrivals({ source, listener, surfaces: [panel], order: 0 }), []);
  const opening = roomArrivals({ source: [2, 3, 3], listener: [5, 3, 3], surfaces: [panel], order: 0 });
  assert.equal(opening.length, 1);
  near(opening[0].delay, 3 / 343);
});

test('the causal fractional impulse keeps signed pressure and its first time moment', () => {
  const at = { delay: 23.25 / 48000, gains: [-0.25, 0.5, 1] };
  const pcm = renderRoomImpulse(48000, [at], 0);
  assert.equal(pcm.length, 25);
  assert.ok(pcm.subarray(0, 23).every((value) => value === 0));
  assert.equal(pcm[23], -0.1875);
  assert.equal(pcm[24], -0.0625);
  assert.equal(23 * pcm[23] + 24 * pcm[24], -0.25 * 23.25);
});

test('Eyring decay and Schroeder integrated response have exact energy references', () => {
  const rt60 = roomDecayTime(192, 208, 0.25);
  const collisionsPerSecond = (343 * 208) / (4 * 192);
  near(0.75 ** (collisionsPerSecond * rt60), 1e-6, 128, 1e-6);
  const nearLive = roomDecayTime(192, 208, 1e-18);
  assert.ok(Number.isFinite(nearLive));
  near(nearLive * 1e-18, (6 * Math.log(10)) / collisionsPerSecond);
  assert.equal(roomDecayTime(192, 208, 0), Infinity);
  assert.equal(roomDecayTime(192, 208, 1), 0);
  const p = Float64Array.from({ length: 24 }, (_, i) => 0.8 ** i);
  const integrated = roomEnergyDecay(p);
  for (let i = 0; i < p.length; i++) {
    near(integrated[i], (0.64 ** i - 0.64 ** p.length) / (1 - 0.64 ** p.length));
  }
  assert.deepEqual(Array.from(roomEnergyDecay([0, 0])), [0, 0]);
});

test('a rigid closed axis follows the discrete Neumann standing mode in both memory modes', async () => {
  const count = 16;
  const k = (2 * Math.PI) / count;
  const pressure = Float64Array.from({ length: count }, (_, i) => Math.cos(k * (i + 0.5)));
  const spectral = 1 - 0.25 * (1 - Math.cos(k));
  const theta = Math.acos(spectral);
  for (const memory of [worldMemory(false), worldMemory(true)]) {
    const room = await RoomSoundSolver.load();
    const world = new PhysicsWorld({ rate, memory }).add(room, {
      grid: { dimensions: [count, 1, 1], spacing: 2, reflection: 1 },
      source: [0, 0, 0],
      receiver: [4, 0, 0],
      speedOfSound: 60,
      initialPressure: pressure,
      impulse: 0,
    });
    for (let frame = 1; frame <= 75; frame++) {
      world.advance(frame);
      const trace = room.readTrace();
      assert.equal(trace.sampleRate, 60);
      assert.equal(trace.firstSample, frame);
      const envelope = Math.cos((frame + 0.5) * theta) / Math.cos(0.5 * theta);
      for (const x of [0, 4, 7, 15]) near(room.pressureAt([x, 0, 0]), pressure[x] * envelope, 500);
      assert.equal(trace.values[0], room.pressureAt([4, 0, 0]));
    }
  }
});

test('the production consumer retains both feature-local native files', { timeout: 30_000 }, async () => {
  const { mkdirSync, readFileSync, readdirSync, writeFileSync } = await import('node:fs');
  const { join, resolve } = await import('node:path');
  const { build } = await import('vite');
  const root = resolve(import.meta.dirname, '../../../test-results/room-sound-consumer', String(process.pid));
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'index.html'), '<script type="module" src="./main.js"></script>');
  writeFileSync(
    join(root, 'main.js'),
    'import {RoomSoundSolver} from "@margoengine/physics/room-sound"; window.roomSound = () => RoomSoundSolver.load();',
  );
  await build({ root, configFile: false, publicDir: false, logLevel: 'warn', build: { target: 'es2022' } });
  const assets = join(root, 'dist/assets');
  const files = readdirSync(assets);
  for (const base of ['room-sound-kernel', 'room-sound-kernel-shared']) {
    const names = files.filter(
      (name) =>
        name.startsWith(base + '-') &&
        name.endsWith('.wasm') &&
        (base.endsWith('shared') || !name.startsWith('room-sound-kernel-shared-')),
    );
    assert.equal(names.length, 1, `its own ${base} asset`);
    assert.deepEqual(
      readFileSync(join(assets, names[0])),
      readFileSync(new URL(`../dist/${base}.wasm`, import.meta.url)),
    );
  }
});
