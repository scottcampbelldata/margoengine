import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

const { page, close, hardware } = await openBrowser({ startPath: '/tools/shot/blank.html', port: 'free' });
const backend = hardware.compat ? 'WebGL2' : 'WebGPU';
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
const output =
  process.env.MARGO_KEEP_LANDSCAPE_FRAMES === '1' ? 'packages/physics/test-results/landscape-surface' : undefined;
if (output) await mkdir(output, { recursive: true });
const capture = async (name) =>
  decodePNG(
    await page.locator('canvas').screenshot(output ? { path: output + '/' + backend + '-' + name + '.png' } : {}),
  );

function changedPixels(before, after) {
  assert.equal(before.data.length, after.data.length);
  let count = 0;
  for (let i = 0; i < before.data.length; i += 4) {
    const delta =
      Math.abs(before.data[i] - after.data[i]) +
      Math.abs(before.data[i + 1] - after.data[i + 1]) +
      Math.abs(before.data[i + 2] - after.data[i + 2]);
    if (delta >= 12) count++;
  }
  return count;
}

try {
  await page.evaluate(async () => {
    const [
      { EngineKernel },
      { createRelief },
      { evolveRelief },
      { bedVertexAreas },
      { regionWords },
      { Terrain },
      { TerrainQuery },
      { waitForPipelines },
    ] = await Promise.all([
      import('/packages/core/dist/index.js'),
      import('/packages/biomes/dist/relief.js'),
      import('/packages/biomes/dist/landscape.js'),
      import('/packages/physics/dist/earth.js'),
      import('/packages/physics/dist/world.js'),
      import('/packages/terrain/dist/index.js'),
      import('/packages/terrain/dist/query.js'),
      import('/scripts/support/gpu-ready.js'),
    ]);

    // Geological evolution follows a fixed camera through an authored interval.
    const start = 12;
    const duration = 61;
    const year = 31_557_600;
    const yearsPerFrame = 1000;
    const upliftPerYear = 0.00055;
    const relief = createRelief({
      seed: 31,
      origin: [-700, -520],
      size: [1400, 1040],
      base: 135,
      relief: 260,
      rivers: 1,
      valley: { width: 195, floor: 26 },
    });
    const geologicSettings = {
      step: 40,
      rainfall: 1.35 / year,
      uplift: upliftPerYear / year,
      secondsPerSecond: 60 * yearsPerFrame * year,
      erodibility: 0.8e-9,
      hillslopeDiffusivity: 0.055 / year,
      thermalDiffusivity: 0.008 / year,
      outlets: { maxX: true },
      alluvialDepth: 2,
    };
    const { terrain, world, landscape, snapshotRelief } = await evolveRelief(relief, geologicSettings);
    const { width, depth, columns, rows, centre } = terrain.grid;
    const size = [width, depth];
    const origin = [centre[0] - width / 2, centre[1] - depth / 2];
    const samplesX = columns + 1;
    const samplesZ = rows + 1;
    const sampleCount = samplesX * samplesZ;
    const stepX = width / columns;
    const stepZ = depth / rows;
    const sourceTerrain = terrain.elevations();
    const initialVolume = terrain.volume();
    const weights = bedVertexAreas(terrain.grid);
    // The fixed east outlet excludes the half-cell strip owned by its boundary vertices.
    const liftingArea = (width - stepX / 2) * depth;
    const control = await evolveRelief(relief, { ...geologicSettings, hillslopeDiffusivity: 0, thermalDiffusivity: 0 });
    control.world.advance(duration);
    const withoutDiffusion = control.terrain.elevations();
    const initialRelief = snapshotRelief();

    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'display:block;width:420px;height:264px';
    document.body.replaceChildren(canvas);
    const engine = await EngineKernel.create(canvas, {
      backend: 'webgpu',
      exactSize: [420, 264],
      camera: { position: [1040, 1030, 1410], target: [-45, 125, 0], fov: 42, near: 12, far: 4900 },
    });
    engine.scene.background = '#a6b7be';
    engine.lighting.direction.set([-0.51, 0.77, 0.38, 1.65]);
    engine.lighting.radiance.set([1, 0.93, 0.81, 0.54]);
    engine.lighting.ambient.set([0.66, 0.74, 0.82]);

    const gpu = engine.gpu;
    const gpuErrors = [];
    engine.onError = (error) => gpuErrors.push(String(error));
    gpu.addEventListener('uncapturederror', (event) => gpuErrors.push(event.error.message));
    gpu.pushErrorScope('validation');

    const grain = [
      [113, 122, 101], // slope vegetation
      [144, 127, 105], // exposed earth
      [153, 151, 144], // weathered rock
      [105, 122, 105], // valley floor
    ];
    const tileSize = 8;
    const layerBytes = new Uint8Array(tileSize * tileSize * 4 * grain.length);
    for (let layer = 0; layer < grain.length; layer++) {
      for (let p = 0; p < tileSize * tileSize; p++) {
        const shading = ((p * 13 + (p >> 3) * 7 + layer * 37) % 13) - 6;
        const [r, g, b] = grain[layer];
        layerBytes.set([r + shading, g + shading, b + shading, 255], (layer * tileSize * tileSize + p) * 4);
      }
    }
    const heights = new Float32Array(sampleCount);
    function writeHeightMap(texture) {
      gpu.queue.writeTexture({ texture }, heights, { bytesPerRow: samplesX * 4, rowsPerImage: samplesZ }, [
        samplesX,
        samplesZ,
      ]);
    }
    function sampleBed(snapshot, physical) {
      for (let c = 0; c <= columns; c++) {
        for (let r = 0; r <= rows; r++) {
          const x = origin[0] + c * stepX;
          const z = origin[1] + r * stepZ;
          const millimetres = snapshot.height(Math.round(x * 1000), Math.round(z * 1000));
          if (millimetres !== Math.round(physical[r + samplesZ * c] * 1000))
            throw new Error('The Biomes snapshot did not sample the accepted TerrainBed at its vertices.');
          heights[r * samplesX + c] = millimetres / 1000;
        }
      }
    }
    sampleBed(initialRelief, sourceTerrain);

    const mesh = Terrain.attach(engine, {
      origin,
      size,
      heightScale: 1,
      cellSize: 20,
      clipmapAnchor: [0, 0],
      levels: 1,
      resolution: 80,
      captureSurfaceHeight: true,
      roughness: 0.89,
      layers: [
        { height: [0, 420], slope: [0, 1], scale: 0.14 },
        { height: [90, 270], slope: [0.015, 0.18], scale: 0.18 },
        { height: [235, 450], slope: [0.065, 1], scale: 0.15 },
        { height: [0, 113], slope: [0, 0.09], scale: 0.12 },
      ],
      textures(device) {
        const heightmap = device.createTexture({
          size: [samplesX, samplesZ],
          format: 'r32float',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
        });
        writeHeightMap(heightmap);
        const layers = device.createTexture({
          size: [tileSize, tileSize, grain.length],
          format: 'rgba8unorm-srgb',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        device.queue.writeTexture(
          { texture: layers },
          layerBytes,
          { bytesPerRow: tileSize * 4, rowsPerImage: tileSize },
          [tileSize, tileSize, grain.length],
        );
        return { heightmap, layers };
      },
    });
    const draw = async () => {
      engine.render({ delta: 0 });
      await gpu.queue.onSubmittedWorkDone();
    };
    await waitForPipelines(draw);

    async function checkDrawnHeight() {
      const query = await TerrainQuery.read(engine, mesh);
      if (!query.heights.every((height, i) => height === heights[i]))
        throw new Error('Terrain texture data differs from the accepted Biomes snapshot.');
      const texture = mesh.surfaceHeightTexture;
      if (!texture || texture.width !== samplesX || texture.height !== samplesZ)
        throw new Error('Terrain did not capture the drawn grid in the exact snapshot dimensions.');
      const half = texture.format === 'rgba16float';
      const bytesPerPixel = half ? 8 : 4;
      const rowBytes = Math.ceil((samplesX * bytesPerPixel) / 256) * 256;
      const buffer = gpu.createBuffer({
        size: rowBytes * samplesZ,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      try {
        const encoder = gpu.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: rowBytes, rowsPerImage: samplesZ }, [
          samplesX,
          samplesZ,
        ]);
        gpu.queue.submit([encoder.finish()]);
        await buffer.mapAsync(GPUMapMode.READ);
        const data = half ? new Float16Array(buffer.getMappedRange()) : new Float32Array(buffer.getMappedRange());
        let max = 0;
        for (let r = 1; r < rows; r++) {
          for (let c = 1; c < columns; c++) {
            const expected = heights[r * samplesX + c];
            const actual = half ? data[(r * rowBytes) / 2 + c * 4] : data[(r * rowBytes) / 4 + c];
            const error = Math.abs(actual - expected);
            // The half-float fallback rounds each colour-channel height to within half an ULP.
            const halfUlp = half ? 0.5 * 2 ** (Math.floor(Math.log2(Math.max(expected, 2 ** -14))) - 10) : 0;
            if (!(error <= halfUlp + 0.002))
              throw new Error('Drawn height at ' + c + ',' + r + ' is ' + actual + ' m versus ' + expected + ' m.');
            max = Math.max(max, error);
          }
        }
        return max;
      } finally {
        buffer.destroy();
      }
    }

    let checkpoint;
    window.landscapeShot = {
      async frame(shotFrame, action) {
        const frame = Math.min(duration, Math.max(0, shotFrame - start));
        if (action === 'restore') world.restoreSnapshot(checkpoint.bytes);
        world.advance(frame);
        const accepted = world.takeSnapshot();
        if (action === 'save') checkpoint = accepted;
        const current = terrain.elevations();
        sampleBed(snapshotRelief(), current);
        writeHeightMap(mesh.heightmap);
        mesh.invalidate();
        await draw();
        const drawError = await checkDrawnHeight();
        const change = regionWords(world.memory, landscape.exportPorts(frame)[0].region);
        let pending = 0;
        let rise = 0;
        let fall = 0;
        let diffusionEffect = 0;
        let incision = 0;
        let discharge = 0;
        for (let i = 0; i < sampleCount; i++) {
          const [column, row] = [Math.floor(i / samplesZ), i % samplesZ];
          const sample = landscape.read(column, row);
          pending += change[i] * weights[i];
          rise = Math.max(rise, current[i] - sourceTerrain[i]);
          fall = Math.min(fall, current[i] - sourceTerrain[i]);
          incision = Math.max(incision, sample.incision);
          discharge = Math.max(discharge, sample.discharge);
          if (frame === duration)
            diffusionEffect = Math.max(diffusionEffect, Math.abs(withoutDiffusion[i] - current[i]));
        }
        const budget = landscape.budget;
        const exported = budget.exported.reduce((total, value) => total + value, 0);
        const expectedUplift = frame * yearsPerFrame * upliftPerYear * liftingArea;
        const bedVolume = terrain.volume();
        return {
          frame,
          hash: accepted.hash,
          years: budget.elapsed / year,
          bedVolume,
          initialVolume,
          pending,
          exported,
          uplift: budget.uplift,
          expectedUplift,
          rise,
          fall,
          incision,
          discharge,
          alluvium: budget.alluvium,
          diffusionEffect,
          drawError,
          sampleCount,
        };
      },
      async dispose() {
        mesh.dispose();
        const validation = (await gpu.popErrorScope())?.message ?? null;
        engine.dispose();
        return { validation, gpuErrors };
      },
    };
  });

  const render = (time, action) => page.evaluate(([t, a]) => window.landscapeShot.frame(t, a), [time, action]);
  const initial = await render(0);
  const initialPixels = await capture('initial');
  const before = await render(12);
  const beforePixels = await capture('hold');
  const middle = await render(32, 'save');
  const middlePixels = await capture('middle');
  const final = await render(73);
  const finalPixels = await capture('final');
  const held = await render(91);
  const heldPixels = await capture('held-final');
  const rewind = await render(32, 'restore');
  const rewindPixels = await capture('rewind');
  const replay = await render(73);
  const replayPixels = await capture('replay');

  assert.deepEqual(await page.evaluate(() => window.landscapeShot.dispose()), { validation: null, gpuErrors: [] });
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(before, initial);
  assert.deepEqual(held, final);
  assert.deepEqual(rewind, middle);
  assert.deepEqual(replay, final);
  assert.deepEqual(beforePixels.data, initialPixels.data);
  assert.deepEqual(heldPixels.data, finalPixels.data);
  assert.deepEqual(rewindPixels.data, middlePixels.data);
  assert.deepEqual(replayPixels.data, finalPixels.data);
  const midChange = changedPixels(initialPixels, middlePixels);
  const lateChange = changedPixels(middlePixels, finalPixels);
  assert.ok(midChange > 500 && lateChange > 500, JSON.stringify({ midChange, lateChange, middle, final }));

  assert.equal(middle.years, 20_000);
  assert.equal(final.years, 61_000);
  assert.ok(final.rise > 35 && final.fall < -15 && final.diffusionEffect > 5);
  assert.ok(final.incision > 0 && final.discharge > 0 && final.exported > middle.exported);
  for (const shot of [initial, middle, final]) {
    const scale = Math.max(shot.initialVolume, shot.bedVolume, shot.uplift);
    const bound = 16 * shot.sampleCount * (shot.frame + 1) * Number.EPSILON * scale;
    assert.ok(Math.abs(shot.uplift - shot.expectedUplift) <= bound, JSON.stringify(shot));
    // The most recent bedChange is still in the staggered port at capture time.
    assert.ok(
      Math.abs(shot.bedVolume - shot.initialVolume + shot.pending + shot.exported - shot.expectedUplift) <= bound,
      JSON.stringify(shot),
    );
  }
  console.log(
    'HYDRO-04',
    backend,
    final.hash + ':',
    final.years,
    'years,',
    midChange,
    '/',
    lateChange,
    'changed pixels,',
    final.exported.toFixed(2),
    'm³ sediment exported, draw residual',
    final.drawError,
    'm, exact holds and rewind/replay.',
  );
} finally {
  await close();
}
