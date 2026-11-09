import assert from 'node:assert/strict';
import test from 'node:test';
import { Figure, IsosurfaceLayer, Timeline, VolumeLayer } from '@margoengine/sciviz';
import { BrickedVolumeLayer } from '@margoengine/sciviz/bricks';

globalThis.GPUBufferUsage = { UNIFORM: 1, COPY_DST: 2, STORAGE: 4 };
globalThis.GPUTextureUsage = { TEXTURE_BINDING: 1, COPY_DST: 2, RENDER_ATTACHMENT: 4 };
globalThis.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2 };

const deferred = () => Promise.withResolvers();
const drain = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

// Only scheduling and publication are mocked. The real GPU suite also checks extraction and rendered pixels.
function fixture() {
  const buffers = [],
    generated = [],
    waiting = [];
  const device = {
    limits: { maxStorageBufferBindingSize: 1 << 24, maxTextureDimension3D: 2048 },
    createBuffer({ size }) {
      const buffer = {
        size,
        destroyed: false,
        destroy() {
          this.destroyed = true;
        },
      };
      buffers.push(buffer);
      return buffer;
    },
    createBindGroupLayout: () => ({}),
    createBindGroup: ({ entries }) => ({ entries }),
    createTexture: () => ({ createView: () => ({}), destroy() {} }),
    createSampler: () => ({}),
    queue: { writeTexture() {}, writeBuffer() {} },
  };
  const renderer = { device, remove() {}, pipeline: () => ({}) };
  const array = () => ({ dispose() {} });
  let level;
  const gpu = {
    array,
    grid: () => [1],
    scan: array,
    zeros: () => ({ ...array(), sum: () => ({ ...array(), item: async () => level }) }),
    kernel: () => ({
      run(args) {
        level = new DataView(args.grid.buffer).getFloat32(16, true);
        if (args.vertices) generated.push({ level, buffer: args.vertices });
      },
    }),
    done({ signal }) {
      const gate = deferred();
      const abort = () => gate.reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      waiting.push(gate);
      return gate.promise.finally(() => signal.removeEventListener('abort', abort));
    },
  };
  const draw = (iso) => {
    let group, count;
    iso.draw(
      {
        setPipeline() {},
        setBindGroup(_slot, value) {
          group = value;
        },
        draw(n) {
          count = n;
        },
      },
      {},
      renderer,
    );
    return { buffer: group?.entries[1].resource.buffer, count };
  };
  return { renderer, gpu, buffers, generated, waiting, draw };
}

test('overlapping isosurface updates publish matching vertices, level and count in order', {
  timeout: 5000,
}, async () => {
  const f = fixture(),
    iso = new IsosurfaceLayer(f.renderer, f.gpu, new Float32Array(8));
  const initial = iso.update(2);
  await drain();
  f.waiting.shift().resolve();
  await initial;
  const before = f.draw(iso);
  const first = iso.update(8),
    second = iso.update(3);
  await drain();
  assert.deepEqual(
    f.generated.map((g) => g.level),
    [2, 8],
    'only one extraction runs at a time',
  );
  assert.deepEqual(f.draw(iso), before, 'pending extraction cannot change displayed vertices');
  assert.equal(before.buffer.destroyed, false);
  f.waiting.shift().resolve();
  assert.equal(await first, 8);
  await drain();
  assert.equal(iso.level, 8);
  assert.equal(f.draw(iso).count, 24);
  assert.equal(f.draw(iso).buffer, f.generated[1].buffer);
  assert.equal(before.buffer.destroyed, true);
  f.waiting.shift().resolve();
  assert.equal(await second, 3);
  assert.equal(iso.level, 3);
  assert.equal(f.draw(iso).count, 9);
  assert.equal(f.draw(iso).buffer, f.generated[2].buffer);
  iso.dispose();
  assert(f.buffers.every((b) => b.destroyed));
});

