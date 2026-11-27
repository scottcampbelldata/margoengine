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
    following.dispose();

    // Solid obstacle masking & wave reflection test (wall along x = 0).
    const obsField = Ripples.attach(engine, {
      surface: water,
      size: 32,
      resolution: 32,
      followCamera: false,
      speed: 3,
      damping: 0.4,
      obstacles: [{ kind: 'wall', from: [0, -16], to: [0, 16], thickness: 2 }],
    });
    engine.render({ delta: 0 });
    obsField.disturb(-5.5, 0.5, 2.5, 0.25);
    engine.render({ delta: 0 });
    const obsImpulse = await obsField.readFrame();
    // Advance enough frames for the wavefront to hit the wall at x = 0 and reflect back.
    for (let stepIdx = 0; stepIdx < 30; stepIdx++) engine.render({ delta: 1 / 120 });
    const obsAfter = await obsField.readFrame();
    // Verify other obstacle primitives + debug modes render cleanly.
    obsField.setObstacles([
      { kind: 'sphere', center: [4, 0, 0], radius: 2 },
      { kind: 'cylinder', center: [-4, 4], radius: 1.5 },
      { kind: 'box', center: [0, -5], halfExtents: [2, 1], rotation: 0.4 },
    ]);
    for (const cfg of [
      { enabled: true, mode: 'height', bounds: true },
      { enabled: true, mode: 'velocity', bounds: true },
      { enabled: true, mode: 'obstacles', bounds: false },
      false,
    ]) {
      obsField.setDebug(cfg);
      engine.render({ delta: 1 / 120 });
    }
    const obsPrimitives = await obsField.readFrame();
    obsField.dispose();

    // Moving-body coupling (trackBody) + disturbRay test.
    const bodyField = Ripples.attach(engine, {
      surface: water,
      size: 32,
      resolution: 32,
      followCamera: false,
      speed: 3,
      damping: 0.6,
    });
    const body = { position: [0, 3, 0] };
    bodyField.trackBody(body, { radius: 2, strength: 0.12 });
    engine.render({ delta: 0 });
    // Plunge into water -> automatic entry splash.
    body.position[1] = 0;
    engine.render({ delta: 1 / 60 });
    const afterSplash = await bodyField.readFrame();
    // Sweep horizontally -> automatic wake.
    body.position[0] = 3.5;
    engine.render({ delta: 1 / 60 });
    const afterWake = await bodyField.readFrame();
    bodyField.untrackBody(body);
    // Ray click disturbance.
    const rayHit = bodyField.disturbRay([-6.5, 10, -6.5], [0, -1, 0], 2, 0.2);
    engine.render({ delta: 0 });
    const afterRay = await bodyField.readFrame();
    bodyField.dispose();

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
      obsImpulse: Array.from(obsImpulse.data),
      obsAfter: Array.from(obsAfter.data),
      obsPrimitives: Array.from(obsPrimitives.data),
      afterSplash: Array.from(afterSplash.data),
      afterWake: Array.from(afterWake.data),
      rayHit,
      afterRay: Array.from(afterRay.data),
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

  // Verify solid wall reflection against an independent CPU Neumann finite-difference stepper.
  const isWall = (ix, iz) => Math.abs(-16 + (ix + 0.5)) <= 1.0 && iz >= 0 && iz < n;
  let cpuH = new Float64Array(n * n),
    cpuV = new Float64Array(n * n);
  for (let i = 0; i < n * n; i++) {
    cpuH[i] = result.obsImpulse[i * 2];
    cpuV[i] = result.obsImpulse[i * 2 + 1];
  }
  for (let s = 0; s < 30; s++) {
    const nextH = new Float64Array(n * n),
      nextV = new Float64Array(n * n);
    for (let z = 0; z < n; z++) {
      for (let x = 0; x < n; x++) {
        if (isWall(x, z)) continue;
        const idx = z * n + x,
          h = cpuH[idx],
          v = cpuV[idx];
        const sample = (nx, nz) => {
          if (nx < 0 || nz < 0 || nx >= n || nz >= n) return 0;
          return isWall(nx, nz) ? h : cpuH[nz * n + nx];
        };
        const lap = sample(x + 1, z) + sample(x - 1, z) + sample(x, z + 1) + sample(x, z - 1) - 4 * h;
        const edge = Math.min(x, z, n - 1 - x, n - 1 - z),
          t = Math.min(1, edge / 8),
          smooth = t * t * (3 - 2 * t);
        const nv = (v + lap * 9 * dt) * Math.exp(-(0.4 + 12 * (1 - smooth)) * dt);
        nextV[idx] = nv;
        nextH[idx] = h + nv * dt;
      }
    }
    cpuH = nextH;
    cpuV = nextV;
  }
  let reflectionError = 0,
    wallLeak = 0,
    farSideLeak = 0,
    leftEnergy = 0;
  for (let z = 0; z < n; z++) {
    for (let x = 0; x < n; x++) {
      const idx = z * n + x;
      const gh = result.obsAfter[idx * 2],
        gv = result.obsAfter[idx * 2 + 1];
      reflectionError = Math.max(reflectionError, Math.abs(gh - cpuH[idx]), Math.abs(gv - cpuV[idx]));
      const wx = -16 + (x + 0.5);
      if (isWall(x, z)) wallLeak = Math.max(wallLeak, Math.abs(gh), Math.abs(gv));
      if (wx > 1.5) farSideLeak = Math.max(farSideLeak, Math.abs(gh), Math.abs(gv));
      if (wx < -1.5) leftEnergy += gh * gh;
    }
  }
  assert.equal(wallLeak, 0, 'solid wall cells must remain strictly zero');
  assert.equal(farSideLeak, 0, 'waves must not leak across a solid wall');
  assert.ok(leftEnergy > 1e-4, 'reflected wave energy remains on incident side');
  assert.ok(reflectionError < 1e-5, `Neumann reflection PDE error ${reflectionError}`);

  // Verify sphere center cell inside obsPrimitives stays zero.
  assert.equal(result.obsPrimitives[(16 * n + 20) * 2], 0, 'sphere obstacle center stays zero');

  // Verify automatic trackBody entry splash, swept wake, and disturbRay.
  const splashPeak = result.afterSplash.reduce((m, v, i) => (i % 2 === 0 ? Math.max(m, Math.abs(v)) : m), 0);
  assert.ok(splashPeak > 0.01, `trackBody entry splash peak ${splashPeak}`);
  const wakeDiff = result.afterWake.some((v, i) => i % 2 === 0 && Math.abs(v - result.afterSplash[i]) > 0.005);
  assert.ok(wakeDiff, 'trackBody horizontal motion generates a swept wake');
  assert.deepEqual(result.rayHit, [-6.5, 0, -6.5]);
  // Cell for (-6.5, -6.5) is x = 9, z = 9.
  assert.ok(Math.abs(result.afterRay[(9 * n + 9) * 2] - result.afterWake[(9 * n + 9) * 2]) > 0.05, 'disturbRay injects impulse at hit cell');

  assert.equal(result.validation, undefined);
  assert.deepEqual(errors, []);
  const report = {
    hardware,
    impulseError,
    stepError,
    reflectionError,
    wallLeak,
    farSideLeak,
    splashPeak,
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
