// CPU tests of @margoengine/culling/occlusion's scheduling: the readback ring, result latency, retries and strategies,
// CPU decisions for off-screen and near-cut boxes, stale frames, AbortSignal, disposal and query-set chunking. A fake
// device runs each frame's commands on submit and lands mappings when the test says so; its "GPU" passes a box's
// samples from `samplesOf(lo, hi)`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OcclusionQueries, classifyBox } from '../dist/occlusion.js';
import { box } from '../../core/dist/index.js';

globalThis.GPUBufferUsage ??= {
  MAP_READ: 1,
  COPY_SRC: 4,
  COPY_DST: 8,
  VERTEX: 32,
  UNIFORM: 64,
  QUERY_RESOLVE: 512,
};
globalThis.GPUBufferUsage.QUERY_RESOLVE ??= 512;
globalThis.GPUMapMode ??= { READ: 1 };

// A frustum of -10 <= x, y <= 10 and 1 <= z <= 100 (near plane 4, far plane 5), inside-positive.
const planes = new Float32Array([1, 0, 0, 10, -1, 0, 0, 10, 0, 1, 0, 10, 0, -1, 0, 10, 0, 0, 1, -1, 0, 0, -1, 100]);

function harness({ samplesOf = () => 4, options } = {}) {
  const resources = [],
    maps = [],
    log = { passes: 0, queries: 0, resolves: [] };
  let commands = [];
  const buffer = (d) => {
    const b = {
      ...d,
      data: new ArrayBuffer(d.size),
      destroyed: false,
      destroy() {
        b.destroyed = true;
      },
      mapAsync() {
        return new Promise((resolve, reject) => maps.push({ b, resolve, reject }));
      },
      getMappedRange: () => b.data,
      unmap() {},
    };
    resources.push(b);
    return b;
  };
  const device = {
    queue: {
      writeBuffer(b, offset, value, start = 0, count) {
        const unit = value.BYTES_PER_ELEMENT ?? 1;
        new Uint8Array(b.data).set(
          new Uint8Array(value.buffer, value.byteOffset + start * unit, (count ?? value.length - start) * unit),
          offset,
        );
      },
    },
    createBuffer: buffer,
    createQuerySet(d) {
      const s = {
        ...d,
        results: [],
        destroyed: false,
        destroy: () => (s.destroyed = true),
      };
      resources.push(s);
      return s;
    },
    createShaderModule: (d) => d,
    createBindGroup: (d) => d,
    createRenderPipeline: (d) => ({ ...d, getBindGroupLayout: () => ({}) }),
  };
  const encoder = {
    beginRenderPass(d) {
      log.passes++;
      let index = -1,
        instances;
      return {
        setViewport() {},
        setScissorRect() {},
        setPipeline() {},
        setBindGroup() {},
        setVertexBuffer(slot, b) {
          if (slot === 1) instances = b;
        },
        beginOcclusionQuery(i) {
          index = i;
          log.queries++;
        },
        draw(vertices, count, first, instance) {
          const i = index;
          commands.push(() => {
            const f = new Float32Array(instances.data, instance * 24, 6);
            d.occlusionQuerySet.results[i] = samplesOf([...f.slice(0, 3)], [...f.slice(3)]);
          });
        },
        endOcclusionQuery() {},
        end() {},
      };
    },
    resolveQuerySet(set, first, count, dst, offset) {
      log.resolves.push({ count, offset });
      commands.push(() => {
        const out = new BigUint64Array(dst.data, offset, count);
        for (let i = 0; i < count; i++) out[i] = BigInt(set.results[first + i] ?? 0);
      });
    },
    copyBufferToBuffer(src, from, dst, to, size) {
      commands.push(() => new Uint8Array(dst.data, to, size).set(new Uint8Array(src.data, from, size)));
    },
  };
  const context = {
    backend: 'webgpu',
    device,
    encoder,
    depth: {},
    descriptor: {
      depthStencil: { format: 'depth32float', depthCompare: 'greater-equal' },
      multisample: { count: 1 },
    },
    camera: { matrix: new Float32Array(16), planes },
  };
  const engine = {
      backend: 'webgpu',
      gpu: device,
      sceneOf: () => ({ removePlugin() {} }),
    },
    plugin = new OcclusionQueries(options);
  let pass;
  plugin.setup(engine);
  plugin.registerPasses({ add: (p) => (pass = p) });
  return {
    plugin,
    log,
    resources,
    maps,
    context,
    /** One engine frame: the graph runs the pass, then core submits (unless `submit` is false). */
    async frame(submit = true) {
      pass.execute(context);
      if (submit) for (const run of commands) run();
      commands = [];
      await Promise.resolve();
    },
    /** Lands the oldest mapping (the GPU finished that frame). */
    async land() {
      maps.shift().resolve();
      await new Promise((r) => setImmediate(r));
    },
  };
}