test('aborted and failed extractions keep the displayed surface and do not poison the queue', {
  timeout: 5000,
}, async () => {
  const f = fixture(),
    iso = new IsosurfaceLayer(f.renderer, f.gpu, new Float32Array(8));
  const initial = iso.update(2);
  await drain();
  f.waiting.shift().resolve();
  await initial;
  const before = f.draw(iso),
    controller = new AbortController(),
    reason = new Error('cancel');
  const aborted = iso.update(7, { signal: controller.signal });
  const rejected = assert.rejects(aborted, (e) => e === reason);
  await drain();
  controller.abort(reason);
  await rejected;
  assert.deepEqual(f.draw(iso), before);
  assert.equal(iso.level, 2);
  assert.equal(f.generated.at(-1).buffer.destroyed, true);
  f.waiting.shift();
  const failed = iso.update(6),
    failure = new Error('device submission failed');
  const caught = assert.rejects(failed, (e) => e === failure);
  await drain();
  f.waiting.shift().reject(failure);
  await caught;
  assert.deepEqual(f.draw(iso), before);
  const next = iso.update(0);
  await drain();
  f.waiting.shift().resolve();
  await next;
  assert.equal(iso.level, 0);
  assert.equal(iso.triangles, 0);
  assert.equal(f.draw(iso).count, undefined);
  iso.dispose();
});

test('queued abort and disposal cannot publish an isosurface or use freed resources', { timeout: 5000 }, async () => {
  const f = fixture(),
    iso = new IsosurfaceLayer(f.renderer, f.gpu, new Float32Array(8));
  const first = iso.update(2),
    controller = new AbortController();
  const second = iso.update(7, { signal: controller.signal });
  const rejected = assert.rejects(second, (e) => e === controller.signal.reason);
  controller.abort();
  await drain();
  f.waiting.shift().resolve();
  await first;
  await rejected;
  assert.deepEqual(
    f.generated.map((g) => g.level),
    [2],
  );
  const pending = iso.update(4),
    queued = iso.update(5);
  const disposed = [assert.rejects(pending, /disposed/), assert.rejects(queued, /disposed/)];
  await drain();
  iso.dispose();
  await Promise.all(disposed);
  assert.equal(iso.level, 2);
  assert(f.buffers.every((b) => b.destroyed));
});

test('volume and isosurface distinguish insufficient axes from mismatched data length', () => {
  const f = fixture();
  for (const make of [
    (data, dims) => new VolumeLayer(f.renderer, data, { dims }),
    (data, dims) => new IsosurfaceLayer(f.renderer, f.gpu, data, { dims }),
  ]) {
    for (const dims of [
      [128, 128, 1],
      [1, 128, 128],
      [128, 1, 128],
    ])
      assert.throws(
        () => make(new Float32Array(16384), dims),
        (e) =>
          e instanceof RangeError &&
          /at least 2 samples on each axis/.test(e.message) &&
          /single slice is an image.*2D figure.heatmap/.test(e.message) &&
          !/do not hold/.test(e.message),
      );
    assert.throws(() => make(new Float32Array(7), [2, 2, 2]), /do not hold 7 values/);
  }
});

test('bricked frame requests serialize their own readiness, recover after abort, and reject after disposal', {
  timeout: 5000,
}, async () => {
  const f = fixture();
  const layer = new BrickedVolumeLayer(
    f.renderer,
    {
      dims: [2, 2, 2],
      range: [0, 1],
      frames: 3,
      read: () => new Float32Array(8),
    },
    { brickSize: 4, memoryBudget: 4096 },
  );
  const gates = [],
    calls = [];
  layer.ready = ({ signal } = {}) => {
    const gate = deferred();
    gates.push(gate);
    calls.push(signal);
    return gate.promise;
  };
  const a = layer.setFrame(1),
    b = layer.setFrame(2);
  await drain();
  assert.equal(calls.length, 1);
  gates.shift().resolve();
  await a;
  await drain();
  assert.equal(calls.length, 2);
  gates.shift().resolve();
  await b;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(layer.setFrame(0, { signal: controller.signal }), (e) => e === controller.signal.reason);
  assert.equal(calls.length, 2);
  const c = layer.setFrame(0);
  await drain();
  gates.shift().resolve();
  await c;
  layer.dispose();
  await assert.rejects(layer.setFrame(1), /disposed/);
});

