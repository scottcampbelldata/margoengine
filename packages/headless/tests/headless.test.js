import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { createHeadlessCanvas, installGPU, readPixels, toPNG } from '../dist/index.js';

const NAMES = ['GPUBufferUsage', 'GPUTextureUsage', 'GPUMapMode', 'GPUShaderStage', 'GPUColorWrite'];

/** A device that records calls and maps `fill(x, y)` into a padded buffer, as a real copy would. */
function fakeDevice(fill) {
  const log = [];
  let copy;
  return {
    log,
    createTexture(d) {
      log.push(['createTexture', d.size, d.format, d.usage]);
      const [width, height] = d.size;
      return { width, height, format: d.format, destroy: () => log.push(['destroyTexture', width, height]) };
    },
    createBuffer(d) {
      return {
        mapAsync: async () => log.push(['mapAsync']),
        getMappedRange: () => {
          const bytes = new Uint8Array(d.size);
          for (let y = 0; y < copy.height; y++)
            for (let x = 0; x < copy.width; x++) bytes.set(fill(x, y), y * copy.bytesPerRow + x * 4);
          return bytes.buffer;
        },
        destroy: () => log.push(['destroyBuffer']),
      };
    },
    createCommandEncoder: () => ({
      copyTextureToBuffer(_source, destination, [width, height]) {
        copy = { width, height, bytesPerRow: destination.bytesPerRow };
        log.push(['copy', destination.bytesPerRow, destination.rowsPerImage, width, height]);
      },
      finish: () => 'commands',
    }),
    queue: { submit: () => log.push(['submit']) },
  };
}

const engineOn = (canvas, device, configuration = {}) => {
  canvas.getContext('webgpu').configure({ device, format: 'rgba8unorm', ...configuration });
  return { canvas, gpu: device };
};
const framed = (device, width, height, configuration) => {
  const canvas = createHeadlessCanvas({ width, height }),
    engine = engineOn(canvas, device, configuration);
  canvas.getContext('webgpu').getCurrentTexture();
  return engine;
};

test('importing sets nothing, and installGPU adds what is missing and restores it', () => {
  for (const name of NAMES) assert.equal(name in globalThis, false, name);
  assert.equal(navigator.gpu, undefined);
  const gpu = { requestAdapter: async () => null, wgslLanguageFeatures: 'features' },
    installed = installGPU({ gpu, globals: { GPUTestOnly: 7, GPUMapMode: { READ: 99 } } });
  assert.equal(navigator.gpu, installed.gpu);
  assert.equal(navigator.gpu.getPreferredCanvasFormat(), 'rgba8unorm');
  assert.equal(navigator.gpu.wgslLanguageFeatures, 'features');
  assert.equal(gpu.getPreferredCanvasFormat, undefined, "the caller's object is not changed");
  assert.equal(GPUBufferUsage.QUERY_RESOLVE, 512);
  assert.equal(GPUTextureUsage.RENDER_ATTACHMENT, 16);
  assert.equal(GPUShaderStage.COMPUTE, 4);
  assert.equal(GPUColorWrite.ALL, 15);
  assert.equal(GPUMapMode.READ, 99, "the binding's own value wins over the table");
  assert.equal(globalThis.GPUTestOnly, 7);
  installed.dispose();
  installed.dispose();
  for (const name of [...NAMES, 'GPUTestOnly']) assert.equal(name in globalThis, false, name);
  assert.equal(navigator.gpu, undefined);
});

test('installGPU keeps a global already there and a format the binding has, and disposes by symbol', () => {
  globalThis.GPUMapMode = 'mine';
  const gpu = { requestAdapter: async () => null, getPreferredCanvasFormat: () => 'bgra8unorm' };
  try {
    const installed = installGPU({ gpu });
    assert.equal(installed.gpu, gpu, 'nothing to add, so no wrapper');
    assert.equal(globalThis.GPUMapMode, 'mine');
    installed[Symbol.dispose]();
    assert.equal(globalThis.GPUMapMode, 'mine', 'not removed: it was not ours');
    assert.equal(navigator.gpu, undefined);
  } finally {
    delete globalThis.GPUMapMode;
  }
  assert.throws(() => installGPU({ gpu: {} }), TypeError);
  assert.throws(() => installGPU({}), TypeError);
});

test('the canvas keeps its size for core and rejects sizes that are not whole', () => {
  const canvas = createHeadlessCanvas({ width: 64, height: 32 });
  assert.deepEqual([canvas.width, canvas.height, canvas.clientWidth, canvas.clientHeight], [64, 32, 0, 0]);
  assert.equal(canvas.getContext('webgl2'), null);
  assert.equal(canvas.getContext('webgpu'), canvas.getContext('webgpu'));
  for (const bad of [0, -1, 1.5, NaN, undefined])
    assert.throws(() => createHeadlessCanvas({ width: bad, height: 8 }), RangeError);
});

