// Native/--compat: actual terrain draping, RVT reader probes, metre widths, holes and transactional live edits.
// Reuses the CC0 Poly Haven Aerial Rocks 02 picture and the existing USGS Rainier elevation fixture.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite, watchExit } from '../../../scripts/support/shutdown.mjs';

const context = await openBrowser({ startPath: '/tests/modern-game.html', port: 'free' });
const errors = [];
context.page.on('pageerror', (e) => errors.push(e.message));
context.page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
await runSuite(
  async () => {
    const result = await context.page.evaluate(async () => {
      const { Engine } = await import('/packages/core/dist/index.js');
      const { Terrain } = await import('/packages/terrain/dist/index.js');
      const { TerrainVirtualTexture } = await import('/packages/terrain/dist/rvt.js');
      const { TerrainImagery } = await import('/packages/terrain/dist/imagery.js');
      const { TerrainOverlays } = await import('/packages/terrain/dist/overlays.js');
      const { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
      const { watchCanvas, readCanvas } = await import('/scripts/support/canvas-frame.js');
      const load = async (url) =>
        createImageBitmap(await (await fetch(url)).blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
      const photo = await load('/packages/terrain/test/fixtures/aerial-rocks-02/aerial_rocks_02_diff_1k.jpg');
      const elevation = await load('/packages/shadows/test/fixtures/rainier-terrarium.png');
      const ectx = new OffscreenCanvas(elevation.width, elevation.height).getContext('2d');
      ectx.drawImage(elevation, 0, 0);
      const bytes = ectx.getImageData(0, 0, elevation.width, elevation.height).data;
      const heights = new Float32Array(elevation.width * elevation.height);
      for (let k = 0; k < heights.length; k++)
        heights[k] = (bytes[k * 4] * 256 + bytes[k * 4 + 1] + bytes[k * 4 + 2] / 256 - 32768) / 200;
      const points = [
        [0, -16],
        [0, -14.5],
        [0, -13.5],
        [10, 15],
        [0, 15],
        [20, 15],
        [-20, -16],
      ];
      const out = {};
      for (const steep of [1, 0]) {
        const canvas = document.createElement('canvas');
        document.body.append(canvas);
        const engine = await Engine.create(canvas, {
          backend: 'webgpu',
          exactSize: [192, 192],
          camera: { position: [0, 120, 0.01], target: [0, 0, 0], near: 0.1, far: 1000 },
        });
        const device = engine.gpu;
        watchCanvas(canvas);
        device.pushErrorScope('validation');
        engine.lighting.direction.set([0, 1, 0, 0]);
        engine.lighting.radiance.set([0, 0, 0, 1]);
        const terrain = Terrain.attach(engine, {
          size: [128, 128],
          origin: [-64, -64],
          heightScale: 1,
          resolution: 32,
          levels: 5,
          cellSize: 1,
          layers: Array.from({ length: 4 }, () => ({ height: [-100, 100], slope: [0, 1], scale: 1 })),
          textures(gpu) {
            const heightmap = gpu.createTexture({
              size: [elevation.width, elevation.height],
              format: 'r32float',
              usage: 6,
            });
            gpu.queue.writeTexture({ texture: heightmap }, heights, { bytesPerRow: elevation.width * 4 }, [
              elevation.width,
              elevation.height,
            ]);
            const layers = gpu.createTexture({ size: [1, 1, 4], format: 'rgba8unorm', usage: 6 });
            gpu.queue.writeTexture(
              { texture: layers },
              new Uint8Array(16),
              { bytesPerRow: 4, rowsPerImage: 1 },
              [1, 1, 4],
            );
            return { heightmap, layers };
          },
        });
        const rvt = TerrainVirtualTexture.attach(engine, terrain, { size: 256, levels: 4, texel: 0.25, steep });
        const imagery = TerrainImagery.attach(engine, terrain, { maxLayers: 4, automatic: false, virtualTexture: rvt });
        const texture = device.createTexture({ size: [1024, 1024], format: 'rgba8unorm-srgb', usage: 6 | 16 });
        device.queue.copyExternalImageToTexture({ source: photo }, { texture }, [1024, 1024]);
        const imageId = imagery.add({ source: { texture: () => texture } });
        const overlays = TerrainOverlays.attach(engine, rvt);
        const render = async () => {
          let baked = 0;
          await waitForPipelines(async () => {
            engine.render({ delta: 0 });
            baked += rvt.baked;
            await device.queue.onSubmittedWorkDone();
          });
          engine.render({ delta: 0 });
          return baked;
        };
        const probe = async () => {
          const output = device.createBuffer({ size: points.length * 16, usage: 0x80 | 4 });
          const read = device.createBuffer({ size: points.length * 16, usage: 8 | 1 });
          const code =
            rvt.declarations(0, 0) +
            `
@group(0) @binding(3) var<storage,read_write> result:array<vec4f>;
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id:vec3u){
  let points=array<vec2f,${points.length}>(${points.map((p) => `vec2f(${p[0]},${p[1]})`).join(',')});
  result[id.x]=terrainVirtualColor(vec3f(points[id.x].x,0.0,points[id.x].y),0.25);
}`;
          const module = device.createShaderModule({ code });
          const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
          const encoder = device.createCommandEncoder(),
            pass = encoder.beginComputePass();
          pass.setPipeline(pipeline);
          pass.setBindGroup(
            0,
            device.createBindGroup({
              layout: pipeline.getBindGroupLayout(0),
              entries: [...rvt.entries(0), { binding: 3, resource: { buffer: output } }],
            }),
          );
          pass.dispatchWorkgroups(points.length);
          pass.end();
          encoder.copyBufferToBuffer(output, 0, read, 0, points.length * 16);
          device.queue.submit([encoder.finish()]);
          await read.mapAsync(1);
          const values = [...new Float32Array(read.getMappedRange().slice(0))];
          read.unmap();
          read.destroy();
          output.destroy();
          return points.map((_, k) => values.slice(k * 4, k * 4 + 4));
        };
        await render();
        const baseline = await probe();
        // Use the actual display transform as the color oracle: PBR Neutral desaturates bright primaries.
        const displayColor = async (color) => {
          const id = overlays.addPolygon(
            [
              [
                [-64, -64],
                [64, -64],
                [64, 64],
                [-64, 64],
              ],
            ],
            { color },
          );
          await render();
          const centre = (96 * 192 + 96) * 4,
            value = [...readCanvas(canvas).slice(centre, centre + 3)];
          overlays.remove(id);
          await render();
          return value;
        };
        const redDisplay = await displayColor([1, 0, 0, 1]),
          greenDisplay = await displayColor([0, 1, 0, 1]);
        const a = overlays.addPolyline(
          [
            [-20, -16],
            [20, -16],
          ],
          { width: 4, color: [1, 0, 0, 1] },
        );
        const polygon = [
          [
            [-15, 5],
            [15, 5],
            [15, 25],
            [-15, 25],
          ],
          [
            [-4, 11],
            [4, 11],
            [4, 19],
            [-4, 19],
          ],
        ];
        const b = overlays.addPolygon(polygon, { color: [0, 1, 0, 1] });
        const firstBake = await render();
        // Read before the probe's mapAsync: once the browser presents, the canvas reads as transparent black.
        const pixels = readCanvas(canvas);
        const painted = await probe();
        let red = 0,
          green = 0;
        for (let k = 0; k < pixels.length; k += 4) {
          if (redDisplay.every((value, c) => pixels[k + c] === value)) red++;
          if (greenDisplay.every((value, c) => pixels[k + c] === value)) green++;
        }
        const still = await render();
        overlays.setPolyline(
          a,
          [
            [-20, -16],
            [20, -16],
          ],
          { width: 8, color: [1, 0, 0, 1] },
        );
        const updateBake = await render(),
          widened = await probe();
        overlays.setStyle(b, { color: [0, 1, 0, 0.5] });
        await render();
        const alpha = await probe();
        overlays.remove(a);
        overlays.remove(b);
        await render();
        const restored = await probe();
        const geo = {
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              properties: { color: 'road' },
              geometry: {
                type: 'LineString',
                coordinates: [
                  [-0.2, -0.16],
                  [0.2, -0.16],
                ],
              },
            },
            {
              type: 'Feature',
              properties: { color: 'park' },
              geometry: {
                type: 'Polygon',
                coordinates: polygon.map((ring) => [
                  ...ring.map(([x, z]) => [x / 100, z / 100]),
                  [ring[0][0] / 100, ring[0][1] / 100],
                ]),
              },
            },
          ],
        };
        const g = overlays.addGeoJSON(geo, {
          project: ([lon, lat]) => [lon * 100, lat * 100],
          style: (f) => ({ width: 4, color: f.properties.color === 'road' ? [1, 0, 0, 1] : [0, 1, 0, 1] }),
        });
        await render();
        const geoJSON = await probe();
        overlays.setGeoJSON(
          g,
          { type: 'FeatureCollection', features: [] },
          { project: ([lon, lat]) => [lon * 100, lat * 100] },
        );
        await render();
        const empty = await probe();
        // Changing the imagery layer set after the first baked frame must refresh both shader layouts and paint.
        const white = device.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: 6 });
        device.queue.writeTexture({ texture: white }, new Uint8Array([255, 255, 255, 255]), { bytesPerRow: 4 }, [1, 1]);
        const secondImage = imagery.add({ source: { texture: () => white } });
        await render();
        const changedImage = await probe();
        imagery.remove(secondImage);
        await render();
        const originalImage = await probe();
        const error = await device.popErrorScope();
        out[steep] = {
          baseline,
          painted,
          widened,
          alpha,
          restored,
          geoJSON,
          empty,
          changedImage,
          originalImage,
          firstBake,
          updateBake,
          still,
          red,
          green,
          redDisplay,
          greenDisplay,
          error: error?.message ?? null,
        };
        overlays.dispose();
        imagery.remove(imageId);
        imagery.dispose();
        texture.destroy();
        white.destroy();
        rvt.dispose();
        terrain.dispose();
        engine.dispose();
        canvas.remove();
      }
      photo.close();
      elevation.close();
      return out;
    });
    assert.deepEqual(errors, []);
    for (const [mode, r] of Object.entries(result)) {
      assert.equal(r.error, null, mode);
      assert.ok(
        r.redDisplay[0] > r.redDisplay[1] && r.greenDisplay[1] > r.greenDisplay[0],
        `${mode}: primary display reference`,
      );
      for (const k of [0, 1, 6]) assert.deepEqual(r.painted[k], [1, 0, 0, 1], `${mode}: metre-width stroke ${k}`);
      assert.deepEqual(r.painted[3], [0, 1, 0, 1], `${mode}: polygon fill`);
      for (const k of [2, 4, 5])
        assert.deepEqual(r.painted[k], r.baseline[k], `${mode}: outside stroke / polygon hole / exterior ${k}`);
      assert.deepEqual(r.widened[2], [1, 0, 0, 1], `${mode}: live width is in metres`);
      assert.deepEqual(r.restored, r.baseline, `${mode}: removal restores imagery exactly`);
      assert.deepEqual(r.geoJSON, r.painted, `${mode}: GeoJSON projects to the same drawing`);
      assert.deepEqual(r.empty, r.baseline, `${mode}: live GeoJSON replacement`);
      assert.deepEqual(r.originalImage, r.baseline, `${mode}: layer-set restoration`);
      for (const value of r.changedImage) assert.deepEqual(value, [1, 1, 1, 1]);
      for (let c = 0; c < 3; c++)
        assert.ok(
          Math.abs(r.alpha[3][c] - (r.baseline[3][c] * 0.5 + (c === 1 ? 0.5 : 0))) < 0.005,
          `${mode}: linear alpha`,
        );
      assert.equal(r.still, 0, `${mode}: unchanged frame does no bake work`);
      assert.ok(r.firstBake > 0 && r.firstBake < 4 * 256 ** 2, `${mode}: edits invalidate regions`);
      assert.ok(r.updateBake > 0 && r.updateBake < 4 * 256 ** 2, `${mode}: width invalidates old and new regions`);
      assert.ok(r.red > 30 && r.green > 30, `${mode}: overlays visible on the actual terrain, not just a probe`);
    }
    console.log(
      'overlays:',
      JSON.stringify(
        Object.fromEntries(
          Object.entries(result).map(([k, r]) => [
            k,
            { firstBake: r.firstBake, updateBake: r.updateBake, red: r.red, green: r.green },
          ]),
        ),
      ),
    );
    await writeFile(
      'test-results/terrain-overlays.json',
      JSON.stringify({ hardware: context.hardware, result }, null, 2),
    );
  },
  () => context.close(),
);
watchExit();