const wall = (lo) => (lo[2] > 50 ? 0 : 6); // anything deeper than z = 50 is behind the wall

test('a box behind the wall reads occluded and one in front reads visible, with their sample counts', async () => {
  const h = harness({ samplesOf: wall }),
    front = h.plugin.add({ min: [-1, -1, 10], max: [1, 1, 12] }),
    back = h.plugin.add({ min: [-1, -1, 60], max: [1, 1, 62] });
  assert.equal(back.isOccluded, false, 'visible until the first result');
  assert.equal(back.hasResult, false);
  await h.frame();
  assert.equal(h.log.queries, 2);
  assert.deepEqual(h.log.resolves, [{ count: 2, offset: 0 }]);
  assert.equal(back.isOccluded, false, 'the result has not landed yet');
  assert.equal(back.pendingFrames, 1);
  await h.land();
  assert.equal(back.isOccluded, true);
  assert.equal(back.samples, 0);
  assert.equal(front.isOccluded, false);
  assert.equal(front.samples, 6);
  assert.ok(front.hasResult && back.hasResult);
  h.plugin.dispose();
});

test('results arrive through a three-buffer ring: a fourth frame in flight issues no queries', async () => {
  const h = harness();
  const q = h.plugin.add({ min: [0, 0, 5], max: [1, 1, 6] });
  for (let i = 0; i < 4; i++) await h.frame();
  assert.equal(h.log.passes, 3, 'three slots in flight, the fourth frame waits');
  assert.equal(q.pendingFrames, 4);
  await h.land();
  assert.equal(q.hasResult, true);
  assert.equal(q.pendingFrames, 3, 'the newest landed result is from frame 1 of 4');
  await h.frame();
  assert.equal(h.log.passes, 4, 'a freed slot queries again');
  h.plugin.dispose();
});

test('retries: past the limit, strict reads occluded and optimistic visible; a landing result wins again', async () => {
  const h = harness({ samplesOf: () => 0, options: { retries: 1 } }),
    strict = h.plugin.add({ min: [0, 0, 5], max: [1, 1, 6] }, { strategy: 'strict' }),
    optimistic = h.plugin.add({ min: [0, 0, 5], max: [1, 1, 6] });
  await h.frame();
  assert.equal(strict.isOccluded, false, 'one pending frame is within retries');
  await h.frame();
  assert.equal(strict.isOccluded, true, 'strict: two pending frames exceed retries 1');
  assert.equal(optimistic.isOccluded, false, 'optimistic: forced visible');
  await h.land();
  assert.equal(optimistic.isOccluded, true, 'the landed result (0 samples) replaces the forced value');
  const never = h.plugin.add({ min: [0, 0, 5], max: [1, 1, 6] }, { retries: -1, strategy: 'strict' });
  for (let i = 0; i < 6; i++) await h.frame();
  assert.equal(never.isOccluded, false, 'retries -1 keeps the last value however long it waits');
  h.plugin.dispose();
});

test('off-screen boxes read occluded and near-cut boxes visible on the CPU, without a query', async () => {
  const h = harness(),
    off = h.plugin.add({ min: [20, 0, 5], max: [21, 1, 6] }),
    cut = h.plugin.add({ min: [-1, -1, 0], max: [1, 1, 3] }),
    far = h.plugin.add({ min: [-1, -1, 99], max: [1, 1, 120] });
  await h.frame();
  assert.equal(h.log.passes, 0, 'nothing needed the GPU');
  assert.deepEqual(
    [off.isOccluded, off.samples, cut.isOccluded, cut.samples, far.isOccluded],
    [true, 0, false, 1, false],
  );
  assert.equal(off.pendingFrames, 0);
  assert.deepEqual([classifyBox([0, 0, 5], [1, 1, 6], planes), classifyBox([0, 0, -9], [1, 1, -8], planes)], [2, 0]);
  h.plugin.dispose();
});

test('a frame that was never submitted leaves its stale results unread', async () => {
  const h = harness({ samplesOf: () => 0 }),
    q = h.plugin.add({ min: [0, 0, 5], max: [1, 1, 6] });
  await h.frame(false);
  await h.land();
  assert.equal(q.hasResult, false, "the slot's stamp is not this frame's: nothing applied");
  await h.frame();
  await h.land();
  assert.equal(q.isOccluded, true);
  h.plugin.dispose();
});

