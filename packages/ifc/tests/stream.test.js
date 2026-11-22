// Streaming load: streamIFCMeshes reads a model chunk by chunk (envelope classes first) with monotonic, complete
// progress and an AbortSignal; its chunks joined equal readIFCMeshes and cover what web-ifc's StreamAllMeshes reads;
// IFCScene.add puts later chunks into the existing instance groups and batches, so a streamed scene equals a whole
// load; streamIFCInWorker yields the same chunks from a worker and terminates it on break, abort and silence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { IfcAPI } from 'web-ifc';
import { LoaderError } from '@margoengine/loaders';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { openIFC } from '../dist/index.js';
import { readIFCMeshes, streamIFCMeshes, createIFCScene } from '../dist/scene.js';
import { streamIFCInWorker } from '../dist/worker.js';

const require = createRequire(import.meta.url);
const api = new IfcAPI();
await api.Init();
api.SetLogLevel?.(6);
const fixture = (name) => readFile(new URL(`./fixtures/${name}`, import.meta.url)).then((b) => new Uint8Array(b));
const big = await fixture('bcf/Architectural.ifc'),
  building = await fixture('building.ifc');

async function engine() {
  const device = optionalGPU().engine.gpu;
  device.queue.writeTexture = () => {};
  return new Engine(
    { width: 64, height: 64, clientWidth: 64, clientHeight: 64 },
    await TransformStore.create(64),
    { backend: 'webgpu', gpu: device, add() {}, remove() {}, render() {}, dispose() {} },
    { position: [0, 0, 4], target: [0, 0, 0] },
    null,
  );
}
async function collect(iterable) {
  const out = [];
  for await (const c of iterable) out.push(c);
  return out;
}
function join(chunks) {
  const out = { schema: chunks[0].schema, origin: chunks.at(-1).origin, geometries: new Map(), placements: [] };
  for (const c of chunks) {
    for (const [k, g] of c.geometries) {
      assert.ok(!out.geometries.has(k), `geometry ${k} is sent once`);
      out.geometries.set(k, g);
    }
    for (const p of c.placements) {
      assert.ok(out.geometries.has(p.geometry), `geometry ${p.geometry} arrives no later than its first placement`);
      out.placements.push(p);
    }
  }
  return out;
}
const typeOf = (model, id) => api.GetNameFromTypeCode(api.GetLineType(model.id, id)).toUpperCase();

test('a large model streams in several chunks, progress monotonic and complete, joined equal to readIFCMeshes', async () => {
  using model = openIFC(api, big);
  const chunks = await collect(streamIFCMeshes(model, { chunk: 16, origin: 'auto' }));
  assert.ok(chunks.length >= 4, `streamed in ${chunks.length} chunks`);
  const total = chunks[0].total;
  assert.ok(total > 64);
  for (let i = 0; i < chunks.length; i++) {
    assert.equal(chunks[i].total, total);
    if (i) assert.ok(chunks[i].loaded > chunks[i - 1].loaded, 'progress grows every chunk');
    assert.ok(chunks[i].loaded <= total);
    assert.deepEqual(chunks[i].origin, chunks[0].origin, "'auto' origin is fixed by the first chunk");
  }
  assert.equal(chunks.at(-1).loaded, total, 'the last chunk reports every element read');
  const whole = readIFCMeshes(model, { origin: 'auto' });
  assert.deepEqual(join(chunks), whole);
  // Every chunk structured-clones, as the worker sends it.
  assert.deepEqual(structuredClone(chunks[0]), chunks[0]);
});

test("the streamed elements are those web-ifc's StreamAllMeshes reads", () => {
  for (const bytes of [big, building]) {
    using model = openIFC(api, bytes);
    const all = new Set();
    api.StreamAllMeshes(model.id, (m) => all.add(m.expressID));
    const streamed = new Set(readIFCMeshes(model).placements.map((p) => p.element));
    assert.deepEqual([...streamed].sort(), [...all].sort());
  }
});

