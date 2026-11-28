// Real-GPU check (run from the repository root after building packages; MARGO_COMPAT=1 runs it on the WebGL2 layer):
//   node packages/terrain/test/rock-structure.browser.mjs
// TerrainOptions.rock (Above the Treeline look round 4): steep faces of a 4 to 30 m heightmap drew as one smooth grey
// plane from 100 m to 5 km. A plane at 50 degrees with one grey layer, lit from the side:
// 1. without rock the face is one even tone; with rock its ledges and facets spread the tones widely;
// 2. a slope of 10 degrees, under the rock's slope range, draws exactly what it draws without rock;
// 3. from far enough that a pixel covers a block, the face is even again and keeps its mean (no aliasing);
// 4. a structure texture: a drainage line carves a gully the plain face does not have, and debris on gentle ground
//    gives its weight to the debris layer;
// 5. look round 5: blocks 200 to 600 m away read as low-poly shards (a hard switch of the facet normal at each cell
//    edge, full relief and dark joints while a block still spans only 10 to 60 pixels). Seen with blocks a few dozen
//    pixels across, neighbouring pixels rarely jump in tone (edges blend across the cell boundary, relief and joint
//    contrast fade with the pixel footprint), while a close view keeps its spread of tones.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite, watchExit } from '../../../scripts/support/shutdown.mjs';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
const context = await openBrowser({ startPath: '/tests/modern-game.html', port: 'free' }),
  { page, hardware } = context;
