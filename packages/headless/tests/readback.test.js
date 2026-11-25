// GAP-FILM-READBACK: a film reads every frame, so readback must reuse its buffers and must not wait for the frame just
// drawn. Proven by work counts on a recording device (buffers made, copies, maps, which map a read waits for), and the
// pixels are held to the byte loop readPixels used before, kept here as the oracle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHeadlessCanvas, readPixels } from '../dist/index.js';
import { createFrameReader } from '../dist/frames.js';

/** A device whose copies snapshot the frame in `source` at submit time. With `manual`, a map resolves on `resolve(i)`. */
function device({ manual = false } = {}) {
  const made = { buffers: 0, bytes: 0, destroyed: 0, copies: 0, maps: 0 },
    waiting = [];
  const gpu = {
    made,
    source: () => new Uint8Array(0),
    resolve: (i) => waiting[i].resolve(),
    createTexture: ({ size: [width, height], format }) => ({ width, height, format, destroy() {} }),
    createBuffer({ size }) {
      made.buffers++;
      made.bytes += size;
      const buffer = {
        size,
        state: 'unmapped',
        destroyed: false,
        contents: new Uint8Array(size),
        mapAsync() {
          assert.equal(buffer.state, 'unmapped', 'a mapped or pending buffer is not mapped again');
          buffer.state = 'pending';
          made.maps++;
          const done = new Promise((resolve, reject) => {
            const entry = {
              resolve: () => {
                buffer.state = 'mapped';
                resolve();
              },
              reject,
              buffer,
            };
            waiting.push(entry);
            if (!manual) entry.resolve();
          });
          return done;
        },
        getMappedRange() {
          assert.equal(buffer.state, 'mapped');
          return buffer.contents.slice().buffer;
        },
        unmap() {
          buffer.state = 'unmapped';
        },
        destroy() {
          if (buffer.destroyed) return;
          buffer.destroyed = true;
          made.destroyed++;
          for (const entry of waiting) if (entry.buffer === buffer) entry.reject(new Error('buffer destroyed'));
        },
      };
      return buffer;
    },
    createCommandEncoder() {
      const copies = [];
      return {
        copyTextureToBuffer: (_from, to, [width, height]) => copies.push({ ...to, width, height }),
        finish: () => copies,
      };
    },
    queue: {
      submit([copies]) {
        for (const { buffer, bytesPerRow, width, height } of copies) {
          assert.equal(buffer.state, 'unmapped', 'a copy goes to an unmapped buffer');
          assert.equal(buffer.destroyed, false);
          made.copies++;
          const source = gpu.source();
          for (let y = 0; y < height; y++)
            buffer.contents.set(source.subarray(y * width * 4, (y + 1) * width * 4), y * bytesPerRow);
        }
      },
    },
  };
  return gpu;
}

function engineOf(gpu, width, height, configuration = {}) {
  const canvas = createHeadlessCanvas({ width, height }),
    context = canvas.getContext('webgpu');
  context.configure({ device: gpu, format: 'rgba8unorm', ...configuration });
  context.getCurrentTexture();
  return { canvas, gpu };
}

/** The readPixels pixel loop before 2026-11-24. */
function oracle(data, swap, premultiplied) {
  for (let i = 0; i < data.length; i += 4) {
    if (swap) {
      const blue = data[i];
      data[i] = data[i + 2];
      data[i + 2] = blue;
    }
    if (!premultiplied) data[i + 3] = 255;
    else if (data[i + 3] > 0 && data[i + 3] < 255) {
      const scale = 255 / data[i + 3];
      for (let c = 0; c < 3; c++) data[i + c] = Math.min(255, Math.round(data[i + c] * scale));
    }
  }
  return data;
}

