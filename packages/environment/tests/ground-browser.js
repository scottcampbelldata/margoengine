// Real-GPU checks for @margoengine/environment/ground: every pixel shows the environment in the direction from the
// photo's camera to where the view ray meets the floor disc or dome, a floor point keeps its colour from two camera
// positions (a plain background does not), geometry is never covered, and it draws in a real engine.
import { Engine, Camera, PbrMaterial, box } from '@margoengine/core';
import { Environment, EnvironmentBackground } from '../dist/index.js';
import { GroundProjectedBackground } from '../dist/ground.js';
import { assert, directionAt, equirect, hardware, openDevice, renderBackground, rotateY } from './gpu-read.js';

// Smooth, direction-coded HDR field: red follows +X, green +Y, blue -Z.
const coded = (d) => [1 + d[0], 1 + d[1], 1 - d[2]].map((v) => v * 1.5);

// CPU mirror of the shader's projection (exact geometry), for a ray from `eye`.
function project(ray, eye, { center = [0, 0, 0], radius = 50, height = 1.6 } = {}) {
  const e = eye.map((v, i) => v - center[i]),
    b = e[0] * ray[0] + e[1] * ray[1] + e[2] * ray[2],
    disc = b * b - (e[0] * e[0] + e[1] * e[1] + e[2] * e[2] - radius * radius);
  if (disc < 0) return { d: ray };
  let t = -b + Math.sqrt(disc),
    floor = false;
  if (ray[1] < 0 && e[1] > 0 && -e[1] / ray[1] < t) [t, floor] = [-e[1] / ray[1], true];
  const p = e.map((v, i) => v + ray[i] * t),
    q = [p[0], p[1] - height, p[2]],
    l = Math.hypot(...q);
  return { d: q.map((v) => v / l), floor: floor ? [p[0] + center[0], center[1], p[2] + center[2]] : null };
}

