// Real-GPU check (run from the repository root after building packages; MARGO_COMPAT=1 for the WebGL2 layer):
//   node scripts/run-with-timeout.mjs --max=10 -- node packages/terrain/test/rocks.browser.mjs
// Cliffs and rock that hold up close (`@margoengine/terrain/rocks`, `/rock-surface`): a cliff piece found by
// `findRockSites` on a 12 m step and built by `buildCliff`, standing on a flat clipmap `Terrain`, seen square from 12 m at 3 m up.
// The same view is drawn on a plain grey material and with `RockSurface`:
// 1. close-up detail: the mean absolute Laplacian of luminance over the face is over 2.5 times the plain mesh's
//    (the geometry alone is smooth at this distance; the per-pixel relief, beds and cracks are the detail);
// 2. rain: `look.rain` 1 darkens the face by over a fifth of its light (wet rock, Lekner and Dorf 1988);
// 3. tide band: with the rock's sea level at 4 m, the face below about 5.5 m is darker by over a quarter (measured 2 to 3.6 m) and the face from 7 to 9.5 m is unchanged;
// 4. with `TerrainBlend` on as well, the cliff's foot takes the ground's colour (the blend is laid over the rock);
// 5. far off (150 m), a camera move of a quarter pixel changes the rock picture no more than twice the plain one's
//    (each octave fades as it nears the pixel footprint, so the detail does not shimmer);
// no validation error throughout.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite, watchExit } from '../../../scripts/support/shutdown.mjs';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
await mkdir('test-results', { recursive: true });
const context = await openBrowser({ startPath: '/tests/modern-game.html', port: 'free' }),
  { page, hardware } = context;
