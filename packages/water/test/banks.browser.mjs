// Regression KB-BIOMES-RIVERSTEP1: a creek under a clipmap terrain's coarse rings. A 6 m channel runs along z (x 4 to 10)
// banks 1 m above its still water; the terrain's rings (cell 2 m, 16 cells a ring) bridge it with triangles between the
// banks far from the camera, so without WaterBanks the water shows only where a ring vertex falls in the channel. Seen
// from 300 m above, with WaterBanks the water fills the channel's centre column along its whole visible length and never
// shows past its walls (the water's own grid is 8 m cells, the lowest ground under each, so it reaches a cell past the
// walls: the heightmap ends it); the plain frame without water is the reference for which pixels are water. Runs on
// WebGPU and, with --compat, on the WebGL2 compatibility layer.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite, watchExit } from '../../../scripts/support/shutdown.mjs';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
await mkdir('test-results', { recursive: true });
const browser = await openBrowser({ startPath: '/tests/modern-game.html', port: 'free' }),
  mode = browser.hardware?.compat ? 'compat' : 'webgpu';
await runSuite(
  async () => {
    const r = await browser.page.evaluate(async () => {
      const { Engine } = await import('/packages/core/dist/index.js'),
        { Terrain } = await import('/packages/terrain/dist/index.js'),
        { Water } = await import('/packages/water/dist/index.js'),
        { WaterBanks } = await import('/packages/water/dist/banks.js');
      const W = 400,
        H = 400,
        N = 513, // 1 m texels over 512 m, on the corners
        WALL = 3, // the channel is |x - CX| < 3, off every ring's lattice of 4 m and more
        CX = 7,
        BED = 0,
        LEVEL = 1,
        BANK = 2;
      const heights = new Float32Array(N * N);
      for (let j = 0; j < N; j++)
        for (let i = 0; i < N; i++) heights[j * N + i] = Math.abs(i - 256 - CX) < WALL ? BED : BANK;
      // The water's own grid: 64 cells of 8 m, the lowest ground under each (as biomes/rivers builds it).
      const M = 64,
        ground = new Float32Array(M * M);
      for (let j = 0; j < M; j++)
        for (let i = 0; i < M; i++) {
          let low = Infinity;
          for (let v = j * 8; v <= j * 8 + 8; v++) for (let u = i * 8; u <= i * 8 + 8; u++) low = Math.min(low, heights[v * N + u]);
          ground[j * M + i] = low;
        }
      const canvas = document.createElement('canvas');
      canvas.width = W;
      canvas.height = H;
      document.body.append(canvas);
      const engine = await Engine.create(canvas, {
        backend: 'webgpu',
        exactSize: true,
        camera: { position: [0, 300, 0.01], target: [0, 0, 0], near: 1, far: 2000, fov: 60 },
      });
      engine.scene.background = '#00ff00';
      const device = engine.gpu;
      device.pushErrorScope('validation');
      const fine = device.createTexture({ size: [N, N], format: 'r32float', usage: 6 }),
        coarse = device.createTexture({ size: [M, M], format: 'r32float', usage: 6 });
      device.queue.writeTexture({ texture: fine }, heights, { bytesPerRow: 4 * N }, [N, N]);
      device.queue.writeTexture({ texture: coarse }, ground, { bytesPerRow: 4 * M }, [M, M]);
      const terrain = Terrain.attach(engine, {
        origin: [-256, -256],
        size: [512, 512],
        heightScale: 1,
        cellSize: 2,
        resolution: 16,
        levels: 6,
        clipmapAnchor: 'camera',
        layers: Array.from({ length: 4 }, () => ({ height: [-500, 500], slope: [0, 1], scale: 0.25 })),
        textures(gpu) {
          const layers = gpu.createTexture({ size: [1, 1, 4], format: 'rgba8unorm-srgb', usage: 6 });
          gpu.queue.writeTexture({ texture: layers }, new Uint8Array(16).fill(120), { bytesPerRow: 4, rowsPerImage: 1 }, [1, 1, 4]);
          return { heightmap: fine, layers };
        },
      });
      const capture = new OffscreenCanvas(W, H).getContext('2d', { willReadFrequently: true });
      const shoot = async () => {
        for (let i = 0; i < 3; i++) {
          engine.render({ delta: 1 / 60 });
          await device.queue.onSubmittedWorkDone();
        }
        canvas.setAttribute('width', W);
        engine.render({ delta: 1 / 60 });
        capture.drawImage(canvas, 0, 0);
        return capture.getImageData(0, 0, W, H).data;
      };
      const plain = await shoot();
      const water = Water.attach(engine, {
        size: [512, 512],
        segments: 64,
        height: -5,
        color: [0.05, 0.1, 0.9],
        waves: [{ direction: [1, 0], amplitude: 0, wavelength: 20 }],
        lights: [],
        terrain: { heightmap: () => coarse, origin: [-256, -256], size: [512, 512] },
        fill: (x) => (Math.abs(x - CX) < 12 ? LEVEL : undefined),
        still: true,
      });
      const without = await shoot();
      const banks = WaterBanks.attach(engine, {
        surface: water,
        heightmap: () => fine,
        origin: [-256, -256],
        size: [512, 512],
        cell: 2,
        resolution: 16,
      });
      const withBanks = await shoot();
      banks.dispose();
      const restored = await shoot();
      const error = await device.popErrorScope();
      // Screen x and y to world x and z on the ground, 300 m below a 60 degree pinhole.
      const f = H / 2 / Math.tan(Math.PI / 6),
        world = (p) => ((p + 0.5 - W / 2) * (300 - LEVEL)) / f,
        isWater = (d, o) => Math.abs(d[o] - plain[o]) + Math.abs(d[o + 1] - plain[o + 1]) + Math.abs(d[o + 2] - plain[o + 2]) > 24;
      const column = Math.round((CX * f) / (300 - LEVEL) + W / 2 - 0.5);
      const count = (d) => {
        let centre = 0,
          rows = 0,
          outside = 0,
          total = 0;
        for (let y = 0; y < H; y++) {
          const z = world(y);
          if (Math.abs(z) > 240) continue;
          rows++;
          if (isWater(d, (y * W + column) * 4)) centre++;
          for (let x = 0; x < W; x++)
            if (isWater(d, (y * W + x) * 4)) {
              total++;
              // A pixel is 1.5 m across here: past the wall by more than one pixel is outside.
              if (Math.abs(world(x) - CX) > WALL + 1.6) outside++;
            }
        }
        return { centre, rows, outside, total };
      };
      const out = {
        without: count(without),
        withBanks: count(withBanks),
        restored: count(restored),
        error: error?.message ?? null,
      };
      water.dispose();
      terrain.dispose();
      engine.dispose();
      return out;
    });
    console.log(JSON.stringify({ mode, without: r.without, withBanks: r.withBanks, restored: r.restored }));
    assert.equal(r.error, null);
    // Without banks the coarse rings hide the channel far off: water in well under nine tenths of its rows.
    assert.ok(r.without.centre < r.without.rows * 0.9, `without banks the channel showed in ${r.without.centre} of ${r.without.rows} rows`);
    // With banks the channel shows in every row and nowhere past its walls.
    assert.ok(r.withBanks.centre >= r.withBanks.rows - 2, `banks: water in ${r.withBanks.centre} of ${r.withBanks.rows} rows`);
    assert.equal(r.withBanks.outside, 0, `banks: ${r.withBanks.outside} water pixels past the walls`);
    // Disposing gives the plain water back.
    assert.equal(r.restored.centre, r.without.centre);
    assert.equal(r.restored.total, r.without.total);
  },
  () => browser.close(),
);
watchExit();