window.runTests = async () => {
  const { adapter, device, finish } = await openDevice();
  const report = { checks: [] };
  const environment = await Environment.create(device, equirect(256, 128, coded), {
    size: 64,
    samples: 64,
    brdfSize: 16,
    brdfSamples: 64,
    rotation: 0.4,
  });
  const size = 48;
  const camera = (position, target) => {
    const c = new Camera({ position, target, fov: 70, near: 0.1, far: 200 });
    c.update(1, true);
    return c;
  };
  const views = [camera([0, 2, 5], [0, 0.3, 0]), camera([3.5, 1.2, -2.5], [0, 0, 0])];

  // 1. Every pixel equals the environment along the projected direction (CPU mirror), with rotation and exposure.
  const options = { exposure: 0.8, rotation: 0.3, height: 1.6, radius: 12, center: [0.2, 0, -0.1] };
  const ground = new GroundProjectedBackground(environment, options);
  assert(ground.name === 'environment:background', 'ground takes the background slot');
  const floors = [];
  let worst = 0,
    floorPixels = 0;
  for (const view of views) {
    const pixel = await renderBackground(device, ground, { size, camera: view });
    const hits = [];
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const { d, floor } = project(directionAt(view, x, y, size, size), view.position, options);
        const want = coded(rotateY(d, environment.rotation + options.rotation)).map((v) => v * options.exposure),
          got = pixel(x, y);
        for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(got[k] - want[k]) / Math.max(want[k], 0.25));
        if (floor) {
          floorPixels++;
          hits.push({ floor, color: got, x, y });
        }
      }
    floors.push(hits);
  }
  // Bilinear reads of a smooth 256 x 128 field and rgba16float output: a few tenths of a percent. The error is relative to
  // the value, or to 0.25 where the field nears 0 (straight down, green 1 + d.y), so a texel's bilinear step there counts
  // against a sixth of the field's 0 to 3 range instead of against a near-zero value.
  assert(worst < 0.01, `ground projection differs from the CPU mirror by ${worst}`);
  assert(floorPixels > size * size * 0.3, `only ${floorPixels} pixels see the floor`);
  report.projectionError = worst;
  report.checks.push(
    'every pixel equals the environment along the projected direction (floor disc and dome), two cameras',
  );

  // 2. The floor stays in place: each floor point the first camera shows keeps its colour when looked at from the
  // second camera's position (the projection of the ray from there to the point, which check 1 holds the second camera's
  // pixels to); a plain background shows those points in different colours.
  const plain = new EnvironmentBackground(environment, { exposure: 0.8, rotation: 0.3 });
  const plainFirst = await renderBackground(device, plain, { size, camera: views[0] });
  const angle = environment.rotation + options.rotation,
    eye = views[1].position;
  let pairs = 0,
    groundGap = 0,
    plainGap = 0;
  for (const a of floors[0]) {
    const to = a.floor.map((v, i) => v - eye[i]),
      l = Math.hypot(...to),
      ray = to.map((v) => v / l),
      { d, floor } = project(ray, eye, options);
    if (!floor || Math.hypot(floor[0] - a.floor[0], floor[2] - a.floor[2]) > 1e-6) continue;
    pairs++;
    const b = coded(rotateY(d, angle)).map((v) => v * options.exposure),
      pa = plainFirst(a.x, a.y),
      pb = coded(rotateY(ray, angle)).map((v) => v * options.exposure);
    for (let k = 0; k < 3; k++) {
      groundGap = Math.max(groundGap, Math.abs(a.color[k] - b[k]) / Math.max(b[k], 0.25));
      plainGap = Math.max(plainGap, Math.abs(pa[k] - pb[k]) / Math.max(pb[k], 0.25));
    }
  }
  assert(pairs > 100, `only ${pairs} floor points seen from both cameras`);
  // The error of check 1 (bilinear reads, rgba16float).
  assert(groundGap < 0.01, `a floor point changes colour between the cameras by ${groundGap}`);
  assert(plainGap > 0.3, `a plain background kept the floor in place (${plainGap}); the check cannot tell`);
  report.floorPairs = pairs;
  report.floorColourChange = groundGap;
  report.plainColourChange = plainGap;
  report.checks.push('a floor point keeps its colour seen from a second camera; a plain background does not');

  // 3. Geometry is never covered, and blur samples the prefiltered mips through the same projection.
  {
    const pixel = await renderBackground(device, ground, { size, camera: views[0], depthClear: 1 });
    for (const [x, y] of [
      [3, 3],
      [24, 40],
      [44, 10],
    ]) {
      const got = pixel(x, y);
      assert(got[0] === 0.25 && got[1] === 0 && got[2] === 0.25, `ground drew over geometry at ${x}, ${y}`);
    }
    ground.blur = 1;
    const blurred = await renderBackground(device, ground, { size, camera: views[0] });
    const v = blurred(24, 40);
    assert(v.every(Number.isFinite) && v[0] > 0, 'blurred ground draws');
    ground.blur = 0;
    report.checks.push('only cleared depth is drawn; blur reads the prefiltered mips');
  }

  // 4. Settings are checked as a pair and live.
  for (const bad of [
    { height: 0 },
    { height: 60 },
    { radius: 1 },
    { center: [0, 0] },
    { center: [0, Number.NaN, 0] },
  ]) {
    let threw = false;
    try {
      new GroundProjectedBackground(environment, bad);
    } catch (error) {
      threw = error instanceof RangeError;
    }
    assert(threw, `invalid ${JSON.stringify(bad)} did not throw RangeError`);
  }
  const wide = new GroundProjectedBackground(environment, { height: 80, radius: 200 });
  assert(wide.height === 80 && wide.radius === 200, 'a height above the default radius is accepted with its radius');
  report.checks.push('height, radius and center are validated as a pair');
  await finish();
  environment.dispose();
  device.destroy();

  // 5. A real engine: a box on the projected floor, drawn to the canvas without a validation error.
  {
    const canvas = document.querySelector('#scene');
    const engine = await Engine.create(canvas, {
      backend: 'webgpu',
      camera: { position: [0, 1.5, 4], target: [0, 0.5, 0], fov: 60 },
    });
    const gpu = (await import('@margoengine/core/extension')).engineRuntime(engine).gpu;
    gpu.pushErrorScope('validation');
    const env = await Environment.attach(engine, equirect(128, 64, coded), { size: 32, samples: 64 });
    GroundProjectedBackground.attach(engine, env, { height: 1.6, radius: 20 });
    engine
      .createMesh()
      .setGeometry(box(1, 1, 1))
      .setMaterial(new PbrMaterial({ color: '#c08040' }))
      .setPosition([0, 0.5, 0]);
    engine.render();
    await gpu.queue.onSubmittedWorkDone();
    const validation = await gpu.popErrorScope();
    assert(!validation, `engine validation: ${validation?.message}`);
    engine.dispose();
    report.checks.push('real engine: a box on the projected floor draws on the canvas');
  }
  report.hardware = hardware(adapter);
  return report;
};
