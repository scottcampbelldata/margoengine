// Real-GPU checks for @margoengine/environment/gi: the live irradiance volume picks up the bounce off a sunlit red wall,
// follows the sun and the wall when they move (within one sweep), and holds still with live capture off; it comes back
// after a device restore. The volume's light is read back from the GPU and evaluated as the shaders do (irradianceAt).
import { Engine, PbrMaterial, box } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { DynamicGI } from '../dist/gi.js';
import { assert, hardware } from './gpu-read.js';

const unit = (v) => {
  const l = Math.hypot(...v);
  return v.map((x) => x / l);
};

window.runTests = async () => {
  const report = { checks: [] };
  const engine = await Engine.create(document.querySelector('#scene'), {
    backend: 'webgpu',
    camera: { position: [0, 1.5, 4], target: [0, 1, 0], fov: 60 },
  });
  const runtime = engineRuntime(engine),
    device = runtime.gpu,
    errors = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const sun = (x) => {
    // xyz toward the sun, w its intensity; radiance w is the ambient term, 0: all indirect light is the probes'.
    runtime.lighting.direction.set([...unit([x, 1, 0]), 1]);
    runtime.lighting.radiance.set([3, 3, 3, 0]);
  };
  sun(1);
  const white = { roughness: 1, metalness: 0, color: [0.8, 0.8, 0.8] };
  engine
    .createMesh()
    .setGeometry(box(6, 0.1, 6))
    .setPosition([0, -0.05, 0])
    .setMaterial(new PbrMaterial(white));
  const wall = engine
    .createMesh()
    .setGeometry(box(0.2, 3, 6))
    .setPosition([-2, 1.5, 0])
    .setMaterial(new PbrMaterial({ roughness: 1, metalness: 0, color: [0.8, 0.05, 0.05] }));
  const gi = DynamicGI.attach(engine, {
    min: [-1.8, 0, -2],
    max: [2, 2.5, 2],
    counts: [3, 2, 2],
    resolution: 8,
    probesPerFrame: 4,
  });
  const frames = (n) => {
    for (let i = 0; i < n; i++) engine.render({ culling: false });
  };
  // Irradiance / PI at a point 0.8 m in front of the wall, facing it, after a read back from the GPU.
  const probe = [-1.2, 1, 0],
    facing = [-1, 0, 0];
  const read = async () => {
    await gi.readback();
    return gi.irradianceAt(probe, facing);
  };
  const n = gi.sweepFrames;
  assert(n === 3, `12 probes at 4 a frame sweep in 3 frames, not ${n}`);

  // 1. One sweep lights the volume, exactly after sweepFrames frames.
  frames(n - 1);
  assert(gi.sweeps === 0, 'no sweep finished early');
  frames(1);
  assert(gi.sweeps === 1, `one sweep after ${n} frames, got ${gi.sweeps}`);
  frames(5 * n);
  const lit = await read();
  report.sunlit = lit;
  assert(lit[0] > 0 && lit[0] > 3 * lit[1], `the sunlit red wall bounces red light: ${lit}`);
  report.checks.push('one sweep in sweepFrames frames; the sunlit red wall bounces red light into the room');

  // 2. The sun moves behind the wall: within one sweep the red bounce falls.
  sun(-1);
  frames(n);
  const shaded = await read();
  report.sunBehindWall = shaded;
  assert(shaded[0] < 0.5 * lit[0], `the red bounce follows the sun: ${lit[0]} then ${shaded[0]}`);
  frames(5 * n);
  report.sunBehindWallSettled = await read();
  report.checks.push('the sun moves behind the wall: the red bounce falls within one sweep');

  // 3. Live capture off: the light holds still whatever the scene does (the control for checks 2 and 4).
  const before = await read();
  gi.setLiveVolume(null);
  sun(1);
  frames(3 * n);
  const held = await read();
  assert(
    held.every((v, k) => v === before[k]),
    `live capture off changed the light: ${before} then ${held}`,
  );
  gi.setLiveVolume({ probesPerFrame: 4 });
  frames(6 * n);
  const relit = await read();
  assert(relit[0] > 0.8 * lit[0], `live again, the red bounce returns: ${relit}`);
  report.checks.push('with live capture off the light holds still; on again it follows');

  // 4. The wall moves away (under the floor): within one sweep the red bounce falls.
  wall.setPosition([-2, -40, 0]);
  frames(n);
  const gone = await read();
  report.wallMoved = gone;
  assert(gone[0] < 0.5 * relit[0], `the red bounce follows the wall: ${relit[0]} then ${gone[0]}`);
  report.checks.push('the wall moves away: the red bounce falls within one sweep');

  // 5. A device restore: the volume lights again after a sweep on the new device.
  wall.setPosition([-2, 1.5, 0]);
  await engine.rebootDevice();
  const fresh = engineRuntime(engine).gpu;
  fresh.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  frames(6 * n);
  const restored = await read();
  assert(restored[0] > 0.8 * lit[0], `after a device restore the red bounce returns: ${restored}`);
  report.checks.push('a device restore relights the volume after a sweep');

  assert(errors.length === 0, `GPU errors: ${errors.join('; ')}`);
  report.hardware = hardware({ info: fresh.adapterInfo });
  gi.dispose();
  engine.dispose();
  return report;
};
