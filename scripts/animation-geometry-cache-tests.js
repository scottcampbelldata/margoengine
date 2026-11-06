// Real-GPU check of GeometryCachePlayer (packages/animation/src/geometry-cache.ts). A cache streams in small pieces
// through a browser ReadableStream: a grid that waves, then a chunk with more vertices. After each frame the mesh's
// vertices read back from the GPU must be the file's, interpolated, and the drawn pixels must move and grow with them.
// Runs as `npm run test:gpu:geometry-cache -w @margoengine/animation` (check:gpu-packages).
import assert from 'node:assert/strict';
import { openBrowser } from './browser.js';

const browser = await openBrowser({ startPath: '/tests/modern-extension.html', port: 5194 }),
  { page } = browser,
  errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error' || /Error while parsing|Invalid .*Pipeline|ValidationError/.test(message.text()))
    errors.push(message.text());
});
try {
  const result = await page.evaluate(async () => {
    const { Engine } = await import('/packages/core/dist/index.js'),
      { GeometryCachePlayer, encodeGeometryCache } = await import('/packages/animation/dist/geometry-cache.js');
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 128;
    canvas.style.cssText = 'width:128px;height:128px';
    document.body.append(canvas);
    const engine = await Engine.create(canvas, {
        backend: 'webgpu',
        capacity: 256,
        camera: { position: [0, 0, 6], target: [0, 0, 0], near: 0.01, far: 50 },
      }),
      device = engine.gpu;
    device.pushErrorScope('validation');

    const grid = (side, frames, first, extent) => {
      const n = side * side,
        positions = new Float32Array(frames * n * 3),
        indices = [];
      for (let f = 0; f < frames; f++)
        for (let y = 0; y < side; y++)
          for (let x = 0; x < side; x++) {
            const u = (x / (side - 1) - 0.5) * extent,
              v = (y / (side - 1) - 0.5) * extent;
            positions.set([u, v, Math.sin(u * 2 + (first + f) * 0.4) * 0.25], (f * n + y * side + x) * 3);
          }
      for (let y = 0; y + 1 < side; y++)
        for (let x = 0; x + 1 < side; x++) {
          const a = y * side + x;
          indices.push(a, a + 1, a + side, a + 1, a + side + 1, a + side);
        }
      return { frameCount: frames, positions, indices: new Uint32Array(indices) };
    };
    const chunks = [grid(16, 8, 0, 2), grid(16, 8, 8, 2), grid(40, 8, 16, 4)],
      file = encodeGeometryCache(10, chunks),
      stream = () =>
        new ReadableStream({
          start(controller) {
            for (let i = 0; i < file.length; i += 1000) controller.enqueue(file.slice(i, i + 1000));
            controller.close();
          },
        });
    const player = await GeometryCachePlayer.attach(engine, stream(), { loop: false, ahead: 8 });
    await player.done;
    const p = player.model.primitives[0];
    const read = async () => {
      const size = (p.vertices.length / 20) * 80,
        out = device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
        encoder = device.createCommandEncoder();
      encoder.copyBufferToBuffer(p.deformed, 0, out, 0, size);
      device.queue.submit([encoder.finish()]);
      await out.mapAsync(GPUMapMode.READ);
      const values = new Float32Array(out.getMappedRange()).slice();
      out.unmap();
      out.destroy();
      return values;
    };
    // In the task that rendered: the canvas's texture is gone once the frame is presented.
    const coverage = () => {
      engine.render({ culling: false, delta: 0 });
      const copy = document.createElement('canvas');
      copy.width = copy.height = 128;
      const context = copy.getContext('2d', { willReadFrequently: true });
      context.drawImage(canvas, 0, 0);
      const data = context.getImageData(0, 0, 128, 128).data,
        back = [data[0], data[1], data[2]];
      let count = 0;
      for (let i = 0; i < data.length; i += 4)
        if (Math.abs(data[i] - back[0]) + Math.abs(data[i + 1] - back[1]) + Math.abs(data[i + 2] - back[2]) > 12) count++;
      return count;
    };
    player.playing = false;
    let worst = 0,
      checks = 0;
    const pixels = {};
    for (const at of [0, 0.25, 0.55, 0.75, 0.79, 1.6, 1.95, 2.3]) {
      player.playing = true;
      player.seek(at);
      engine.render({ culling: false, delta: 0 });
      player.playing = false;
      // Expected: the frames either side from the file, mixed. Frame 15 to 16 changes mesh, so it holds.
      const frame = Math.floor(at * 10 + 1e-6),
        index = Math.floor(frame / 8),
        chunk = chunks[index],
        n = chunk.positions.length / 3 / 8,
        local = frame % 8,
        after = local < 7 ? chunk : chunks[index + 1]?.positions.length === chunk.positions.length ? chunks[index + 1] : null,
        to = local < 7 ? local + 1 : after ? 0 : local,
        other = after ?? chunk,
        values = await read();
      for (let v = 0; v < n; v++)
        for (let c = 0; c < 3; c++) {
          const a = chunk.positions[(local * n + v) * 3 + c],
            b = other.positions[(to * n + v) * 3 + c],
            expected = a + (b - a) * Math.fround(player.time * 10 - frame);
          worst = Math.max(worst, Math.abs(values[v * 20 + c] - expected));
          checks++;
        }
      pixels[at] = coverage();
    }
    const swaps = player.stats.swaps,
      indexCount = p.indices.length;
    player.dispose();
    const error = await device.popErrorScope();
    return { worst, checks, swaps, indexCount, pixels, validation: error?.message ?? null };
  });
  console.log(JSON.stringify(result));
  assert.deepEqual(errors, []);
  assert.equal(result.validation, null);
  assert.ok(result.checks > 10000, 'the frames were compared');
  assert.ok(result.worst < 1e-5, `GPU vertices differ from the file by ${result.worst}`);
  assert.equal(result.swaps, 1, 'one change of mesh');
  assert.equal(result.indexCount, 39 * 39 * 6, 'the new triangles are in place');
  assert.ok(result.pixels[0] > 300, `the first grid should cover pixels, covered ${result.pixels[0]}`);
  assert.ok(result.pixels[2.3] > result.pixels[0] * 2, `the larger grid should cover more: ${JSON.stringify(result.pixels)}`);
} finally {
  await browser.close();
}
