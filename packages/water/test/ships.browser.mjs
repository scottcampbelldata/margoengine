// Ships on the GPU (WebGPU, and the WebGL2 layer with MARGO_COMPAT=1): the wake the Water draws, read back through
// WaveQuery at the grid's vertices, is the CPU law of ShipWakes.sample (the measured Kelvin and Rabaud-Moisy bounds are
// held on that law in ships.test.js), on the open sea and on a Flood's water; a Floater rides the drawn wake on the flood
// as it rides the CPU law; and a lamp's glint on a night sea stands on the mirror line between the eye and the lamp,
// longer on a rougher sea.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { closeAll } from '../../../scripts/support/shutdown.mjs';
import { decodePNG } from '../../../tests/support/png.js';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
await mkdir('test-results', { recursive: true });
const WIDTH = 320,
  HEIGHT = 240;
const browser = await openBrowser({ port: 'free', startPath: '/tests/modern-game.html' }),
  { page, hardware } = browser,
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
try {
  const result = await page.evaluate(
    async ({ WIDTH, HEIGHT }) => {
      const { EngineKernel } = await import('/packages/core/dist/index.js');
      const { Water } = await import('/packages/water/dist/index.js');
      const { WaveQuery } = await import('/packages/water/dist/query.js');
      const { Flood } = await import('/packages/water/dist/flood.js');
      const { ShipWakes, Floater } = await import('/packages/water/dist/ships.js');
      const canvas = document.createElement('canvas');
      canvas.style.cssText = `width:${WIDTH}px;height:${HEIGHT}px`;
      document.body.replaceChildren(canvas);
      const engine = await EngineKernel.create(canvas, {
        backend: 'webgpu',
        capacity: 8,
        camera: { position: [0, 30, 40], target: [0, 0, 0], near: 0.1, far: 2000 },
      });
      const d = engine.gpu;
      d.pushErrorScope('validation');
      const hull = { length: 10, beam: 3, draft: 1 };
      const path = (t) => [2, -20 + 4 * t];
      // The grid's vertices: a Water of 64 m and 256 segments centred on the origin has one every 0.25 m.
      const points = [];
      for (let j = 0; j <= 256; j += 4) for (let i = 0; i <= 256; i += 4) points.push([-32 + i * 0.25, -32 + j * 0.25]);
      const compare = async (water, wakes, base) => {
        engine.render({ delta: 0 });
        const query = await WaveQuery.capture(water);
        let worst = 0,
          peak = 0,
          missing = 0;
        for (const [x, z] of points) {
          const hit = query.heightAt(x, z);
          if (hit === undefined) {
            missing++;
            continue;
          }
          const under = typeof base === 'number' ? base : base.heightAt(x, z);
          const expected = wakes.sample(x, z).height;
          peak = Math.max(peak, Math.abs(expected));
          worst = Math.max(worst, Math.abs(hit - under - expected));
        }
        return { worst, peak, missing, query };
      };

      // 1. The open sea: flat, so its height is the wake alone.
      const sea = Water.attach(engine, {
        size: [64, 64],
        segments: 256,
        waves: [{ direction: [1, 0], amplitude: 0, wavelength: 10 }],
      });
      const wakes = ShipWakes.attach(engine, { surface: sea, ships: [{ hull, path }] });
      wakes.setTime(10);
      const open = await compare(sea, wakes, 0);
      // Seeking draws the wake of that time.
      wakes.setTime(4);
      const early = await compare(sea, wakes, 0);
      wakes.dispose();
      sea.dispose();

      // Read fixed 1/8 m grid points around an isolated bow so ambient waves cannot hide the crest's path.
      const bowSea = Water.attach(engine, {
        size: [24, 24],
        segments: 192,
        waves: [{ direction: [1, 0], amplitude: 0, wavelength: 10 }],
      });
      const bowWakes = ShipWakes.attach(engine, {
        surface: bowSea,
        ships: [
          {
            hull: { length: 68, beam: 15.5, draft: 7, entrance: 28 },
            pose: { position: [0, 0, -34], heading: 0, speed: 3 },
          },
        ],
        look: { wakeHeight: 0, waterlineFoam: 0, turbulentWake: 0 },
      });
      engine.render({ delta: 0 });
      const bowQuery = await WaveQuery.capture(bowSea);
      const bowCrest = [
        [0.5, -0.875],
        [2.125, -1.75],
        [2.125, -0.875],
        [4.75, -0.875],
      ].map(([x, z]) => bowQuery.heightAt(x, z));
      // Move the hull forward to put the station 18 m aft of the stem on the grid's centre row.
      bowWakes.ships[0].setPose({ position: [0, 0, -16], heading: 0, speed: 3 });
      bowWakes.setTime(1);
      engine.render({ delta: 0 });
      const sideQuery = await WaveQuery.capture(bowSea);
      const sideWash = [6.875, -6.875, 7.875, 11].map((x) => sideQuery.heightAt(x, 0));
      bowWakes.ships[0].setPose({ position: [0, 0, -16], heading: 0, speed: 1.5 });
      bowWakes.setTime(2);
      engine.render({ delta: 0 });
      const slowSides = await WaveQuery.capture(bowSea);
      const slowSide = [slowSides.heightAt(7.375, 0), slowSides.heightAt(-7.375, 0), slowSides.heightAt(11.5, 0)];
      bowWakes.ships[0].setPose({ position: [0, 0, -34], heading: 0, speed: 1.5 });
      bowWakes.setTime(3);
      engine.render({ delta: 0 });
      const slowBow = (await WaveQuery.capture(bowSea)).heightAt(0.125, 0);
      bowWakes.dispose();
      bowSea.dispose();

      // At 3 m/s a 72 m hull takes 24 s to pass a point. Fresh foam must still start at the transom.
      engine.camera.position = [0, 47, -15];
      engine.camera.target = [0, 0, -9];
      const calm = Water.attach(engine, {
        size: [100, 100],
        segments: 48,
        waves: [{ direction: [1, 0], amplitude: 0, wavelength: 10 }],
      });
      const sternWake = ShipWakes.attach(engine, {
        surface: calm,
        ships: [{ hull: { length: 72, beam: 8, draft: 4 }, path: (t) => [0, Math.max(0, t) * 3] }],
        look: { wakeHeight: 0, waterlineFoam: 0, bowWave: 0, turbulentWake: 0.8, foamLife: 4 },
      });
      sternWake.setTime(12);
      const { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
      await waitForPipelines(async () => {
        engine.render({ delta: 0 });
        await d.queue.onSubmittedWorkDone();
      });
      const matrix = engine.camera.matrix;
      const project = ([x, z]) => {
        const w = matrix[3] * x + matrix[11] * z + matrix[15];
        return [
          Math.floor((0.5 + (0.5 * (matrix[0] * x + matrix[8] * z + matrix[12])) / w) * engine.canvas.width),
          Math.floor((0.5 - (0.5 * (matrix[1] * x + matrix[9] * z + matrix[13])) / w) * engine.canvas.height),
        ];
      };
      const texels = [
        [0, -0.9],
        [0, -15],
        [0, 1.4],
        [9, -0.9],
      ].map(project);
      const reader = d.createComputePipeline({
        layout: 'auto',
        compute: {
          module: d.createShaderModule({
            code: `
            @group(0) @binding(0) var mask: texture_2d<f32>;
            @group(0) @binding(1) var<storage, read_write> out: array<f32, 4>;
            @compute @workgroup_size(4) fn readFoam(@builtin(local_invocation_index) k: u32) {
              let p = array<vec2i, 4>(${texels.map(([x, y]) => 'vec2i(' + x + ',' + y + ')').join(',')});
              out[k] = textureLoad(mask, p[k], 0).r;
            }`,
          }),
          entryPoint: 'readFoam',
        },
      });
      const readback = d.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const foamData = d.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.STORAGE });
      const readFoam = async () => {
        const group = d.createBindGroup({
          layout: reader.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: calm.view.foam[calm.view.current].createView() },
            { binding: 1, resource: { buffer: foamData } },
          ],
        });
        const encoder = d.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(reader);
        pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(1);
        pass.end();
        encoder.copyBufferToBuffer(foamData, 0, readback, 0, 16);
        d.queue.submit([encoder.finish()]);
        await readback.mapAsync(GPUMapMode.READ);
        const values = Array.from(new Float32Array(readback.getMappedRange()));
        readback.unmap();
        return values;
      };
      const sternFoam = await readFoam();
      sternWake.delete(sternWake.ships[0]);
      sternWake.add({ hull: { length: 72, beam: 8, draft: 4 }, path: (time) => [0, Math.max(0, time) * 1.5] });
      sternWake.setLook({ foamLife: 9.5 });
      sternWake.setTime(24);
      engine.render({ delta: 0 });
      const slowFoam = await readFoam();
      foamData.destroy();
      readback.destroy();
      sternWake.dispose();
      calm.dispose();

      // 2. A Flood's water, 2 m deep over a flat bed: the drawn surface is the flood plus the wake.
      const width = 64,
        terrain = d.createTexture({
          size: [width, width],
          format: 'r32float',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
      d.queue.writeTexture({ texture: terrain }, new Float32Array(width * width), { bytesPerRow: width * 4 }, [
        width,
        width,
      ]);
      const water = Water.attach(engine, {
        height: -100,
        size: [64, 64],
        segments: 256,
        waves: [{ direction: [1, 0], amplitude: 0, wavelength: 10 }],
        terrain: { heightmap: () => terrain, origin: [-32, -32], size: [64, 64] },
        fill: () => 2,
      });
      const flood = Flood.attach(engine, { surface: water });
      engine.render({ delta: 0 });
      // The flood's own surface first, then with the wake on it.
      const still = await WaveQuery.capture(water);
      const floodWakes = ShipWakes.attach(engine, { surface: water, ships: [{ hull, path }] });
      floodWakes.setTime(10);
      const onFlood = await compare(water, floodWakes, still);
      // A small boat rides the drawn wake as it rides the CPU law. Its 7 x 3 sample points (0.15 L along, 0.4 B across)
      // fall on the grid's vertices, where the drawn surface is the law itself rather than a linear blend of it.
      const instant = { period: 0 };
      const boat = () =>
        new Floater({
          hull: { length: 5, beam: 1.25, draft: 0.4 },
          position: [6, 0, 6],
          heading: 0,
          heave: instant,
          pitch: instant,
          roll: instant,
        });
      const gpuBoat = boat().update(onFlood.query, 0),
        cpuBoat = boat().update(
          { sample: (x, z) => ({ height: still.heightAt(x, z) + floodWakes.sample(x, z).height }) },
          0,
        );
      const ride = {
        heave: Math.abs(gpuBoat.position[1] - cpuBoat.position[1]),
        pitch: Math.abs(gpuBoat.pitch - cpuBoat.pitch),
        roll: Math.abs(gpuBoat.roll - cpuBoat.roll),
        moved: Math.abs(cpuBoat.position[1] - still.heightAt(6, 6)) + Math.abs(cpuBoat.pitch) + Math.abs(cpuBoat.roll),
      };
      floodWakes.dispose();
      flood.dispose();
      water.dispose();
      terrain.destroy();

      // 3. A lamp on a night sea: the camera and the lamp in the plane x = 0, so the mirror line is the middle column.
      engine.camera.position = [0, 4, 0];
      engine.camera.target = [0, 1, -40];
      engine.lighting.direction.set([0.3, 0.5, 0.2, 0.3]);
      engine.lighting.radiance.set([0.2, 0.25, 0.4, 0.02]);
      const night = Water.attach(engine, {
        size: [400, 400],
        segments: 64,
        waves: [{ direction: [1, 0], amplitude: 0.02, wavelength: 3 }],
      });
      const lamps = ShipWakes.attach(engine, { surface: night, lamps: [{ position: [0, 10, -80], intensity: 3000 }] });
      window.shipsTest = { engine, lamps, night };
      return { open, early, onFlood, ride, sternFoam, bowCrest, sideWash, slowBow, slowSide, slowFoam };
    },
    { WIDTH, HEIGHT },
  );
  // Night frames, screenshotted from the page.
  const frame = async (intensity, roughness) => {
    await page.evaluate(
      async ({ intensity, roughness }) => {
        const { engine, lamps } = window.shipsTest;
        lamps.setLook({ lampIntensity: intensity, lampRoughness: roughness });
        engine.render({ delta: 0 });
        await engine.gpu.queue.onSubmittedWorkDone();
      },
      { intensity, roughness },
    );
    return page.locator('canvas').screenshot();
  };
  result.dark = await frame(0, 0.08);
  result.sharp = await frame(1, 0.08);
  result.wide = await frame(1, 0.4);
  result.validation = await page.evaluate(async () => {
    const { engine, lamps, night } = window.shipsTest;
    lamps.dispose();
    night.dispose();
    const error = await engine.gpu.popErrorScope();
    engine.dispose();
    window.shipsTest = undefined;
    return error?.message ?? null;
  });
  const strip = (r) => ({ worst: r.worst, peak: r.peak, missing: r.missing });
  const open = strip(result.open),
    early = strip(result.early),
    flood = strip(result.onFlood);
  console.log(JSON.stringify({ open, early, flood, ride: result.ride }));
  for (const [name, r] of Object.entries({ open, early, flood })) {
    assert.equal(r.missing, 0, `${name}: query found no water at ${r.missing} vertices`);
    assert.ok(r.peak > 0.05, `${name}: the wake is too small to test (${r.peak} m)`);
    assert.ok(r.worst < 1e-3 + r.peak * 1e-3, `${name}: drawn wake ${r.worst} m from the CPU law (peak ${r.peak} m)`);
  }
  assert.ok(result.ride.moved > 1e-3, 'the boat did not move on the wake');
  assert.ok(
    result.ride.heave < 1e-4 && result.ride.pitch < 1e-4 && result.ride.roll < 1e-4,
    JSON.stringify(result.ride),
  );

  const [stem, swept, stripe, outboard] = result.bowCrest;
  assert.ok(stem > 0.42 && swept > 0.26, 'missing bow rise or swept crest: ' + result.bowCrest);
  assert.ok(Math.abs(stripe) < 0.12 && Math.abs(outboard) < 1e-6, 'a straight ridge remains: ' + result.bowCrest);
  console.log('bow height in metres at stem, swept crest, old stripe and outboard:', result.bowCrest);
  const [starboard, port, drawdown, beyond] = result.sideWash;
  assert.ok(starboard > 0.07 && Math.abs(starboard - port) < 1e-6, 'missing lift on both sides: ' + result.sideWash);
  assert.ok(drawdown < -0.03 && Math.abs(beyond) < 1e-6, 'bad side wash cross section: ' + result.sideWash);
  console.log('side wash in metres at starboard, port, drawdown and outboard:', result.sideWash);
  assert.ok(result.slowBow > 0.065, 'the slow bow lost its visible rise');
  const [slowStarboard, slowPort, slowBeyond] = result.slowSide;
  assert.ok(slowStarboard > 0.008 && Math.abs(slowStarboard - slowPort) < 1e-6 && Math.abs(slowBeyond) < 1e-6);
  console.log('harbor speed height at bow and alongside:', result.slowBow, result.slowSide);
  const [fresh, aged, forward, offAxis] = result.sternFoam;
  assert.ok(fresh > 0.35, 'fresh foam must start at the stern: ' + result.sternFoam);
  assert.ok(aged > 0.07 && aged < fresh * 0.6, 'stern foam must fade with its own age: ' + result.sternFoam);
  assert.equal(forward, 0, 'no turbulent foam ahead of the stern');
  assert.equal(offAxis, 0, 'no turbulent foam outside the wake');
  console.log('stern foam fresh, aged, forward, off-axis:', result.sternFoam);
  const [slowFresh, slowAged, slowForward, slowOffAxis] = result.slowFoam;
  assert.ok(slowFresh > 0.26 && slowAged > 0.03 && slowAged < slowFresh, 'missing or unfaded harbor foam');
  assert.ok(slowForward < 0.025 && slowOffAxis < 0.025, 'harbor foam leaves the stern trail');
  console.log('harbor speed foam fresh, aged, forward, off-axis:', result.slowFoam);

  // The glint: luminance added by the lamp, per pixel.
  const luminance = async (bytes) => {
    const png = await decodePNG(bytes);
    const out = new Float64Array(png.width * png.height);
    for (let k = 0; k < out.length; k++)
      out[k] = 0.2126 * png.data[k * 4] + 0.7152 * png.data[k * 4 + 1] + 0.0722 * png.data[k * 4 + 2];
    return { out, width: png.width, height: png.height };
  };
  const dark = await luminance(result.dark),
    sharp = await luminance(result.sharp),
    wide = await luminance(result.wide);
  const glint = (img) => {
    let best = 0,
      bestX = 0,
      lit = 0;
    for (let y = 0; y < img.height; y++)
      for (let x = 0; x < img.width; x++) {
        const added = img.out[y * img.width + x] - dark.out[y * img.width + x];
        if (added > best) (best = added), (bestX = x);
        if (added > 8) lit++;
      }
    return { best, bestX, lit };
  };
  const g1 = glint(sharp),
    g2 = glint(wide);
  console.log(JSON.stringify({ sharp: g1, wide: g2, width: dark.width }));
  assert.ok(g1.best > 40, `the lamp adds no glint (${g1.best})`);
  assert.ok(
    Math.abs(g1.bestX - (dark.width - 1) / 2) <= 2,
    `the glint is off the mirror line at column ${g1.bestX} of ${dark.width}`,
  );
  assert.ok(g2.lit > g1.lit * 1.5, `a rougher sea should spread the glint (${g1.lit} -> ${g2.lit} pixels)`);
  assert.equal(result.validation, null);
  assert.deepEqual(errors, []);
  const report = { hardware, open, early, flood, ride: result.ride, glint: { sharp: g1, wide: g2 } };
  await writeFile(
    `test-results/water-ships-${hardware?.compat ? 'compat' : 'webgpu'}.json`,
    JSON.stringify(report, null, 2),
  );
  console.log(`water ships browser check passed (${hardware.webgpu?.vendor ?? 'compat'})`);
} finally {
  await page.evaluate(() => window.shipsTest?.engine.dispose());
  await closeAll({ browser });
}
