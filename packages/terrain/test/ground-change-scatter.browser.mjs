// Real-GPU check (run from the repository root after building packages; MARGO_COMPAT=1 for the WebGL2 layer):
//   node scripts/run-with-timeout.mjs --max=10 -- node packages/terrain/test/ground-change-scatter.browser.mjs
// Plants follow ground that changes on screen: a `Scatter` (`@margoengine/scatter`) given `change.scatterGround()` over a
// heightfield mesh with a burn scar and a lava flow:
// 1. its heightmap holds the ground's heights (base plus change) exactly, texel for texel, after the change moved;
// 2. its density map keeps 255 on untouched ground and clears plants exactly where fresh soil, mud, ash, char or lava
//    covers the ground (255 less the strongest cover byte);
// 3. its plant covers (`plantCovers()`, for @margoengine/scatter/states) hold mud, ash and char of the surface bytes and
//    the wetness byte, texel for texel, over the scatter maps' rectangle;
// 4. on screen, the burn scar and the lava are bare of plants while the ground beside them keeps its green;
// no validation error throughout.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite, watchExit } from '../../../scripts/support/shutdown.mjs';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
const context = await openBrowser({ startPath: '/tests/modern-game.html', port: 'free' }),
  { page } = context;
await runSuite(
  async () => {
    const result = await page.evaluate(async () => {
      const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js'),
        { heightfieldGeometry } = await import('/packages/terrain/dist/index.js'),
        { GroundChange } = await import('/packages/terrain/dist/ground-change.js'),
        { Scatter } = await import('/packages/scatter/dist/index.js'),
        { toGeometry } = await import('/packages/geometry/dist/utils.js'),
        { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
      const size = 192,
        grid = { size: [48, 48], resolution: 96 },
        n = 97,
        hills = (x, z) => 0.05 * z + 0.4 * Math.sin(x * 0.2),
        canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      document.body.append(canvas);
      const engine = await Engine.create(canvas, {
          backend: 'webgpu',
          camera: { position: [0, 70, 1], target: [0, 0, 0], near: 1, far: 300 },
        }),
        device = engine.gpu;
      device.pushErrorScope('validation');
      engine.lighting.direction.set([0.3, 1, 0.2, 3]);
      engine.lighting.radiance.set([1, 1, 1, 0.4]);
      const mesh = engine
          .createMesh()
          .setGeometry(toGeometry(heightfieldGeometry(hills, grid)))
          .setMaterial(new PbrMaterial({ color: [0.3, 0.22, 0.15], roughness: 0.9 })),
        change = GroundChange.attach(engine, mesh, {
          grid,
          events: [
            { kind: 'burn', ignition: [-12, 0], rate: 0.25, duration: 30, roughness: 0 },
            { kind: 'lava', path: [[12, -24], [12, 24]], width: 6, thickness: 2, duration: 5, roughness: 0 },
          ],
        }),
        plants = Scatter.attach(engine, box(0.2, 0.8, 0.2), {
          count: 60000,
          area: [48, 48],
          maxSlope: 90,
          lod: [200, 300, 400],
          color: [0.05, 0.8, 0.05],
          ...change.scatterGround(),
        });
      change.setTime(30);
      // Frames until no pipeline is compiling (scripts/support/gpu-ready.js), however long the driver takes.
      await waitForPipelines(async () => {
        engine.render({ delta: 0 });
        await device.queue.onSubmittedWorkDone();
      });
      engine.render({ delta: 0 });
      const c = new OffscreenCanvas(size, size).getContext('2d');
      c.drawImage(canvas, 0, 0);
      const pixels = c.getImageData(0, 0, size, size).data,
        matrix = engine.camera.matrix.slice();
      async function read(texture, bytes) {
        const stride = Math.ceil((n * bytes) / 256) * 256,
          buffer = device.createBuffer({ size: stride * n, usage: 9 }),
          encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: stride }, [n, n]);
        device.queue.submit([encoder.finish()]);
        await buffer.mapAsync(1);
        const mapped = new Uint8Array(buffer.getMappedRange()),
          out = new Uint8Array(n * n * bytes);
        for (let j = 0; j < n; j++) out.set(mapped.subarray(j * stride, j * stride + n * bytes), j * n * bytes);
        buffer.destroy();
        return out;
      }
      const maps = change.scatterGround(),
        heights = new Float32Array((await read(maps.heightmap(), 4)).buffer),
        density = await read(maps.densityMap(), 1),
        want = change.heights,
        { surface, state } = change.covers,
        plantCovers = change.plantCovers(),
        coverBytes = await read(plantCovers.covers(), 4);
      let coverMisses = 0,
        charred = 0;
      for (let k = 0; k < n * n; k++) {
        const want4 = [surface[k * 4], surface[k * 4 + 1], surface[k * 4 + 2], state[k * 4 + 1]];
        if (want4.some((v, i) => coverBytes[k * 4 + i] !== v)) coverMisses++;
        if (coverBytes[k * 4 + 2] > 0) charred++;
      }
      let worstHeight = 0,
        densityMisses = 0,
        cleared = 0;
      for (let k = 0; k < n * n; k++) {
        worstHeight = Math.max(worstHeight, Math.abs(heights[k] - want[k]));
        const kept = 255 - Math.max(surface[k * 4], surface[k * 4 + 1], surface[k * 4 + 2], surface[k * 4 + 3], state[k * 4 + 2]);
        if (density[k] !== kept) densityMisses++;
        if (density[k] === 0) cleared++;
      }
      // World point to canvas pixel through the camera's view-projection (column-major).
      const pixel = (x, y, z) => {
        const m = matrix,
          cx = m[0] * x + m[4] * y + m[8] * z + m[12],
          cy = m[1] * x + m[5] * y + m[9] * z + m[13],
          cw = m[3] * x + m[7] * y + m[11] * z + m[15];
        return [Math.round(((cx / cw) * 0.5 + 0.5) * size), Math.round((0.5 - (cy / cw) * 0.5) * size)];
      };
      const green = ([px, py], r = 4) => {
        let count = 0;
        for (let y = py - r; y <= py + r; y++)
          for (let x = px - r; x <= px + r; x++) {
            const i = (y * size + x) * 4;
            if (pixels[i + 1] > pixels[i] * 1.6 && pixels[i + 1] > pixels[i + 2] * 1.6) count++;
          }
        return count / ((2 * r + 1) * (2 * r + 1));
      };
      const out = {
        worstHeight,
        densityMisses,
        coverMisses,
        charred,
        sameBounds: JSON.stringify(plantCovers.bounds) === JSON.stringify(maps.bounds),
        cleared,
        lavaTop: Math.max(...change.change),
        burn: green(pixel(-12, hills(-12, 0), 0)),
        lava: green(pixel(12, hills(12, 0) + 2, 0)),
        grass: green(pixel(-12, hills(-12, 16), 16)),
        beside: green(pixel(0, hills(0, 0), 0)),
      };
      const error = await device.popErrorScope();
      out.errors = error ? [error.message] : [];
      plants.dispose();
      change.dispose();
      engine.dispose();
      canvas.remove();
      return out;
    });
    assert.deepEqual(result.errors, [], 'no validation errors');
    assert.ok(result.lavaTop > 1.5, `the lava raises the ground: ${result.lavaTop}`);
    assert.equal(result.worstHeight, 0, `the scatter heightmap holds the changed ground: ${result.worstHeight}`);
    assert.equal(result.densityMisses, 0, `the density map clears plants exactly under the covers: ${JSON.stringify(result)}`);
    assert.equal(result.coverMisses, 0, `the plant covers hold the covers exactly: ${result.coverMisses}`);
    assert.ok(result.charred > 100 && result.sameBounds, `the burn chars plant cover texels over the scatter rectangle: ${JSON.stringify(result)}`);
    assert.ok(result.cleared > 200, `the burn and the lava clear texels: ${result.cleared}`);
    assert.ok(result.grass > 0.3 && result.beside > 0.3, `untouched ground keeps its plants: ${JSON.stringify(result)}`);
    assert.ok(result.burn < 0.02 && result.lava < 0.02, `the burn scar and the lava are bare: ${JSON.stringify(result)}`);
    console.log(`ok terrain ground change with scatter (${process.env.MARGO_COMPAT === "1" ? "compat" : "native"}) ${JSON.stringify(result)}`);
  },
  () => context.close(),
);
watchExit();
