// Real GPU composition and draping, native and --compat. Reuses the CC0 Poly Haven Aerial Rocks 02 fixture.
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
      const { PlanetTerrain } = await import('/packages/terrain/dist/planet.js');
      const { TerrainImagery, xyzImagery, wmtsImagery } = await import('/packages/terrain/dist/imagery.js');
      const { TerrainVirtualTexture } = await import('/packages/terrain/dist/rvt.js');
      const { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
      const photoURL = '/packages/terrain/test/fixtures/aerial-rocks-02/aerial_rocks_02_diff_1k.jpg';
      const bitmap = await createImageBitmap(await (await fetch(photoURL)).blob(), {
        colorSpaceConversion: 'none',
        premultiplyAlpha: 'none',
      });
      const out = {};
      for (const kind of ['clipmap', 'rvt', 'planet']) {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 128;
        document.body.append(canvas);
        const engine = await Engine.create(canvas, {
          backend: 'webgpu',
          exactSize: [128, 128],
          camera: {
            position: kind === 'planet' ? [300, 0, 0] : [0, 100, 100],
            target: [0, 0, 0],
            near: 0.1,
            far: 2000,
          },
        });
        const device = engine.gpu;
        device.pushErrorScope('validation');
        engine.lighting.direction.set([0, 1, 0, 0]);
        engine.lighting.radiance.set([0, 0, 0, 1]);
        const terrain =
          kind === 'planet'
            ? PlanetTerrain.attach(engine, {
                radius: 100,
                relief: 0,
                height: () => 0,
                seaLevel: false,
                maxPatches: 128,
                resolution: 8,
                maxLevel: 4,
                budget: Infinity,
              })
            : Terrain.attach(engine, {
                origin: [-100, -100],
                size: [200, 200],
                resolution: 16,
                levels: 5,
                cellSize: 2,
                heightScale: 1,
                layers: Array.from({ length: 4 }, () => ({ height: [-1, 100], slope: [0, 1], scale: 0.1 })),
                textures(gpu) {
                  const heightmap = gpu.createTexture({ size: [2, 2], format: 'r32float', usage: 6 });
                  gpu.queue.writeTexture(
                    { texture: heightmap },
                    new Float32Array([0, 10, 0, 10]),
                    { bytesPerRow: 8 },
                    [2, 2],
                  );
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
        const rvt =
          kind === 'rvt'
            ? TerrainVirtualTexture.attach(engine, terrain, { size: 256, levels: 2, texel: 1 })
            : undefined;
        const imagery = TerrainImagery.attach(engine, terrain, { maxLayers: 4, maxTiles: 4, automatic: false });
        const photo = device.createTexture({ size: [1024, 1024], format: 'rgba8unorm-srgb', usage: 6 | 16 });
        device.queue.copyExternalImageToTexture({ source: bitmap }, { texture: photo }, [1024, 1024]);
        const solid = (rgba) => {
          const t = device.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: 6 });
          device.queue.writeTexture({ texture: t }, new Uint8Array(rgba), { bytesPerRow: 4 }, [1, 1]);
          return t;
        };
        const red = solid([255, 0, 0, 255]),
          green = solid([0, 255, 0, 255]);
        const read = async () => {
          await waitForPipelines(async () => {
            engine.render({ delta: 0 });
            await device.queue.onSubmittedWorkDone();
          });
          engine.render({ delta: 0 });
          const ctx = new OffscreenCanvas(128, 128).getContext('2d');
          ctx.drawImage(canvas, 0, 0);
          return [...ctx.getImageData(0, 0, 128, 128).data];
        };
        const difference = (a, b) => a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i])), 0);
        const a = imagery.add({ source: { texture: () => red } });
        const base = await read();
        const b = imagery.add({ source: { texture: () => green }, alpha: 0.5, brightness: 0.5 });
        const mixed = await read();
        // Linear blend red*0.5 + green*0.25: compare against a GPU texture with exactly that linear color.
        const reference = solid([128, 64, 0, 255]);
        imagery.set(a, { show: false });
        imagery.set(b, { show: false });
        const r = imagery.add({ source: { texture: () => reference } });
        const expected = await read();
        out[kind] = { blend: difference(mixed, expected), red: base.filter((v, i) => i % 4 === 0 && v > 80).length };
        imagery.remove(r);
        imagery.set(a, { show: true });
        imagery.set(b, { show: true });
        imagery.move(a, 1);
        out[kind].reorder = difference(base, await read());
        imagery.remove(a);
        imagery.remove(b);
        const p = imagery.add({ source: { texture: () => photo } });
        const photograph = await read();
        imagery.remove(p);
        const x = imagery.add({
          source: xyzImagery(photoURL + '?z={z}&x={x}&y={y}', {
            tileSize: 1024,
            maxLevel: 0,
            projection: 'geographic',
          }),
        });
        await imagery.ready;
        out[kind].xyz = difference(photograph, await read());
        imagery.remove(x);
        const w = imagery.add({
          source: wmtsImagery({
            url: new URL(photoURL, location.href).href,
            layer: 'CC0 rock',
            matrixSet: 'local',
            tileSize: 1024,
            maxLevel: 0,
            projection: 'geographic',
          }),
        });
        await imagery.ready;
        out[kind].wmts = difference(photograph, await read());
        imagery.set(w, { bounds: kind === 'planet' ? [-15, -30, 15, 30] : [-20, -20, 20, 20] });
        const bounded = await read();
        out[kind].bounds = difference(bounded, photograph);
        imagery.set(w, { alpha: 0 });
        const hidden = await read();
        imagery.remove(w);
        out[kind].hidden = difference(hidden, await read());
        const error = await device.popErrorScope();
        out[kind].error = error?.message ?? null;
        imagery.dispose();
        photo.destroy();
        red.destroy();
        green.destroy();
        reference.destroy();
        rvt?.dispose();
        terrain.dispose();
        engine.dispose();
        canvas.remove();
      }
      bitmap.close();
      return out;
    });
    console.log('imagery:', JSON.stringify(result));
    assert.deepEqual(errors, []);
    for (const [kind, r] of Object.entries(result)) {
      assert.equal(r.error, null, kind);
      assert.ok(r.red > 1000, `${kind} visible terrain`);
      assert.ok(r.blend <= 1, `${kind} linear alpha/brightness ${r.blend}`);
      assert.equal(r.reorder, 0, `${kind} order`);
      assert.equal(r.xyz, 0, `${kind} XYZ equals GPU photo`);
      assert.equal(r.wmts, 0, `${kind} WMTS equals GPU photo`);
      assert.ok(r.bounds > 20, `${kind} clipped bounds`);
      assert.equal(r.hidden, 0, `${kind} alpha zero`);
    }
    await writeFile(
      'test-results/terrain-imagery.json',
      JSON.stringify({ hardware: context.hardware, result }, null, 2),
    );
  },
  () => context.close(),
);
watchExit();
