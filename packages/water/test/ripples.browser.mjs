import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
await mkdir('test-results', { recursive: true });
const browser = await openBrowser({ port: 'free', startPath: '/tests/modern-game.html' });
const { page, hardware } = browser,
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
// NOAA NDBC observation, public-domain data already attributed beside this fixture.
const observation = (await readFile(new URL('./data/46042-20230101.txt', import.meta.url), 'utf8'))
  .trim()
  .split('\n')[2]
  .trim()
  .split(/\s+/)
  .map(Number);
try {
  const result = await page.evaluate(async (observation) => {
    const { EngineKernel } = await import('/packages/core/dist/index.js');
    const { Water } = await import('/packages/water/dist/index.js');
    const { Ripples } = await import('/packages/water/dist/ripples.js');
    const { WaveQuery } = await import('/packages/water/dist/query.js');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:160px;height:128px';
    document.body.replaceChildren(canvas);
    const engine = await EngineKernel.create(canvas, {
      backend: 'webgpu',
      capacity: 8,
      camera: { position: [0, 12, 12], target: [0, 0, 0], near: 0.1, far: 100 },
    });
    const gpu = engine.gpu;
    gpu.pushErrorScope('validation');
    const water = Water.attach(engine, {
      size: [32, 32],
      segments: 64,
      waves: [{ direction: [1, 0], amplitude: 0, wavelength: 10 }],
    });
    const ripples = Ripples.attach(engine, {
      surface: water,
      size: 32,
      resolution: 32,
      followCamera: false,
      speed: 3,
      damping: 0.6,
    });
    engine.render({ delta: 0 });
    const flat = await ripples.readFrame();
    ripples.disturb(0.5, 0.5, 3, 0.2);
    engine.render({ delta: 0 });
    const impulse = await ripples.readFrame();
    engine.render({ delta: 1 / 120 });
    const step = await ripples.readFrame();
    const query = await WaveQuery.capture(water);
    const height = query.heightAt(0.5, 0.5);
    const velocity = query.velocityAt(0.5, 0.5);
    const angle = (observation[5] * Math.PI) / 180;
    ripples.wake([-5 * Math.sin(angle), -5 * Math.cos(angle)], [0, 0], 2, 0.1);
    engine.render({ delta: 0 });
    const wake = await ripples.readFrame();
    ripples.dispose();
    const following = Ripples.attach(engine, { surface: water, size: 32, resolution: 32 });
    engine.render({ delta: 0 });
    following.disturb(0.5, 12.5, 3, 0.2);
    engine.render({ delta: 0 });
    const before = await following.readFrame();
    engine.camera.position = [2, 12, 12];
    engine.render({ delta: 0 });
    const moved = await following.readFrame();
    engine.camera.position = [100, 12, 12];
    engine.render({ delta: 0 });
    const teleported = await following.readFrame();
    following.onDeviceRestored(engine);
    engine.render({ delta: 0 });
    const restored = await following.readFrame();
    const validation = await gpu.popErrorScope();
    engine.dispose();
    return {
      flat: Array.from(flat.data),
      impulse: Array.from(impulse.data),
      step: Array.from(step.data),
      wake: Array.from(wake.data),
      height,
      velocity,
      before: { origin: before.origin, data: Array.from(before.data) },
      moved: { origin: moved.origin, data: Array.from(moved.data) },
      teleported: Array.from(teleported.data),
      restored: Array.from(restored.data),
      validation: validation?.message,
    };
  }, observation);
  assert.ok(result.flat.every((v) => v === 0));
  let impulseError = 0,
    stepError = 0;
  const n = 32,
    dt = 1 / 120,
    at = (x, z) => (x < 0 || z < 0 || x >= n || z >= n ? 0 : result.impulse[(z * n + x) * 2]);
  for (let z = 0; z < n; z++)
    for (let x = 0; x < n; x++) {
      const q = ((x - 16) ** 2 + (z - 16) ** 2) / 9;
      const expected = q < 1 ? 0.2 * (1 - q) ** 2 * (1 - 4 * q) : 0;
      impulseError = Math.max(impulseError, Math.abs(result.impulse[(z * n + x) * 2] - expected));
      const h = at(x, z),
        lap = at(x - 1, z) + at(x + 1, z) + at(x, z - 1) + at(x, z + 1) - 4 * h;
      const edge = Math.min(x, z, n - 1 - x, n - 1 - z),
        t = Math.min(1, edge / 8),
        smooth = t * t * (3 - 2 * t);
      const v = lap * 9 * dt * Math.exp(-(0.6 + 12 * (1 - smooth)) * dt);
      stepError = Math.max(
        stepError,
        Math.abs(result.step[(z * n + x) * 2] - (h + v * dt)),
        Math.abs(result.step[(z * n + x) * 2 + 1] - v),
      );
    }
  assert.ok(impulseError < 1e-6, `impulse error ${impulseError}`);
  assert.ok(stepError < 1e-6, `independent PDE error ${stepError}`);
  assert.ok(
    Math.abs(result.height - result.step[(16 * n + 16) * 2]) < 1e-6,
    'drawn/query geometry includes the height field',
  );
  assert.ok(
    Math.abs(result.velocity[1] - result.step[(16 * n + 16) * 2 + 1]) < 1e-6,
    'query includes vertical ripple velocity',
  );
  assert.ok(result.wake.some((v, i) => Math.abs(v - result.step[i]) > 0.001));
  assert.equal(result.moved.origin[0] - result.before.origin[0], 2);
  for (let z = 0; z < n; z++)
    for (let x = 0; x < n - 2; x++)
      for (let k = 0; k < 2; k++)
        assert.equal(
          result.moved.data[(z * n + x) * 2 + k],
          result.before.data[(z * n + x + 2) * 2 + k],
          'camera shift preserves world waves',
        );
  assert.ok(result.teleported.every((v) => v === 0));
  assert.ok(result.restored.every((v) => v === 0));
  assert.equal(result.validation, undefined);
  assert.deepEqual(errors, []);
  const report = {
    hardware,
    impulseError,
    stepError,
    queryHeight: result.height,
    scroll: true,
    teleport: true,
    restore: true,
    observation: { station: '46042', utc: '2023-01-01T00:00:00Z', windFrom: observation[5] },
  };
  await writeFile(
    `test-results/water-ripples-${browser.hardware?.compat ? 'compat' : 'webgpu'}.json`,
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
} finally {
  await browser.close();
}