test("ordering: 'envelope' streams walls and slabs first, 'file' in expressID order, `elements` streams a subset", async () => {
  using model = openIFC(api, big);
  const order = (meshes) => [...new Set(meshes.placements.map((p) => p.element))];
  const envelope = order(readIFCMeshes(model)),
    rank = (id) => (/^IFC(WALL|SLAB|ROOF|CURTAINWALL)/.test(typeOf(model, id)) ? 0 : 1);
  assert.equal(rank(envelope[0]), 0, 'the first element is part of the shell');
  const ranks = envelope.map(rank);
  assert.deepEqual(
    ranks,
    ranks.slice().sort((a, b) => a - b),
    'every shell element comes before the rest',
  );
  const file = order(readIFCMeshes(model, { order: 'file' }));
  assert.deepEqual(
    file,
    file.slice().sort((a, b) => a - b),
  );
  assert.deepEqual(file.slice().sort(), envelope.slice().sort());
  const pick = [file[3], file[1], file[1], 999_999_999];
  const subset = await collect(streamIFCMeshes(model, { elements: pick, chunk: 1, order: 'file' }));
  assert.deepEqual(order(join(subset)), [file[1], file[3]], 'duplicates and non-products are dropped');
  assert.equal(subset.at(-1).total, 2);
  assert.throws(() => readIFCMeshes(model, { order: 'size' }), /order must be/);
  assert.throws(() => readIFCMeshes(model, { chunk: 0, elements: [1.5] }), /expressIDs/);
  await assert.rejects(collect(streamIFCMeshes(model, { chunk: 0 })), /chunk must be/);
});

test('aborting mid-stream rejects with code aborted and leaves the model open for the caller', async () => {
  using model = openIFC(api, big);
  const stop = new AbortController(),
    seen = [];
  await assert.rejects(
    (async () => {
      for await (const c of streamIFCMeshes(model, { chunk: 16, signal: stop.signal })) {
        seen.push(c);
        stop.abort();
      }
    })(),
    (e) => e instanceof LoaderError && e.code === 'aborted',
  );
  assert.equal(seen.length, 1, 'no chunk after the abort');
  assert.ok(seen[0].loaded < seen[0].total);
  assert.equal(model.closed, false);
  assert.ok(readIFCMeshes(model).placements.length > 0, 'the model still reads');
  // An aborted signal stops the stream before any work.
  await assert.rejects(collect(streamIFCMeshes(model, { signal: AbortSignal.abort() })), (e) => e.code === 'aborted');
});

/** What a scene draws, independent of batch layout: per element its parts, per instanced mesh its rows. */
function drawn(scene) {
  const rows = scene.meshes
    .filter((m) => m.instances)
    .map((m) => {
      const ids = [];
      for (let i = 0; i < m.instances.count; i++) ids.push(scene.elementAt({ model: m, instanceId: i }));
      return JSON.stringify([ids, Array.from(m.instances.data.subarray(0, m.instances.count * 24))]);
    })
    .sort();
  const batched = scene.meshes.filter((m) => !m.instances);
  return {
    draws: scene.meshes.length,
    elements: scene.elements,
    rows,
    bounds: scene.elements.map((id) => Array.from(scene.bounds([id]))),
    batches: batched.map((m) => m.material.transparent),
  };
}

test('a streamed scene joins instance groups and batches and equals a whole load', async () => {
  using model = openIFC(api, big);
  const whole = createIFCScene(await engine(), readIFCMeshes(model));
  let streamed;
  for await (const chunk of streamIFCMeshes(model, { chunk: 8 }))
    streamed = streamed ? streamed.add(chunk) : createIFCScene(await engine(), chunk);
  assert.deepEqual(drawn(streamed), drawn(whole));
  // Picking ids: every batch vertex's UV0 slot names the element the whole load names there.
  for (const id of whole.elements) assert.deepEqual(streamed.stateOf(id), whole.stateOf(id));
  whole.dispose();
  streamed.dispose();
});