test('concurrent timeline seeks never overlap and disposal cannot publish a pending frame', {
  timeout: 5000,
}, async () => {
  const gates = [],
    calls = [],
    events = [];
  const timeline = new Timeline(
    undefined,
    {},
    [0, 1, 2],
    (index) => {
      calls.push(index);
      const gate = deferred();
      gates.push(gate);
      return gate.promise;
    },
    { controls: false },
  );
  timeline.addEventListener('time', (e) => events.push(e.detail.index));
  const first = timeline.seek(0),
    second = timeline.seek(2);
  await drain();
  assert.deepEqual(calls, [0]);
  gates.shift().resolve();
  await first;
  await drain();
  assert.deepEqual(calls, [0, 2]);
  timeline.dispose();
  gates.shift().resolve();
  await second;
  assert.equal(timeline.index, 0);
  assert.deepEqual(events, [0]);
});

test('replace validates ownership, preserves layer order, refits bounds and frees only the old layer', () => {
  const f = fixture();
  const engine = {
    gpu: f.renderer.device,
    use(plugin) {
      plugin.setup(this);
    },
    removePlugin() {},
  };
  const figure = new Figure(engine, { axes: false });
  const make = (x) =>
    figure.addLayer({
      bounds: [x, x + 1, 0, 1, 0, 1],
      setModel() {},
      dispose() {
        this.freed = true;
      },
    });
  const a = make(0),
    old = make(10),
    c = make(2),
    next = make(3);
  assert.equal(figure.replace(old, next), next);
  assert.deepEqual(figure.layers, [a, next, c]);
  assert.equal(old.freed, true);
  assert.equal(next.freed, undefined);
  assert.equal(figure.bounds[1], 4, 'bounds no longer include the old data');
  assert.equal(figure.replace(next, next), next);
  assert.throws(() => figure.replace(old, next), /belonging to this figure/);
  assert.throws(() => figure.replace(next, {}), /belonging to this figure/);
  assert.deepEqual(figure.layers, [a, next, c]);
  figure.dispose();
  assert.throws(() => figure.replace(next, next), /disposed/);
});

test('disposing a figure during isosurface creation cannot register a late layer or leak its buffers', {
  timeout: 5000,
}, async (t) => {
  const f = fixture();
  const engine = {
    gpu: f.renderer.device,
    use(plugin) {
      plugin.setup(this);
    },
    removePlugin() {},
  };
  const started = deferred(),
    finish = deferred();
  const update = t.mock.method(IsosurfaceLayer.prototype, 'update', async () => {
    started.resolve();
    await finish.promise;
    return 1;
  });
  const figure = new Figure(engine, { axes: false });
  const pending = figure.isosurface(new Float32Array(8), 0);
  await started.promise;
  figure.dispose();
  finish.resolve();
  await assert.rejects(pending, /disposed/);
  assert.deepEqual(figure.layers, []);
  await drain();
  assert(f.buffers.every((b) => b.destroyed));
  const early = new Figure(engine, { axes: false });
  const tooLate = early.isosurface(new Float32Array(8), 0);
  early.dispose();
  await assert.rejects(tooLate, /disposed/);
  assert.equal(update.mock.callCount(), 1, 'no extraction starts after disposal during compute loading');
});

test('removing and disposing figure traces detaches their resources synchronously', () => {
  const f = fixture();
  const engine = {
    gpu: f.renderer.device,
    use(plugin) {
      plugin.setup(this);
    },
    removePlugin() {},
  };
  const figure = new Figure(engine, { axes: false });
  const calls = [];
  const make = (kind, id) =>
    figure.addLayer({
      kind,
      bounds: [0, 1, 0, 1, 0, 1],
      cloud: {
        matrix: new Float32Array(16),
        dispose() {
          calls.push(id);
        },
      },
      line: {
        setMatrix() {},
        dispose() {
          calls.push(id);
        },
      },
    });
  const scatter = make('scatter', 'removed cloud'),
    line = make('line', 'removed line');
  figure.remove(scatter);
  figure.remove(line);
  assert.deepEqual(calls, ['removed cloud', 'removed line'], 'no microtask wait before the next render');
  make('scatter', 'disposed cloud');
  make('line', 'disposed line');
  figure.dispose();
  assert.deepEqual(calls, ['removed cloud', 'removed line', 'disposed cloud', 'disposed line']);
});
