import test from 'node:test';
import assert from 'node:assert/strict';
import { GrassField } from '../dist/grass.js';
import { Planet } from '../dist/planet.js';
import { Stars } from '../dist/stars.js';
import { HDRRenderTarget } from '../dist/targets.js';
import { ToonShading } from '../dist/toon.js';
import { GPUParticles } from '../dist/particles.js';

// Behaviour of the creative entries that need no GPU: option validation, plugin registration and the coded errors a
// developer sees. Every message must name its fix (a '; ' clause), and the coded ones carry a stable `code`.
const namesFix = (error) => /;/.test(error.message);
const engine = () => {
  const plugins = [];
  return { plugins, use: (plugin) => plugins.push(plugin) };
};

test('GrassField registers itself, exposes its blade count and validates every option', () => {
  const e = engine();
  const grass = GrassField.attach(e, { blades: 1000, windSpeed: 2 });
  assert.deepEqual(e.plugins, [grass]);
  assert.equal(grass.blades, 1000);
  assert.match(grass.name, /^grass-field:\d+$/);
  for (const options of [
    { blades: 0 },
    { blades: 1.5 },
    { blades: 20_000_000 },
    { area: [0, 10] },
    { bladeHeight: -1 },
    { drawDistance: 0 },
    { windDirection: [0, 0] },
    { spores: 'yes' },
  ])
    assert.throws(
      () => GrassField.attach(engine(), options),
      (error) => error instanceof RangeError && namesFix(error),
      JSON.stringify(options),
    );
  assert.throws(() => (grass.windSpeed = 101), RangeError);
  assert.throws(() => (grass.windStrength = 3), RangeError);
  assert.throws(() => (grass.windTime = -1), RangeError);
});

test('GrassField without WebGPU reports unsupported and names the fix', () => {
  const grass = GrassField.attach(engine(), {});
  assert.throws(
    () => grass.setup({ gpu: undefined }),
    (error) => error.name === 'MargoError' && error.code === 'unsupported' && /WebGPU/.test(error.message),
  );
});

test('Stars registers as creative:stars, is enabled by default and needs WebGPU', () => {
  const e = engine();
  const stars = Stars.attach(e);
  assert.deepEqual(e.plugins, [stars]);
  assert.equal(stars.name, 'creative:stars');
  assert.equal(stars.enabled, true);
  assert.throws(
    () => stars.setup({ gpu: undefined }),
    (error) => error.name === 'MargoError' && error.code === 'unsupported',
  );
});

test('HDRRenderTarget rejects sizes outside 1..min(4096, device limit) with a message that gives the range', () => {
  const device = { limits: { maxTextureDimension2D: 2048 }, features: new Set() };
  for (const [width, height] of [
    [0, 10],
    [10, 0],
    [3000, 10],
    [10, 5000],
    [1.5, 10],
    [Number.NaN, 10],
  ])
    assert.throws(
      () => new HDRRenderTarget(device, width, height, 1),
      (error) => error instanceof RangeError && /1 and min\(4096/.test(error.message),
      `${width}x${height}`,
    );
});

test('Planet rejects bad options before touching the GPU, with errors that say what to pass', async () => {
  await assert.rejects(
    Planet.create(engine(), { dayMap: '/day.png', radius: -1 }),
    (error) => error instanceof RangeError && /positive/.test(error.message),
  );
  await assert.rejects(
    Planet.create(engine(), { dayMap: '/day.png', atmosphere: { color: [-1, 0, 0] } }),
    (error) => error instanceof RangeError && /non-negative/.test(error.message),
  );
});

test('ToonShading and GPUParticles name the valid ranges in their option errors', () => {
  assert.throws(
    () => new ToonShading({ bands: 1 }),
    (error) => error instanceof RangeError && /bands 2\.\.16/.test(error.message),
  );
  assert.throws(
    () => new ToonShading({ rim: 2 }),
    (error) => error instanceof RangeError && /rim 0\.\.1/.test(error.message),
  );
  assert.throws(
    () => new GPUParticles({ curl: 11 }),
    (error) => error instanceof RangeError && /curl 0\.\.10/.test(error.message),
  );
});
