import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleOffset, supersample } from '../dist/ssaa.js';

globalThis.GPUTextureUsage ??= { RENDER_ATTACHMENT: 16, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, COPY_SRC: 1 };
globalThis.GPUBufferUsage ??= { MAP_READ: 1, COPY_DST: 8 };
globalThis.GPUMapMode ??= { READ: 1 };
if (!globalThis.navigator?.gpu)
  Object.defineProperty(globalThis.navigator, 'gpu', {
    configurable: true,
    value: { getPreferredCanvasFormat: () => 'bgra8unorm' },
  });

/** Enough of a device and engine to count what `supersample` asks of them. Each render runs the camera's update, as the engine does. */
function fake({ width = 3, height = 2, onRender } = {}) {
  const log = { dispatches: 0, destroyed: 0, textures: [], submits: 0, renders: [], matrices: [] },
    pass = {
      setPipeline() {},
      setBindGroup() {},
      dispatchWorkgroups: () => log.dispatches++,
      end() {},
    },
    device = {
      limits: { maxTextureDimension2D: 4096 },
      createTexture(descriptor) {
        log.textures.push(descriptor);
        return { ...descriptor, createView: () => ({}), destroy: () => log.destroyed++ };
      },
      createBuffer: ({ size }) => ({
        size,
        mapAsync: async () => {},
        getMappedRange: () => {
          const bytes = new Uint8Array(size);
          for (let i = 0; i < size; i++) bytes[i] = i % 251;
          return bytes.buffer;
        },
        destroy: () => log.destroyed++,
      }),
      createShaderModule: () => ({}),
      createComputePipeline: () => ({ getBindGroupLayout: () => ({}) }),
      createBindGroup: () => ({}),
      createCommandEncoder: () => ({
        beginComputePass: () => pass,
        copyTextureToBuffer() {},
        finish: () => ({}),
      }),
      queue: { submit: () => log.submits++, onSubmittedWorkDone: async () => {} },
    },
    camera = {
      matrix: new Float32Array(16),
      update() {
        this.matrix.fill(0);
        this.matrix[3] = 2; // w depends on x, so the offset is seen to scale with it
        this.matrix[15] = 1;
      },
    },
    engine = {
      gpu: device,
      canvas: { width, height },
      camera,
      render(options) {
        log.renders.push(options);
        camera.update(1, true);
        log.matrices.push(camera.matrix.slice());
        onRender?.(log.renders.length);
      },
    };
  return { engine, log, camera };
}

test('sampleOffset fills the pixel evenly and leaves a single frame in place', () => {
  assert.deepEqual(sampleOffset(0, 1), [0, 0]);
  const cells = new Set();
  let sumX = 0,
    sumY = 0;
  for (let i = 0; i < 64; i++) {
    const [x, y] = sampleOffset(i, 64);
    assert.ok(x >= -0.5 && x < 0.5 && y >= -0.5 && y < 0.5, `offset ${x}, ${y}`);
    cells.add(`${Math.floor((x + 0.5) * 4)},${Math.floor((y + 0.5) * 4)}`);
    sumX += x;
    sumY += y;
  }
  assert.equal(cells.size, 16, 'every quarter-pixel cell gets a sample');
  assert.ok(Math.abs(sumX / 64) < 0.02 && Math.abs(sumY / 64) < 0.02, 'the offsets centre on the pixel');
  assert.deepEqual(sampleOffset(5, 64), sampleOffset(5, 64));
});

test('one render and one accumulation per sample, then one ordinary frame', async () => {
  const { engine, log } = fake();
  await supersample(engine, { samples: 6 });
  assert.equal(log.renders.length, 7);
  for (const options of log.renders.slice(0, 6)) {
    assert.equal(options.views.length, 1);
    assert.equal(options.views[0].camera, engine.camera);
    assert.deepEqual(options.views[0].viewport, [0, 0, 1, 1]);
    assert.ok(options.views[0].target.color, 'draws into a texture, never the canvas');
    assert.equal(options.delta, undefined, 'time stands still');
  }
  assert.deepEqual(log.renders[6], {}, 'the last frame is the plain one, which picking and the camera need');
  assert.equal(log.dispatches, 7, 'six sums and the finish');
});