test('one texture per size, remade on resize and destroyed on unconfigure', () => {
  const device = fakeDevice(() => [0, 0, 0, 0]),
    canvas = createHeadlessCanvas({ width: 4, height: 2 }),
    context = canvas.getContext('webgpu');
  assert.throws(() => context.getCurrentTexture(), { code: 'state' });
  context.configure({ device, format: 'bgra8unorm', usage: 4 });
  assert.equal(context.getConfiguration().format, 'bgra8unorm');
  const first = context.getCurrentTexture();
  assert.equal(context.getCurrentTexture(), first);
  assert.equal(device.log[0][3], 16 | 1 | 4, 'render, copy source and the configured usage');
  canvas.width = 8;
  const second = context.getCurrentTexture();
  assert.notEqual(second, first);
  assert.equal(second.width, 8);
  context.unconfigure();
  assert.deepEqual(
    device.log.map((e) => e.slice(0, 3)),
    [
      ['createTexture', [4, 2], 'bgra8unorm'],
      ['destroyTexture', 4, 2],
      ['createTexture', [8, 2], 'bgra8unorm'],
      ['destroyTexture', 8, 2],
    ],
  );
  assert.equal(context.getConfiguration(), null);
});

test('readPixels removes the 256-byte row padding and keeps rows in order', async () => {
  const device = fakeDevice((x, y) => [x, y, 9, 0]),
    { width, height, data } = await readPixels(framed(device, 3, 2));
  assert.deepEqual([width, height], [3, 2]);
  assert.deepEqual([...data], [0, 0, 9, 255, 1, 0, 9, 255, 2, 0, 9, 255, 0, 1, 9, 255, 1, 1, 9, 255, 2, 1, 9, 255]);
  assert.ok(
    device.log.some((e) => e[0] === 'copy' && e[1] === 256 && e[2] === 2),
    'bytesPerRow aligned',
  );
  assert.equal(device.log.at(-1)[0], 'destroyBuffer');
});

test('a row of exactly 256 bytes gets no extra padding', async () => {
  const device = fakeDevice(() => [1, 2, 3, 4]);
  await readPixels(framed(device, 64, 1));
  assert.ok(device.log.some((e) => e[0] === 'copy' && e[1] === 256));
});

test('bgra swaps to rgba, opaque reads alpha 255, premultiplied reads straight alpha', async () => {
  const read = async (configuration) => [
    ...(
      await readPixels(
        framed(
          fakeDevice(() => [10, 20, 40, 128]),
          1,
          1,
          configuration,
        ),
      )
    ).data,
  ];
  assert.deepEqual(await read({ format: 'bgra8unorm' }), [40, 20, 10, 255]);
  assert.deepEqual(await read({}), [10, 20, 40, 255]);
  assert.deepEqual(await read({ alphaMode: 'premultiplied' }), [20, 40, 80, 128]);
});

test('readPixels says what is wrong when it cannot read', async () => {
  const device = fakeDevice(() => [0, 0, 0, 0]),
    canvas = createHeadlessCanvas({ width: 1, height: 1 });
  await assert.rejects(readPixels({ canvas: { getContext: () => ({}) }, gpu: device }), { code: 'unsupported' });
  await assert.rejects(readPixels({ canvas, gpu: null }), { code: 'unsupported' });
  await assert.rejects(readPixels(engineOn(canvas, device)), { code: 'state' }, 'no frame yet');
  await assert.rejects(readPixels(framed(device, 1, 1, { format: 'rgba16float' })), { code: 'unsupported' });
});

test('an aborted read rejects with the reason and frees the buffer', async () => {
  const device = fakeDevice(() => [0, 0, 0, 0]),
    engine = framed(device, 1, 1),
    reason = new Error('stop');
  await assert.rejects(readPixels(engine, { signal: AbortSignal.abort(reason) }), reason);
  const controller = new AbortController(),
    createBuffer = device.createBuffer;
  device.createBuffer = (d) => ({
    ...createBuffer(d),
    mapAsync: () =>
      new Promise((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(new Error('map aborted')));
        queueMicrotask(() => controller.abort(reason));
      }),
  });
  await assert.rejects(readPixels(engine, { signal: controller.signal }), reason);
  assert.equal(device.log.at(-1)[0], 'destroyBuffer');
});

test('toPNG writes a PNG whose rows inflate back to the pixels', async () => {
  const png = await toPNG(
      framed(
        fakeDevice((x, y) => [x * 40, y * 40, 200, 0]),
        3,
        2,
      ),
    ),
    view = new DataView(png.buffer);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.deepEqual([view.getUint32(16), view.getUint32(20), png[24], png[25]], [3, 2, 8, 6]);
  const length = view.getUint32(33),
    rows = inflateSync(png.subarray(41, 41 + length));
  assert.equal(rows.length, (3 * 4 + 1) * 2);
  assert.deepEqual([...rows.subarray(0, 5)], [2, 0, 0, 200, 255], 'first row against zero');
  assert.deepEqual([...rows.subarray(13, 18)], [2, 0, 40, 0, 0], 'second row against the first');
});