test('every format and alpha mode gives the bytes of the old pixel loop', async () => {
  // Every alpha against every channel value, then pseudo-random pixels; 67 wide, so rows are padded.
  const width = 67,
    height = 1100,
    pixels = new Uint8Array(width * height * 4);
  let seed = 1;
  for (let i = 0; i < pixels.length; i++) pixels[i] = (seed = (Math.imul(seed, 48271) >>> 0) % 2147483647) >>> 8;
  for (let a = 0, i = 0; a < 256; a++)
    for (let c = 0; c < 256; c++, i += 4) pixels.set([c, 255 - c, (c * 7) & 255, a], i);
  for (const format of ['rgba8unorm', 'bgra8unorm'])
    for (const alphaMode of ['opaque', 'premultiplied']) {
      const gpu = device();
      gpu.source = () => pixels;
      const engine = engineOf(gpu, width, height, { format, alphaMode }),
        { data } = await readPixels(engine),
        expected = oracle(pixels.slice(), format === 'bgra8unorm', alphaMode === 'premultiplied');
      assert.equal(Buffer.compare(data, expected), 0, `${format} ${alphaMode}`);
    }
});

test('readPixels makes one buffer for any number of reads of one size', async () => {
  const gpu = device();
  gpu.source = () => new Uint8Array(8 * 4 * 4);
  const engine = engineOf(gpu, 8, 4);
  for (let i = 0; i < 20; i++) await readPixels(engine);
  assert.deepEqual(gpu.made, { buffers: 1, bytes: 1024, destroyed: 0, copies: 20, maps: 20 });
  engine.canvas.getContext('webgpu').unconfigure();
  assert.equal(gpu.made.destroyed, 1, 'the kept buffer goes with the canvas');
});

test('a resize and a second read at once leave one buffer, of the new size', async () => {
  const gpu = device();
  gpu.source = () => new Uint8Array(16 * 4 * 4);
  const engine = engineOf(gpu, 8, 4);
  await Promise.all([readPixels(engine), readPixels(engine)]);
  assert.deepEqual([gpu.made.buffers, gpu.made.destroyed], [2, 1]);
  engine.canvas.width = 16;
  engine.canvas.getContext('webgpu').getCurrentTexture();
  assert.equal(gpu.made.destroyed, 2, 'the old size is freed at once');
  await readPixels(engine);
  await readPixels(engine);
  assert.deepEqual([gpu.made.buffers, gpu.made.destroyed], [3, 2]);
});

test('a read that outlives a resize does not leave its buffer on the canvas', async () => {
  const gpu = device({ manual: true });
  gpu.source = () => new Uint8Array(8 * 4 * 4);
  const engine = engineOf(gpu, 8, 4),
    reading = readPixels(engine);
  engine.canvas.getContext('webgpu').unconfigure();
  gpu.resolve(0);
  await reading;
  assert.deepEqual([gpu.made.buffers, gpu.made.destroyed], [1, 1]);
});

/** A 2 by 1 engine whose frame `n` is filled with the value `n`. */
function film(gpu) {
  let frame = 0;
  gpu.source = () => new Uint8Array(8).fill(frame);
  const engine = engineOf(gpu, 2, 1);
  return {
    engine,
    draw: (n) => (frame = n),
  };
}

test('a frame reader hands out every frame in order from depth buffers', async () => {
  for (const depth of [1, 2, 3, 5]) {
    const gpu = device(),
      { engine, draw } = film(gpu),
      reader = createFrameReader(engine, { depth }),
      seen = [];
    for (let n = 0; n < 12; n++) {
      draw(n);
      const pixels = await reader.push();
      assert.equal(pixels === undefined, n < depth - 1, `depth ${depth} push ${n}`);
      if (pixels) seen.push(pixels.data[0]);
    }
    assert.equal(reader.pending, depth - 1);
    for await (const pixels of reader.drain()) seen.push(pixels.data[0]);
    assert.deepEqual(seen, [...Array(12).keys()]);
    assert.equal(reader.pending, 0);
    assert.deepEqual(gpu.made, { buffers: depth, bytes: depth * 256, destroyed: 0, copies: 12, maps: 12 });
    reader.dispose();
    reader.dispose();
    assert.equal(gpu.made.destroyed, depth);
    await assert.rejects(reader.push(), { code: 'state' });
  }
});

