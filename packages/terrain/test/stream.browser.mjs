// Real-GPU check (run from the repository root after building packages, in a shared GPU slot):
//   node packages/terrain/test/stream.browser.mjs
// `@margoengine/terrain/stream` on real elevation: nine adjacent Terrarium tiles around Mount Rainier (zoom 10, x 164 to
// 166, y 359 to 361, from the Terrain Tiles on AWS open data set; USGS 3DEP, GMTED2010 and SRTM data), 256 x 256 each,
// with painted weights made from their heights. A 2 x 2 tile window follows the camera through moves along +X, +Z, -X
// and -Z, a move that stays inside the 0.75 tile margin, and teleports out of the data and back. At every stop, once
// `ready` resolves:
// 1. the window is the expected tiles, and the CPU copy and the GPU heightmap (read back) hold exactly the mosaic's
//    texels for them, weights included;
// 2. the streamed terrain draws exactly the pixels of a plain Terrain given that window's heights and weights whole;
// 3. no frame uploads more texels than the budget.
// Then a stream disposed with a load in flight aborts the load and rejects `ready` with MargoError 'disposed'.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
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
        { TerrainStream } = await import('/packages/terrain/dist/stream.js'),
        T = 256,
        W = 2,
        N = W * T,
        tileSize = 25600,
        budget = 16384,
        tiles = new Map();
      // Terrarium encoding: metres = R * 256 + G + B / 256 - 32768. Image rows run south, along +Z here.
      for (let i = 0; i < 3; i++)
        for (let j = 0; j < 3; j++) {
          const bitmap = await createImageBitmap(
              await (await fetch(`/packages/terrain/test/fixtures/terrarium-10/${164 + i}-${359 + j}.png`)).blob(),
              { colorSpaceConversion: 'none', premultiplyAlpha: 'none' },
            ),
            draw = new OffscreenCanvas(T, T).getContext('2d');
          draw.drawImage(bitmap, 0, 0);
          const rgba = draw.getImageData(0, 0, T, T).data,
            heights = new Float32Array(T * T),
            weights = new Uint8Array(T * T * 4);
          for (let k = 0; k < heights.length; k++) {
            const h = (heights[k] = rgba[k * 4] * 256 + rgba[k * 4 + 1] + rgba[k * 4 + 2] / 256 - 32768);
            const band = (c) => Math.round(255 * Math.max(0, 1 - Math.abs(h - c) / 1500));
            weights.set([band(0), band(1500), band(3000), band(4500)], k * 4);
          }
          tiles.set(`${i},${j}`, { heights, weights: [weights] });
        }
      // The window the stream should hold for minimum tile (x, z): the mosaic, empty tiles at fill 0 and no weight.
      const expected = (x, z) => {
        const heights = new Float32Array(N * N),
          weights = new Uint8Array(N * N * 4);
        for (let j = 0; j < W; j++)
          for (let i = 0; i < W; i++) {
            const tile = tiles.get(`${x + i},${z + j}`);
            if (!tile) continue;
            for (let r = 0; r < T; r++) {
              heights.set(tile.heights.subarray(r * T, (r + 1) * T), (j * T + r) * N + i * T);
              weights.set(tile.weights[0].subarray(r * T * 4, (r + 1) * T * 4), ((j * T + r) * N + i * T) * 4);
            }
          }
        return { heights, weights };
      };
      const layers = [0, 1, 2, 3].map(() => ({ height: [-1e5, 1e5], slope: [0, 1], scale: 0.002 })),
        colors = (device) => {
          const texture = device.createTexture({ size: [1, 1, 4], format: 'rgba8unorm-srgb', usage: 6 });
          device.queue.writeTexture(
            { texture },
            new Uint8Array([60, 120, 50, 255, 140, 120, 90, 255, 120, 110, 105, 255, 235, 240, 245, 255]),
            { bytesPerRow: 4, rowsPerImage: 1 },
            [1, 1, 4],
          );
          return texture;
        },
        common = { layers, heightScale: 1, cellSize: 100, resolution: 64, levels: 6 },
        size = 96,
        make = async () => {
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = size;
          document.body.append(canvas);
          const engine = await Engine.create(canvas, {
            backend: 'webgpu',
            camera: { position: [25600, 7000, 25600], target: [25600, 1500, 37000], near: 10, far: 120000 },
          });
          engine.gpu.pushErrorScope('validation');
          return { canvas, engine };
        },
        pixels = (canvas) => {
          const c = new OffscreenCanvas(size, size).getContext('2d');
          c.drawImage(canvas, 0, 0);
          return c.getImageData(0, 0, size, size).data;
        },
        look = (engine, x, z) => {
          engine.camera.position = [x * tileSize, 7000, z * tileSize];
          engine.camera.target = [x * tileSize + 3000, 1500, z * tileSize + 11000];
        };
      const streamed = await make(),
        reference = await make(),
        signals = [];
      let uploaded = 0,
        worstFrame = 0,
        loads = 0;
      const stream = TerrainStream.attach(streamed.engine, {
        ...common,
        tileSize,
        tileTexels: T,
        window: W,
        weights: 1,
        budget,
        colors,
        async load(x, z, signal) {
          loads++;
          signals.push(signal);
          // Arrivals out of order: a few milliseconds that vary by tile.
          await new Promise((r) => setTimeout(r, ((x * 7 + z * 3) & 7) + 1));
          if (signal.aborted) throw signal.reason;
          return tiles.get(`${x},${z}`) ?? null;
        },
      });
      stream.onChange((change) => {
        if (!change.shifted) uploaded += change.width * change.depth;
      });
      // Camera stops in tile units, with the window's expected minimum tile after each.
      const stops = [
        [1.0, 1.0, 0, 0],
        [1.7, 1.0, 0, 0], // 0.7 of a tile from the centre: inside the margin, no move
        [1.8, 1.0, 1, 0], // +X
        [1.8, 1.8, 1, 1], // +Z
        [1.0, 1.8, 0, 1], // -X
        [1.0, 1.0, 0, 0], // -Z
        [5.0, 5.0, 4, 4], // teleport past the data: every tile empty
        [2.0, 2.0, 1, 1], // and back, diagonally
      ];
      const out = [];
      for (const [x, z, tx, tz] of stops) {
        look(streamed.engine, x, z);
        let ok = false,
          failure = null,
          frames = 0;
        // The first frame moves the window; `ready` asked after it waits for the moved window's tiles.
        uploaded = 0;
        streamed.engine.render({ delta: 1 / 60 });
        worstFrame = Math.max(worstFrame, uploaded);
        stream.ready().then(
          () => (ok = true),
          (e) => (failure = String(e)),
        );
        while (!ok && !failure && frames < 3000) {
          await new Promise((r) => setTimeout(r, 1));
          uploaded = 0;
          streamed.engine.render({ delta: 1 / 60 });
          worstFrame = Math.max(worstFrame, uploaded);
          frames++;
        }
        const want = expected(tx, tz),
          device = streamed.engine.gpu,
          buffer = device.createBuffer({ size: N * N * 4, usage: 9 }),
          encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture: stream.terrain.heightmap }, { buffer, bytesPerRow: N * 4 }, [N, N]);
        device.queue.submit([encoder.finish()]);
        await buffer.mapAsync(1);
        const gpu = new Float32Array(buffer.getMappedRange().slice(0));
        buffer.destroy();
        let cpuWorst = 0,
          gpuWorst = 0,
          weightWorst = 0;
        for (let k = 0; k < N * N; k++) {
          cpuWorst = Math.max(cpuWorst, Math.abs(stream.heights[k] - want.heights[k]));
          gpuWorst = Math.max(gpuWorst, Math.abs(gpu[k] - want.heights[k]));
        }
        for (let k = 0; k < want.weights.length; k++)
          weightWorst = Math.max(weightWorst, Math.abs(stream.weights[0][k] - want.weights[k]));
        // The same window drawn by a plain terrain from the whole arrays.
        look(reference.engine, x, z);
        const plain = Terrain.attach(reference.engine, {
          ...common,
          origin: [...stream.origin],
          size: [(N - 1) * (tileSize / T), (N - 1) * (tileSize / T)],
          textures(gpu) {
            const heightmap = gpu.createTexture({ size: [N, N], format: 'r32float', usage: 6 }),
              weight = gpu.createTexture({ size: [N, N], format: 'rgba8unorm', usage: 6 });
            gpu.queue.writeTexture({ texture: heightmap }, want.heights, { bytesPerRow: N * 4 }, [N, N]);
            gpu.queue.writeTexture({ texture: weight }, want.weights, { bytesPerRow: N * 4 }, [N, N]);
            return { heightmap, layers: colors(gpu), weights: [weight, weight] };
          },
        });
        streamed.engine.render({ delta: 1 / 60 });
        reference.engine.render({ delta: 1 / 60 });
        await Promise.all([
          streamed.engine.gpu.queue.onSubmittedWorkDone(),
          reference.engine.gpu.queue.onSubmittedWorkDone(),
        ]);
        streamed.engine.render({ delta: 1 / 60 });
        reference.engine.render({ delta: 1 / 60 });
        const a = pixels(streamed.canvas),
          b = pixels(reference.canvas);
        let pictureWorst = 0,
          ground = 0;
        for (let k = 0; k < a.length; k++) pictureWorst = Math.max(pictureWorst, Math.abs(a[k] - b[k]));
        // Ground pixels differ from the sky's: count those that are not the top-left pixel's colour.
        for (let k = 0; k < a.length; k += 4) if (a[k] !== a[0] || a[k + 1] !== a[1] || a[k + 2] !== a[2]) ground++;
        plain.dispose();
        out.push({
          stop: [x, z],
          tile: [...stream.tile],
          want: [tx, tz],
          ok,
          failure,
          frames,
          cpuWorst,
          gpuWorst,
          weightWorst,
          pictureWorst,
          ground,
          resident: [0, 1].flatMap((j) => [0, 1].map((i) => stream.resident(tx + i, tz + j))),
        });
      }
      // A stream disposed while a load is in flight: the load's signal aborts and `ready` rejects 'disposed'.
      let held,
        rejection = null;
      const pending = TerrainStream.attach(reference.engine, {
        ...common,
        tileSize,
        tileTexels: 4,
        window: 2,
        colors,
        load: (x, z, signal) =>
          new Promise((resolve, reject) => {
            held = signal;
            signal.addEventListener('abort', () => reject(signal.reason));
          }),
      });
      reference.engine.render({ delta: 1 / 60 });
      const waiting = pending.ready().catch((e) => (rejection = e.code ?? String(e)));
      pending.dispose();
      await waiting;
      const disposed = { aborted: held?.aborted ?? false, rejection, terrain: pending.terrain.disposed };
      const errors = [await streamed.engine.gpu.popErrorScope(), await reference.engine.gpu.popErrorScope()]
        .filter(Boolean)
        .map((e) => e.message);
      const abortedOnMoves = signals.filter((s) => s.aborted).length;
      stream.dispose();
      streamed.engine.dispose();
      reference.engine.dispose();
      return { out, worstFrame, budget, loads, abortedOnMoves, disposed, errors };
    });
    assert.deepEqual(result.errors, []);
    for (const stop of result.out) {
      const at = `camera at ${stop.stop} tiles`;
      assert.equal(stop.failure, null, at);
      assert.ok(stop.ok, `${at}: ready resolved`);
      assert.deepEqual(stop.tile, stop.want, `${at}: window`);
      assert.deepEqual(stop.resident, [true, true, true, true], `${at}: resident`);
      assert.equal(stop.cpuWorst, 0, `${at}: CPU heights`);
      assert.equal(stop.gpuWorst, 0, `${at}: GPU heightmap`);
      assert.equal(stop.weightWorst, 0, `${at}: weights`);
      assert.equal(stop.pictureWorst, 0, `${at}: streamed picture equals the whole terrain's`);
    }
    // Real relief in view at the stops over the data (the teleport stop is flat empty ground).
    assert.ok(result.out[0].ground > 1000, `ground drawn: ${result.out[0].ground} pixels`);
    assert.ok(result.worstFrame <= result.budget, `frame uploads within the budget: ${result.worstFrame}`);
    assert.deepEqual(result.disposed, { aborted: true, rejection: 'disposed', terrain: true });
    await writeFile('test-results/terrain-stream.json', JSON.stringify({ hardware, result }, null, 1));
    console.log(
      'ok terrain stream:',
      result.out.map((s) => `${s.stop}->${s.tile} in ${s.frames} frames`).join(', '),
      '; loads',
      result.loads,
      '; most texels in a frame',
      result.worstFrame,
    );
  },
  () => context.close(),
);
watchExit();