test('a result older than a CPU decision does not replace it', async () => {
  const h = harness({ samplesOf: () => 0 }),
    target = { min: [0, 0, 5], max: [1, 1, 6] },
    q = h.plugin.add(target);
  await h.frame();
  target.min = [30, 0, 5];
  target.max = [31, 1, 6];
  await h.frame();
  assert.equal(q.isOccluded, true);
  target.min = [-1, -1, 0];
  target.max = [1, 1, 3];
  await h.frame();
  assert.equal(q.isOccluded, false, 'cut by the near plane: visible now');
  await h.land();
  assert.equal(q.isOccluded, false, 'the older GPU result is dropped');
  h.plugin.dispose();
});

test('next() resolves on landing, rejects on abort and on dispose; dispose frees every GPU resource', async () => {
  const h = harness();
  h.plugin.add({ min: [0, 0, 5], max: [1, 1, 6] });
  await h.frame();
  let landed = false;
  const waiting = h.plugin.next().then(() => (landed = true));
  await h.land();
  await waiting;
  assert.ok(landed);
  const controller = new AbortController();
  const aborted = h.plugin.next({ signal: controller.signal });
  controller.abort(new Error('stop'));
  await assert.rejects(aborted, /stop/);
  await assert.rejects(h.plugin.next({ signal: AbortSignal.abort(new Error('early')) }), /early/);
  const pending = h.plugin.next();
  h.plugin[Symbol.dispose]();
  await assert.rejects(pending, (e) => e.name === 'MargoError' && e.code === 'disposed');
  assert.ok(
    h.resources.every((r) => r.destroyed),
    'query sets and buffers destroyed',
  );
  assert.throws(() => h.plugin.add({ min: [0, 0, 0], max: [1, 1, 1] }), /disposed/);
  for (const m of h.maps) m.reject(new DOMException('destroyed', 'AbortError'));
});

test('more than 4,096 objects use one render pass and query set per 4,096, resolved at 32 KiB offsets', async () => {
  const h = harness({ options: { capacity: 5000 } });
  for (let i = 0; i < 4100; i++) h.plugin.add({ min: [0, 0, 5], max: [1, 1, 6] });
  assert.equal(h.resources.filter((r) => r.type === 'occlusion').length, 0, 'GPU objects are made on the first frame');
  await h.frame();
  assert.deepEqual(
    h.resources.filter((r) => r.type === 'occlusion').map((s) => s.count),
    [4096, 904],
  );
  assert.equal(h.log.passes, 2);
  assert.deepEqual(h.log.resolves, [
    { count: 4096, offset: 0 },
    { count: 4, offset: 32768 },
  ]);
  await h.land();
  assert.equal(h.plugin.size, 4100);
  h.plugin.dispose();
});

test('a core mesh is queried with its geometry box moved by its world matrix', async () => {
  let seen;
  const h = harness({
      samplesOf: (lo, hi) => {
        seen = [lo, hi];
        return 1;
      },
    }),
    matrix = new Float32Array([2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, 0, 20, 1]),
    mesh = { matrix, geometry: box(1, 2, 4) };
  const q = h.plugin.add(mesh);
  await h.frame();
  await h.land();
  assert.equal(q.isOccluded, false);
  const want = [
    [2, -1, 18],
    [4, 1, 22],
  ];
  for (let k = 0; k < 3; k++) {
    assert.ok(seen[0][k] < want[0][k] && seen[0][k] > want[0][k] - 0.01, `min ${k}: ${seen[0][k]}`);
    assert.ok(seen[1][k] > want[1][k] && seen[1][k] < want[1][k] + 0.01, `max ${k}: ${seen[1][k]}`);
  }
  const empty = h.plugin.add({ matrix, geometry: null });
  await h.frame();
  assert.equal(empty.isOccluded, true, 'a mesh without geometry draws nothing');
  q.dispose();
  assert.equal(h.plugin.size, 1);
  h.plugin.dispose();
});

test('invalid options and targets throw with the fix', () => {
  assert.throws(() => new OcclusionQueries({ capacity: 0 }), /from 1 to 65536$/);
  assert.throws(() => new OcclusionQueries({ retries: -2 }), RangeError);
  assert.throws(() => new OcclusionQueries({ strategy: 'lazy' }), /"optimistic" or "strict"$/);
  assert.throws(() => new OcclusionQueries({ order: 0 }), /above 0/);
  const p = new OcclusionQueries({ capacity: 1 });
  assert.throws(() => p.add({}), /pass \{ min, max \} world box or a core Mesh$/);
  p.add({ min: [0, 0, 0], max: [1, 1, 1] });
  assert.throws(() => p.add({ min: [0, 0, 0], max: [1, 1, 1] }), /larger capacity$/);
  assert.throws(
    () => p.setup({ backend: 'webgl2', gpu: null }),
    (e) => e.code === 'unsupported',
  );
});