const quad = {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
  indices: new Uint32Array([0, 1, 2, 2, 1, 3]),
};
const at = (x) => Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1]);
const place = (element, geometry, x, alpha = 1) => ({ element, geometry, matrix: at(x), color: [1, 1, 1, alpha] });

test('add: a geometry placed again in a later chunk moves into one instance group, batches grow instead of multiplying', async () => {
  const scene = createIFCScene(await engine(), {
    schema: 'IFC4',
    origin: [0, 0, 0],
    geometries: new Map([[1, quad]]),
    placements: [place(10, 1, 0)],
  });
  assert.equal(scene.meshes.length, 1, 'placed once: batched');
  // The next chunk places geometry 1 again without sending it: the first part moves from the batch into a group.
  scene.add({ geometries: new Map(), placements: [place(11, 1, 2)] });
  let groups = scene.meshes.filter((m) => m.instances);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].instances.count, 2);
  assert.equal(scene.elementAt({ model: groups[0], instanceId: 0 }), 10);
  assert.equal(scene.elementAt({ model: groups[0], instanceId: 1 }), 11);
  // More placements in later chunks grow the same group.
  for (let i = 0; i < 9; i++) scene.add({ geometries: new Map(), placements: [place(12 + i, 1, 4 + i)] });
  groups = scene.meshes.filter((m) => m.instances);
  assert.equal(groups.length, 1, 'no duplicate instancing');
  assert.equal(groups[0].instances.count, 11);
  assert.equal(scene.elementAt({ model: groups[0], instanceId: 10 }), 20);
  assert.equal(groups[0].instances.data[10 * 24 + 12], 4 + 8);
  // Hidden state survives a group's growth.
  scene.hide([10]);
  scene.add({ geometries: new Map(), placements: [place(30, 1, 40)] });
  const group = scene.meshes.find((m) => m.instances);
  assert.equal(group.instances.data[0], 0, 'the hidden instance stays hidden');
  // One distinct geometry per chunk, each placed once: every chunk lands in the same opaque batch.
  for (let i = 0; i < 20; i++)
    scene.add({
      geometries: new Map([[100 + i, { ...quad, positions: quad.positions.slice() }]]),
      placements: [place(100 + i, 100 + i, i)],
    });
  const batches = scene.meshes.filter((m) => !m.instances);
  assert.equal(batches.length, 1, 'chunks share one batch');
  assert.equal(scene.elementAt({ model: batches[0], uv: [scene.elements.indexOf(119), 0] }), 119);
  scene.select([105]);
  assert.deepEqual(scene.selected, [105]);
  assert.throws(() => scene.add({ geometries: new Map(), placements: [place(1, 77, 0)] }), /missing geometry 77/);
  scene.dispose();
});

test('add counts placements per geometry key, so two keys sharing one geometry object are not instanced together', async () => {
  const scene = createIFCScene(await engine(), {
    schema: 'IFC4',
    origin: [0, 0, 0],
    geometries: new Map([
      [1, quad],
      [2, quad],
    ]),
    placements: [place(1, 1, 0), place(2, 2, 2)],
  });
  assert.deepEqual(
    scene.meshes.map((m) => !!m.instances),
    [false],
    'each key placed once: both batched',
  );
  // Another model's geometry under a key this scene knows starts its own count.
  scene.add({
    geometries: new Map([[1, { ...quad, positions: quad.positions.slice() }]]),
    placements: [place(3, 1, 4)],
  });
  assert.equal(scene.meshes.filter((m) => m.instances).length, 0);
  scene.dispose();
});

/** Runs dist/workers/ifc-stream.js in-process; importScripts loads Node's web-ifc build as the global WebIFC. */
async function inProcess(message) {
  const code = await readFile(new URL('../dist/workers/ifc-stream.js', import.meta.url), 'utf8');
  const replies = [];
  const self = {
    importScripts: () => (self.WebIFC = require('web-ifc')),
    postMessage: (data) => replies.push(structuredClone(data)),
  };
  new Function('self', code)(self);
  await self.onmessage({ data: structuredClone(message) });
  return replies;
}