test('a push waits for the oldest copy only, never for the frame just drawn', async () => {
  const gpu = device({ manual: true }),
    { engine, draw } = film(gpu),
    reader = createFrameReader(engine, { depth: 3 });
  draw(0);
  assert.equal(await reader.push(), undefined);
  draw(1);
  assert.equal(await reader.push(), undefined);
  draw(2);
  const third = reader.push();
  gpu.resolve(0);
  // Maps 1 and 2 are still pending: the CPU is free to draw the next frame.
  assert.equal((await third).data[0], 0);
  assert.equal(reader.pending, 2);
  reader.dispose();
});

test('pushes that are not awaited still keep each frame and its order', async () => {
  const gpu = device(),
    { engine, draw } = film(gpu),
    reader = createFrameReader(engine, { depth: 2 }),
    reads = [0, 1, 2, 3].map((n) => {
      draw(n);
      return reader.push();
    });
  assert.deepEqual(
    (await Promise.all(reads)).map((pixels) => pixels?.data[0]),
    [undefined, 0, 1, 2],
  );
  reader.dispose();
});

test('a resize mid-film keeps held frames at their size and drops buffers that no longer fit', async () => {
  const gpu = device(),
    engine = engineOf(gpu, 2, 1),
    reader = createFrameReader(engine, { depth: 2 }),
    widths = [];
  for (const width of [2, 2, 100, 100, 100]) {
    gpu.source = () => new Uint8Array(width * 4);
    engine.canvas.width = width;
    engine.canvas.getContext('webgpu').getCurrentTexture();
    const pixels = await reader.push();
    if (pixels) widths.push(pixels.width);
  }
  for await (const pixels of reader.drain()) widths.push(pixels.width);
  assert.deepEqual(widths, [2, 2, 100, 100, 100]);
  reader.dispose();
  assert.equal(gpu.made.destroyed, gpu.made.buffers, 'nothing is left');
});

test('abort and dispose reject waiting reads and free every buffer', async () => {
  const gpu = device({ manual: true }),
    { engine } = film(gpu),
    controller = new AbortController(),
    reader = createFrameReader(engine, { depth: 2, signal: controller.signal }),
    reason = new Error('stop');
  await reader.push();
  const waiting = reader.push();
  controller.abort(reason);
  await assert.rejects(waiting, reason);
  await assert.rejects(reader.push(), reason);
  assert.equal(reader.pending, 0);
  assert.equal(gpu.made.destroyed, gpu.made.buffers);
  assert.throws(() => createFrameReader(engine, { signal: controller.signal }), reason);

  const second = createFrameReader(engine, { depth: 1 }),
    read = second.push();
  second[Symbol.dispose]();
  await assert.rejects(read, { code: 'state' });
  assert.equal(gpu.made.destroyed, gpu.made.buffers);
});

test('a failed map rejects with the device error and frees that buffer', async () => {
  const gpu = device(),
    { engine } = film(gpu),
    lost = new Error('device lost'),
    createBuffer = gpu.createBuffer;
  gpu.createBuffer = (d) => Object.assign(createBuffer(d), { mapAsync: () => Promise.reject(lost) });
  const reader = createFrameReader(engine, { depth: 1 });
  await assert.rejects(reader.push(), lost);
  assert.equal(gpu.made.destroyed, 1);
  reader.dispose();
});

test('a frame reader refuses a bad depth and an engine it cannot read', async () => {
  const gpu = device(),
    { engine } = film(gpu);
  for (const depth of [0, 17, 1.5, NaN]) assert.throws(() => createFrameReader(engine, { depth }), RangeError);
  assert.equal(createFrameReader(engine).depth, 3);
  const bare = { canvas: createHeadlessCanvas({ width: 1, height: 1 }), gpu };
  await assert.rejects(createFrameReader(bare).push(), { code: 'state' });
});