await runSuite(
  async () => {
    const result = await page.evaluate(async () => {
      const { Engine } = await import('/packages/core/dist/index.js'),
        { Terrain } = await import('/packages/terrain/dist/index.js'),
        size = 128,
        errors = [],
        rules = Array.from({ length: 4 }, () => ({ height: [-1e5, 1e5], slope: [0, 1], scale: 0.25 })),
        // Layer 0 grey, layer 1 green, the rest black.
        colours = (gpu) => {
          const layers = gpu.createTexture({ size: [1, 1, 4], format: 'rgba8unorm-srgb', usage: 6 });
          gpu.queue.writeTexture(
            { texture: layers },
            new Uint8Array([150, 150, 150, 255, 40, 200, 40, 255, 0, 0, 0, 255, 0, 0, 0, 255]),
            { bytesPerRow: 4, rowsPerImage: 1 },
            [1, 1, 4],
          );
          return layers;
        },
        plane = (gpu, w, h, data, format, bytes) => {
          const texture = gpu.createTexture({ size: [w, h], format, usage: 6 });
          gpu.queue.writeTexture({ texture }, data, { bytesPerRow: w * bytes }, [w, h]);
          return texture;
        };
      async function picture({ degrees, rock, structure, distance = 160 }) {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        document.body.append(canvas);
        const t = Math.tan((degrees * Math.PI) / 180),
          n = [0, 1 / Math.hypot(1, t), -t / Math.hypot(1, t)],
          engine = await Engine.create(canvas, {
            backend: 'webgpu',
            camera: { position: n.map((v) => v * distance), target: [0, 0, 0], near: 1, far: 100000, fov: 40 },
          }),
          device = engine.gpu;
        device.pushErrorScope('validation');
        const weights = new Uint8Array(16 * 16 * 4);
        for (let i = 0; i < 256; i++) weights[i * 4] = 255;
        const terrain = Terrain.attach(engine, {
          origin: [-2000, -2000],
          size: [4000, 4000],
          heightScale: 1,
          cellSize: 2,
          levels: 12,
          layers: rules,
          ...(rock ? { rock } : {}),
          textures: (gpu) => ({
            heightmap: plane(gpu, 65, 65, Float32Array.from({ length: 65 * 65 }, (_, i) => (Math.floor(i / 65) * 62.5 - 2000) * t), 'r32float', 4),
            layers: colours(gpu),
            weights: [plane(gpu, 16, 16, weights, 'rgba8unorm', 4), plane(gpu, 16, 16, new Uint8Array(1024), 'rgba8unorm', 4)],
            ...(structure ? { structure: structure(gpu) } : {}),
          }),
        });
        engine.lighting.direction.set([0.55, 0.62, -0.56, 4]);
        const read = () => {
          engine.render({ delta: 1 / 60 });
          const c = new OffscreenCanvas(size, size).getContext('2d');
          c.drawImage(canvas, 0, 0);
          return c.getImageData(0, 0, size, size).data;
        };
        read();
        await device.queue.onSubmittedWorkDone();
        const pixels = read(),
          error = await device.popErrorScope();
        if (error) errors.push(error.message);
        terrain.dispose();
        engine.dispose();
        canvas.remove();
        return pixels;
      }
      const stats = (p) => {
          const l = [];
          let green = 0;
          for (let i = 0; i < p.length; i += 4) {
            l.push((p[i] + p[i + 1] + p[i + 2]) / 3);
            if (p[i + 1] > p[i] + 40) green++;
          }
          const mean = l.reduce((a, b) => a + b, 0) / l.length;
          // The share of neighbouring pixel pairs (across and down) whose tone jumps by more than 10 of 255.
          let jumps = 0;
          for (let y = 0; y < size - 1; y++)
            for (let x = 0; x < size - 1; x++) {
              const i = y * size + x;
              if (Math.abs(l[i] - l[i + 1]) > 10) jumps++;
              if (Math.abs(l[i] - l[i + size]) > 10) jumps++;
            }
          return {
            mean,
            sd: Math.sqrt(l.reduce((a, b) => a + (b - mean) ** 2, 0) / l.length),
            green: green / l.length,
            jumps: jumps / (2 * (size - 1) ** 2),
          };
        },
        worst = (a, b) => a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i])), 0),
        mean = (a, b) => a.reduce((m, v, i) => m + Math.abs(v - b[i]), 0) / a.length,
        rock = { strata: 6, facets: 9, ledges: 0.8, relief: 0.5 },
        // 64 x 64 texels over the 4 km bounds: a drainage line down the middle column, then debris everywhere.
        map = (g) => (gpu) => {
          const data = new Uint8Array(64 * 64 * 4);
          for (let z = 0; z < 64; z++)
            for (let x = 0; x < 64; x++) {
              const i = (z * 64 + x) * 4;
              data[i] = x === 32 ? 255 : 0;
              data[i + 1] = g;
              data[i + 3] = 255;
            }
          return plane(gpu, 64, 64, data, 'rgba8unorm', 4);
        },
        out = {};
      out.plain = stats(await picture({ degrees: 50 }));
      out.rock = stats(await picture({ degrees: 50, rock }));
      out.gentle = worst(await picture({ degrees: 10 }), await picture({ degrees: 10, rock }));
      // Blocks of 16 m (and 66 m buttresses) at 60 m on a 128-pixel view of 40 degrees: a pixel covers 0.34 m and a
      // block about 47 pixels, as on the film's summit face 450 m away at 1080p. The close view: 9 m blocks at 10 m.
      out.midRock = stats(await picture({ degrees: 50, rock: { ...rock, strata: 0, facets: 16 }, distance: 60 }));
      out.midPlain = stats(await picture({ degrees: 50, distance: 60 }));
      out.closeRock = stats(await picture({ degrees: 50, rock: { ...rock, strata: 0 }, distance: 10 }));
      out.farPlain = stats(await picture({ degrees: 50, distance: 2500 }));
      out.farRock = stats(await picture({ degrees: 50, rock, distance: 2500 }));
      const bare = await picture({ degrees: 50, rock: { ...rock, strata: 0, facets: 0, gullies: 30 }, distance: 1500 }),
        gully = await picture({
          degrees: 50,
          rock: { ...rock, strata: 0, facets: 0, gullies: 30 },
          structure: map(0),
          distance: 1500,
        });
      out.gully = mean(bare, gully);
      out.debris = stats(
        await picture({ degrees: 10, rock: { ...rock, slope: [20, 40], debris: 1 }, structure: map(255) }),
      ).green;
      out.noDebris = stats(await picture({ degrees: 10, rock: { ...rock, slope: [20, 40] }, structure: map(255) })).green;
      out.errors = errors;
      return out;
    });
    console.log('terrain rock structure check:', JSON.stringify({ hardware, result }));
    assert.deepEqual(result.errors, []);
    assert.ok(result.plain.sd < 4, `the plain face is one even tone (sd ${result.plain.sd})`);
    assert.ok(result.rock.sd > 3 * Math.max(result.plain.sd, 2), `rock spreads the tones (sd ${result.rock.sd})`);
    assert.ok(result.gentle <= 1, `gentle ground draws as without rock (largest difference ${result.gentle})`);
    assert.ok(result.farRock.sd < result.farPlain.sd + 3, `far rock is even again, no aliasing (sd ${result.farRock.sd})`);
    assert.ok(Math.abs(result.farRock.mean - result.farPlain.mean) < 0.05 * result.farPlain.mean, 'far rock keeps its mean');
    assert.ok(
      // Before the fix: 0.027 of the pairs jumped and the sd was 22; after it 0.003 and 11.
      result.midRock.jumps < 0.01,
      `blocks a few dozen pixels across have no hard edges (share of tone jumps ${result.midRock.jumps})`,
    );
    assert.ok(result.midRock.sd < result.midPlain.sd + 15, `mid-distance relief is filtered (sd ${result.midRock.sd})`);
    assert.ok(result.closeRock.sd > 3 * Math.max(result.plain.sd, 2), `a close view keeps its facets (sd ${result.closeRock.sd})`);
    assert.ok(result.gully > 0.5, `a drainage line carves a gully (mean difference ${result.gully})`);
    assert.ok(result.debris > 0.9 && result.noDebris < 0.01, 'debris gives its weight to the debris layer');
  },
  () => context.close(),
);
watchExit();