test('the stream worker posts the chunks streamIFCMeshes yields, then done', async () => {
  const replies = await inProcess({
    buffer: big.slice().buffer,
    webIfc: 'web-ifc-api-iife.js',
    options: { chunk: 32 },
  });
  assert.deepEqual(replies.at(-1), { done: true });
  using model = openIFC(api, big);
  const direct = await collect(streamIFCMeshes(model, { chunk: 32 }));
  assert.deepEqual(
    replies.slice(0, -1).map((r) => r.chunk),
    direct,
  );
  const [bad] = await inProcess({ buffer: new TextEncoder().encode('nope').buffer, webIfc: 'x.js', options: {} });
  assert.equal(bad.error.name, 'LoaderError');
  assert.equal(bad.error.code, 'header');
});

/** A Worker that replies with `script` (an array of messages, posted one per macrotask) and records termination. */
function fakeWorker(script) {
  const made = [];
  globalThis.Worker = class {
    terminated = false;
    constructor() {
      made.push(this);
    }
    postMessage(message) {
      this.message = message;
      let i = 0;
      const next = () => {
        if (this.terminated || i >= script.length) return;
        this.onmessage?.({ data: script[i++] });
        setTimeout(next, 0);
      };
      setTimeout(next, 0);
    }
    terminate() {
      this.terminated = true;
    }
  };
  return made;
}

test('streamIFCInWorker yields chunks in order and terminates its worker on end, break, abort and silence', async () => {
  const saved = globalThis.Worker,
    chunk = (loaded) => ({
      schema: 'IFC4',
      origin: [0, 0, 0],
      geometries: new Map(),
      placements: [],
      loaded,
      total: 3,
    }),
    options = { webIfc: 'https://app.test/web-ifc-api-iife.js' };
  try {
    let made = fakeWorker([{ chunk: chunk(1) }, { chunk: chunk(2) }, { chunk: chunk(3) }, { done: true }]);
    const all = await collect(streamIFCInWorker(big.slice(), { ...options, elements: new Set([5, 6]), chunk: 2 }));
    assert.deepEqual(
      all.map((c) => c.loaded),
      [1, 2, 3],
    );
    assert.deepEqual(made[0].message.options.elements, [5, 6], 'elements cross as an array');
    assert.equal(made[0].terminated, true);
    made = fakeWorker([{ chunk: chunk(1) }, { chunk: chunk(2) }, { chunk: chunk(3) }, { done: true }]);
    for await (const c of streamIFCInWorker(big.slice(), options)) if (c.loaded === 1) break;
    assert.equal(made[0].terminated, true, 'break terminates the worker');
    made = fakeWorker([{ chunk: chunk(1) }, { chunk: chunk(2) }]);
    const stop = new AbortController();
    await assert.rejects(
      (async () => {
        for await (const c of streamIFCInWorker(big.slice(), { ...options, signal: stop.signal }))
          stop.abort(new Error('user'));
      })(),
      /user/,
    );
    assert.equal(made[0].terminated, true, 'abort terminates the worker');
    made = fakeWorker([{ chunk: chunk(1) }]);
    await assert.rejects(
      collect(streamIFCInWorker(big.slice(), { ...options, timeoutMs: 30 })),
      (e) => e.code === 'limit' && /nothing for 30 ms/.test(e.message),
    );
    assert.equal(made[0].terminated, true, 'a silent worker is terminated');
    made = fakeWorker([{ error: { name: 'LoaderError', message: 'IFC: syntax', format: 'IFC', code: 'syntax' } }]);
    await assert.rejects(
      collect(streamIFCInWorker(big.slice(), options)),
      (e) => e instanceof LoaderError && e.code === 'syntax',
    );
    await assert.rejects(
      collect(streamIFCInWorker(big.slice(), { ...options, timeoutMs: 0 })),
      (e) => e.code === 'range',
    );
  } finally {
    globalThis.Worker = saved;
  }
  await assert.rejects(collect(streamIFCInWorker(big.slice(), { webIfc: 'x.js' })), (e) => e.code === 'unsupported');
});