await runSuite(
  async () => {
    const result = await page.evaluate(async () => {
      const { Engine, PbrMaterial } = await import('/packages/core/dist/index.js'),
        { Terrain } = await import('/packages/terrain/dist/index.js'),
        { TerrainVirtualTexture } = await import('/packages/terrain/dist/rvt.js'),
        { TerrainBlend } = await import('/packages/terrain/dist/blend.js'),
        { findRockSites, buildCliff } = await import('/packages/terrain/dist/rocks.js'),
        { RockSurface } = await import('/packages/terrain/dist/rock-surface.js');
      const size = 192,
        n = 65,
        errors = [];
      // The ground the cliff is found and built on: 0 m for z < 0 rising to a 12 m plateau (steepest 63 degrees).
      const g = 129,
        heights = new Float32Array(g * g);
      for (let j = 0; j < g; j++)
        for (let i = 0; i < g; i++) heights[j * g + i] = 12 / (1 + Math.exp(-(j * 0.5 - 32 - 3) / 1.5));
      const ground = { heights, resolution: [g, g], origin: [-32, -32], size: [64, 64] },
        sites = findRockSites(ground, { cliffRelief: 4, cliffWidth: 16, seaRocks: 0, boulders: 0 }),
        site = sites.cliffs.reduce((a, b) => (Math.abs(b.position[0]) < Math.abs(a.position[0]) ? b : a)),
        rock = buildCliff(site, ground, { overhang: 1.5 });
      async function picture({ surface, blend, style, far = false, shift = 0, empty = false } = {}) {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        document.body.append(canvas);
        const z = far ? -150 : -12,
          engine = await Engine.create(canvas, {
            backend: 'webgpu',
            camera: {
              position: [site.position[0] + shift, 3, site.position[2] + z],
              target: [site.position[0] + shift, 3, site.position[2]],
              near: 0.1,
              far: 400,
            },
          }),
          device = engine.gpu;
        device.pushErrorScope('validation');
        engine.lighting.direction.set([0.3, 0.7, -0.6, 3]);
        const terrain = Terrain.attach(engine, {
          origin: [-32, -32],
          size: [64, 64],
          heightScale: 1,
          cellSize: 0.25,
          levels: 6,
          layers: Array.from({ length: 4 }, () => ({ height: [-1e5, 1e5], slope: [0, 1], scale: 1 })),
          textures: (gpu) => {
            const heightmap = gpu.createTexture({ size: [n, n], format: 'r32float', usage: 6 }),
              layers = gpu.createTexture({ size: [4, 4, 4], format: 'rgba8unorm-srgb', usage: 6 }),
              sand = new Uint8Array(64 * 4);
            gpu.queue.writeTexture({ texture: heightmap }, new Float32Array(n * n), { bytesPerRow: n * 4 }, [n, n]);
            for (let i = 0; i < sand.length; i += 4) sand.set([176, 140, 92, 255], i);
            gpu.queue.writeTexture({ texture: layers }, sand, { bytesPerRow: 16, rowsPerImage: 4 }, [4, 4, 4]);
            return { heightmap, layers };
          },
        });
        const mesh = empty
          ? undefined
          : engine
              .createMesh()
              .setGeometry(rock.geometry)
              .setMaterial(new PbrMaterial({ color: '#7a7066', roughness: 0.85 }))
              .setPosition(rock.position);
        const rvt = blend ? TerrainVirtualTexture.attach(engine, terrain, { texel: 0.02 }) : undefined,
          blending = blend && mesh ? TerrainBlend.attach(engine, terrain, rvt, { height: 1 }).add(mesh) : undefined,
          rocks = surface && mesh ? RockSurface.attach(engine, surface).add(mesh, style) : undefined;
        for (let k = 0; k < 4; k++) engine.render({ delta: 1 / 60 });
        await device.queue.onSubmittedWorkDone();
        engine.render({ delta: 1 / 60 });
        const c = new OffscreenCanvas(size, size).getContext('2d');
        c.drawImage(canvas, 0, 0);
        const pixels = c.getImageData(0, 0, size, size).data;
        const error = await device.popErrorScope();
        if (error) errors.push(error.message);
        rocks?.dispose();
        blending?.dispose();
        rvt?.dispose();
        terrain.dispose();
        engine.dispose();
        canvas.remove();
        return pixels;
      }
      const lum = (p, x, y) => {
        const k = (y * size + x) * 4;
        return 0.2126 * p[k] + 0.7152 * p[k + 1] + 0.0722 * p[k + 2];
      };
      // The face fills the middle of the close view; measure inside a window clear of its edges.
      const x0 = 48,
        x1 = 144,
        y0 = 40,
        y1 = 150;
      const detail = (p) => {
        let sum = 0,
          count = 0;
        for (let y = y0; y < y1; y++)
          for (let x = x0; x < x1; x++) {
            sum += Math.abs(
              4 * lum(p, x, y) - lum(p, x - 1, y) - lum(p, x + 1, y) - lum(p, x, y - 1) - lum(p, x, y + 1),
            );
            count++;
          }
        return sum / count;
      };
      // Mean linear luminance (the canvas holds sRGB codes), so a ratio is a ratio of light.
      const linear = (v) => ((v / 255 + 0.055) / 1.055) ** 2.4;
      const mean = (p, ya = y0, yb = y1) => {
        let sum = 0,
          count = 0;
        for (let y = ya; y < yb; y++)
          for (let x = x0; x < x1; x++, count++) {
            const k = (y * size + x) * 4;
            sum += 0.2126 * linear(p[k]) + 0.7152 * linear(p[k + 1]) + 0.0722 * linear(p[k + 2]);
          }
        return sum / count;
      };
      const change = (a, b) => {
        let sum = 0;
        for (let k = 0; k < a.length; k += 4)
          sum += Math.abs(a[k] - b[k]) + Math.abs(a[k + 1] - b[k + 1]) + Math.abs(a[k + 2] - b[k + 2]);
        return sum / (a.length / 4);
      };
      const plain = await picture(),
        shaded = await picture({ surface: {} }),
        rained = await picture({ surface: { rain: 1 } }),
        tidal = await picture({ surface: {}, style: { seaLevel: 4 } }),
        blended = await picture({ surface: {}, blend: true }),
        bare = await picture({ empty: true }),
        farPlain = [await picture({ far: true }), await picture({ far: true, shift: 0.2 })],
        farRock = [await picture({ surface: {}, far: true }), await picture({ surface: {}, far: true, shift: 0.2 })];
      // Rows of the close view by height on the face plane: the camera at 3 m looks level, 12 m away with a 60 degree
      // field (core's default), so a row y shows height 3 + (96 - y) / 96 * 12 * tan(30 degrees); rows under height 0
      // show the flat ground in front of the foot.
      const rowOf = (h) => Math.round(96 - ((h - 3) / (12 * Math.tan(Math.PI / 6))) * 96);
      const below = [rowOf(3.6), rowOf(2)].sort((a, b) => a - b),
        above = [rowOf(9.5), rowOf(7)].sort((a, b) => a - b);

      return {
        errors,
        site: { position: site.position, top: site.top, base: site.base },
        detail: { plain: detail(plain), shaded: detail(shaded) },
        rain: { dry: mean(shaded, y0, rowOf(1.6)), wet: mean(rained, y0, rowOf(1.6)) },
        tide: {
          below: mean(tidal, ...below) / mean(shaded, ...below),
          above: mean(tidal, ...above) / mean(shaded, ...above),
        },
        foot: (() => {
          // The pixels the blend changes, and their colour distance from the bare ground the rock hides there.
          let count = 0,
            rock = 0,
            mixed = 0,
            highest = size;
          for (let y = 0; y < size; y++)
            for (let x = 0; x < size; x++) {
              const k = (y * size + x) * 4,
                d = (p) =>
                  Math.abs(p[k] - bare[k]) + Math.abs(p[k + 1] - bare[k + 1]) + Math.abs(p[k + 2] - bare[k + 2]);
              if (
                Math.abs(shaded[k] - blended[k]) +
                  Math.abs(shaded[k + 1] - blended[k + 1]) +
                  Math.abs(shaded[k + 2] - blended[k + 2]) <=
                3
              )
                continue;
              count++;
              highest = Math.min(highest, y);
              rock += d(shaded);
              mixed += d(blended);
            }
          return { count, highest, rock: rock / count, blended: mixed / count };
        })(),
        shimmer: { plain: change(...farPlain), rock: change(...farRock) },
      };
    });
    console.log('terrain rocks:', JSON.stringify(result));
    assert.deepEqual(result.errors, []);
    const r = result;
    assert.ok(r.detail.shaded > 2.5 * r.detail.plain, `close-up detail: ${JSON.stringify(r.detail)}`);
    assert.ok(r.rain.wet < 0.8 * r.rain.dry, `rain darkens the rock: ${JSON.stringify(r.rain)}`);
    assert.ok(r.tide.below < 0.75, `the tide band is darker: ${JSON.stringify(r.tide)}`);
    assert.ok(Math.abs(r.tide.above - 1) < 0.02, `the rock above the tide is unchanged: ${JSON.stringify(r.tide)}`);
    assert.ok(r.foot.count > 200, `the blend changes the cliff's foot: ${JSON.stringify(r.foot)}`);
    assert.ok(
      r.foot.blended < r.foot.rock * 0.6,
      `the blend fades the foot into the ground over the rock: ${JSON.stringify(r.foot)}`,
    );
    assert.ok(r.shimmer.rock < 2 * r.shimmer.plain + 0.5, `far rock does not shimmer: ${JSON.stringify(r.shimmer)}`);
    const tag = process.env.MARGO_COMPAT === '1' ? 'compat' : 'native';
    await writeFile(`test-results/terrain-rocks-${tag}.json`, JSON.stringify({ hardware, result }, null, 1));
    console.log(`ok terrain rocks (${tag})`);
  },
  () => context.close(),
);
watchExit();