test('the offset is one pixel fraction of clip space in x and y, scaled by w', async () => {
  const { engine, log } = fake({ width: 100, height: 50 });
  await supersample(engine, { samples: 4 });
  for (let i = 0; i < 4; i++) {
    const [x, y] = sampleOffset(i, 4),
      m = log.matrices[i];
    assert.ok(Math.abs(m[0] - ((2 * x) / 100) * 2) < 1e-6, `x of sample ${i}`);
    assert.ok(Math.abs(m[1] + ((2 * y) / 50) * 2) < 1e-6, `y of sample ${i}`);
    assert.ok(Math.abs(m[12] - (2 * x) / 100) < 1e-6, `x of w row ${i}`);
    assert.ok(Math.abs(m[13] + (2 * y) / 50) < 1e-6, `y of w row ${i}`);
  }
  assert.deepEqual([...log.matrices[4]].slice(0, 2), [0, 0], 'the last frame is not moved');
});

test('the camera is itself again between batches, so the engine loop never draws an offset frame', async () => {
  let seen;
  const { engine, camera } = fake({
    onRender: (count) => {
      if (count === 5) seen = camera.update;
    },
  });
  const original = camera.update;
  let between = 0;
  const wait = engine.gpu.queue.onSubmittedWorkDone;
  engine.gpu.queue.onSubmittedWorkDone = async () => {
    if (camera.update === original) between++;
    return wait();
  };
  await supersample(engine, { samples: 8 });
  assert.equal(between, 2, 'both batch waits saw the real update');
  assert.notEqual(seen, original, 'it is swapped only while a sample renders');
  assert.equal(camera.update, original);
});

test('a thrown render puts the camera back and releases every texture', async () => {
  const { engine, log, camera } = fake({
    onRender: (count) => {
      if (count === 3) throw new Error('broken frame');
    },
  });
  const original = camera.update;
  await assert.rejects(supersample(engine, { samples: 8 }), /broken frame/);
  assert.equal(camera.update, original);
  assert.equal(log.destroyed, log.textures.length + 1, 'textures and the read buffer');
});

test('rows are read without the 256-byte padding', async () => {
  const { engine } = fake({ width: 3, height: 2 }),
    { width, height, data } = await supersample(engine, { samples: 1 });
  assert.deepEqual([width, height, data.length], [3, 2, 24]);
  assert.ok(data instanceof Uint8ClampedArray);
  assert.equal(data[11], 11, 'the first row ends at byte 11');
  assert.deepEqual([data[12], data[13]], [256 % 251, 257 % 251], 'the second row starts at byte 256 of the buffer');
});

test('width and height default to the canvas, and may exceed it', async () => {
  const { engine, log } = fake({ width: 3, height: 2 });
  await supersample(engine, { samples: 1, width: 8, height: 9 });
  assert.deepEqual(log.textures[0].size, [8, 9]);
  assert.equal(log.textures[0].format, 'bgra8unorm', 'the canvas format, so existing pipelines serve');
});

test('invalid options throw before any GPU work', async () => {
  const { engine, log } = fake();
  for (const options of [
    { samples: 0 },
    { samples: 1.5 },
    { samples: 1025 },
    { width: 0 },
    { height: 2.5 },
    { width: 5000 },
  ])
    await assert.rejects(supersample(engine, options), RangeError, JSON.stringify(options));
  assert.equal(log.renders.length, 0);
  assert.equal(log.textures.length, 0);
});

test('without WebGPU it says so', async () => {
  const { engine } = fake();
  engine.gpu = undefined;
  await assert.rejects(supersample(engine), (error) => error.code === 'unsupported');
});

test('an abort rejects with the reason and stops between batches', async () => {
  const controller = new AbortController(),
    reason = new Error('stop'),
    { engine, log } = fake({
      onRender: (count) => {
        if (count === 2) controller.abort(reason);
      },
    });
  await assert.rejects(supersample(engine, { samples: 64, signal: controller.signal }), (error) => error === reason);
  assert.equal(log.renders.length, 5, 'one batch of four, then the plain frame');
  assert.equal(log.destroyed, log.textures.length + 1);
  const { engine: other, log: none } = fake();
  await assert.rejects(supersample(other, { signal: AbortSignal.abort(reason) }), (error) => error === reason);
  assert.equal(none.renders.length, 0, 'aborted before it began: nothing runs');
});
