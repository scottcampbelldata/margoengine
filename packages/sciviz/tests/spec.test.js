import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  Figure,
  figureSchema,
  loadSpecData,
  specHash,
  validateFigureSpec,
  encodeFigureValue,
  decodeFigureValue,
} from '@margoengine/sciviz/spec';
import { Camera } from '@margoengine/core';

test('versioned schema and figure factories are opt-in and do not modify the root prototype', async () => {
  const { Figure: Base } = await import('@margoengine/sciviz');
  assert.equal(Base.prototype.toJSON, undefined);
  assert.equal(typeof Figure.fromJSON, 'function');
  assert.equal(figureSchema.properties.version.const, 1);
  assert.equal(figureSchema.$schema, 'https://json-schema.org/draft/2020-12/schema');
});

test('all numeric storage kinds preserve exact bytes, offsets, nonfinite values and empty arrays', async () => {
  for (const ctor of [
    ...(globalThis.Float16Array ? [globalThis.Float16Array] : []),
    Float32Array,
    Float64Array,
    Int8Array,
    Uint8Array,
    Uint8ClampedArray,
    Int16Array,
    Uint16Array,
    Int32Array,
    Uint32Array,
  ]) {
    const input = new ctor([0, 1, -2, 10, 255, 0]);
    const view = input.subarray(1, 5);
    const encoded = await encodeFigureValue(view);
    const output = await decodeFigureValue(JSON.parse(JSON.stringify(encoded)));
    assert.equal(output.constructor, ctor);
    assert.deepEqual(new Uint8Array(output.buffer), new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  }
  for (const value of [NaN, Infinity, -Infinity, undefined])
    assert.ok(Object.is(value, await decodeFigureValue(await encodeFigureValue(value))));
  assert.deepEqual(await decodeFigureValue(await encodeFigureValue(new Float32Array())), new Float32Array());
});

test('hashes, aggregate limits, reserved tags and executable values reject', async () => {
  const data = await encodeFigureValue(new Float32Array([1, 2]));
  await assert.rejects(decodeFigureValue({ ...data, sha256: '0'.repeat(64) }), /hash mismatch/);
  await assert.rejects(encodeFigureValue(new Float32Array(2), { maxBytes: 4 }), /maxBytes/);
  await assert.rejects(encodeFigureValue([new Float32Array(2), new Uint8Array(1)], { maxBytes: 8 }), /maxBytes/);
  await assert.rejects(decodeFigureValue(JSON.parse('{"__proto__":{}}')), /unsafe/);
  await assert.rejects(decodeFigureValue({ $ref: 'missing' }), /reference/);
  await assert.rejects(
    encodeFigureValue(() => {}),
    /callback/,
  );
  const cyclic = {};
  cyclic.self = cyclic;
  await assert.rejects(encodeFigureValue(cyclic), /cyclic/);
});

test('large arrays decode without a backtracking expression stack overflow', async () => {
  const input = Uint8Array.from({ length: 4 * 1024 * 1024 }, (_, i) => i % 251);
  assert.deepEqual(await decodeFigureValue(await encodeFigureValue(input)), input);
  await assert.rejects(decodeFigureValue({ $array: 'Uint8Array', bytes: 'AB==', sha256: '0'.repeat(64) }), /canonical/);
});

test('external data verifies exact length and SHA-256 and remains external only when requested', async () => {
  const bytes = new Uint8Array(new Float32Array([1, -2, NaN]).buffer);
  const source = {
    url: `data:application/octet-stream;base64,${Buffer.from(bytes).toString('base64')}`,
    sha256: await specHash(bytes),
    dtype: 'Float32Array',
    length: 3,
  };
  const array = await loadSpecData(source);
  assert.equal(array[1], -2);
  assert.ok((await encodeFigureValue(array)).$array);
  await assert.rejects(loadSpecData({ ...source, sha256: '0'.repeat(64) }), /hash/);
  await assert.rejects(loadSpecData({ ...source, length: 2 }), /length/);
  const controller = new AbortController(),
    reason = new Error('cancelled');
  controller.abort(reason);
  await assert.rejects(loadSpecData(source, { signal: controller.signal }), (error) => error === reason);
});

function engine() {
  return { camera: new Camera(), use() {}, onFrame: () => () => {} };
}
test('custom recipes, annotations, camera, layer order and selection round trip on an owned engine', async () => {
  const codec = {
    create(fig, [value]) {
      const layer = { bounds: [0, 2, 0, 2, 0, 2], value, visible: true, setModel() {}, dispose() {} };
      return fig.addLayer(layer);
    },
    snapshot: (object) => object.value,
    restore: (object, value) => {
      object.value = value;
    },
  };
  const original = Figure.attach(engine(), { axes: false });
  const layer = await original.recipe('test.annotation', [{ label: 'MRI' }], codec);
  layer.value.label = 'T1';
  original.annotations = [{ text: 'T1', position: [1, 2, 3] }];
  original.engine.camera.position = [4, 3, 2];
  const saved = await original.toJSON();
  validateFigureSpec(saved);
  const restored = await Figure.fromJSON(JSON.parse(JSON.stringify(saved)), undefined, {
    engine: engine(),
    codecs: { 'test.annotation': codec },
  });
  assert.equal(restored.layers[0].value.label, 'T1');
  assert.deepEqual(restored.engine.camera.position, [4, 3, 2]);
  assert.deepEqual(restored.annotations, original.annotations);
  assert.deepEqual(await restored.toJSON(), saved);
  original.dispose();
  restored.dispose();
});

test('saving waits for consumed GPU inputs and no longer reads them after the factory returns', async () => {
  const { Figure: Base } = await import('@margoengine/sciviz');
  const base = Base.attach(engine(), { axes: false });
  const pending = Promise.withResolvers();
  let disposed = false,
    reads = 0;
  const gpu = {
    storage: {},
    buffer: {},
    shape: [2],
    dtype: 'f32',
    size: 2,
    read() {
      reads++;
      assert.equal(disposed, false);
      return pending.promise;
    },
  };
  base.scatter = async () =>
    base.addLayer({
      kind: 'scatter',
      bounds: [0, 1, 0, 1, 0, 1],
      positions: new Float32Array([0, 0, 0, 1, 1, 1]),
      cloud: { matrix: new Float32Array(16), dispose() {} },
    });
  const fig = Figure.record(base, { axes: false });
  const creation = fig.scatter({ x: gpu, y: [0, 1] });
  const saving = fig.toJSON();
  pending.resolve(new Float32Array([0, 1]));
  await creation;
  disposed = true;
  const first = await saving,
    second = await fig.toJSON();
  assert.equal(first.resources[0].kind, 'scatter');
  assert.deepEqual(first.resources[0].args, second.resources[0].args);
  assert.equal(reads, 1);
  fig.dispose();
});

test('saving waits for GPU isosurface mutations and snapshots the field used by the update', async () => {
  const { Figure: Base } = await import('@margoengine/sciviz');
  const base = Base.attach(engine(), { axes: false });
  let values = new Float32Array([0, 1, 0, 1, 0, 1, 0, 1]);
  const pending = Promise.withResolvers();
  const gpu = {
    storage: {}, buffer: {}, shape: [2, 2, 2], dtype: 'f32', size: 8,
    read: async () => values.slice(),
  };
  base.isosurface = async () => base.addLayer({
    kind: 'isosurface', bounds: [0, 1, 0, 1, 0, 1], setModel() {}, dispose() {},
    update: () => pending.promise,
  });
  const fig = Figure.record(base, { axes: false });
  const layer = await fig.isosurface(gpu, 0.5, { nx: 2, ny: 2, nz: 2 });
  const updating = layer.update(0.4);
  const saving = fig.toJSON();
  values = new Float32Array([0, 0, 0, 0, 1, 1, 1, 1]);
  pending.resolve();
  await updating;
  const spec = await saving;
  const [field] = await decodeFigureValue(spec.resources[0].args);
  assert.deepEqual(field, values);
  assert.deepEqual(spec.resources[0].updates, [{ method: 'update', args: [0.4] }]);
  fig.dispose();
});

test('malformed version, resource IDs, camera, mutations and timelines reject before allocation', () => {
  const valid = {
    version: 1,
    options: {},
    camera: { position: [1, 2, 3], target: [0, 0, 0], up: [0, 1, 0], fov: 60, near: 0.1, far: 100 },
    limits: [0, 1, 0, 1, 0, 1],
    dragMode: 'orbit',
    resources: [],
    layers: [],
  };
  validateFigureSpec(valid);
  for (const changed of [
    { version: 2 },
    { camera: { ...valid.camera, position: [NaN, 0, 0] } },
    { resources: [{ id: 'a', kind: 'surface', args: [], state: {}, updates: [{ method: 'dispose', args: [] }] }] },
    { layers: ['no'] },
    { time: { times: [0], index: 2, frames: [] } },
  ])
    assert.throws(() => validateFigureSpec({ ...valid, ...changed }), /Invalid|Unknown/);
});

test('clearing programmatic selection preserves the selection event contract', async () => {
  const fig = Figure.attach(engine(), { axes: false });
  let count = -1;
  fig.addEventListener('selection', (event) => {
    count = event.detail.points.length;
  });
  fig.setSelection(undefined);
  assert.equal(count, 0);
  assert.equal(fig.selection, undefined);
  assert.equal((await fig.toJSON()).selection, undefined);
  fig.dispose();
});

test('retiring recorded resources preserves ownership and disposal rejects state access', async () => {
  const fig = Figure.attach(engine(), { axes: false });
  const codec = {
    create(f) {
      return f.addLayer({ bounds: [0, 1, 0, 1, 0, 1], setModel() {}, dispose() {} });
    },
  };
  const old = await fig.recipe('test.owned', [], codec);
  const first = await fig.toJSON();
  fig.remove(old);
  assert.equal((await fig.toJSON()).resources.length, 0);
  await fig.recipe('test.owned', [], codec);
  assert.notEqual((await fig.toJSON()).resources[0].id, first.resources[0].id);
  fig.dispose();
  await assert.rejects(fig.toJSON(), (error) => error.code === 'disposed');
  assert.throws(
    () => fig.setSelection(undefined),
    (error) => error.code === 'disposed',
  );
});

test('replacement setters retain one current payload and replay its value', async () => {
  const codec = {
    create(f) {
      return f.addLayer({
        bounds: [0, 1, 0, 1, 0, 1],
        value: 0,
        setModel() {},
        dispose() {},
        setHeights(data) {
          this.value = data[0];
        },
      });
    },
  };
  const fig = Figure.attach(engine(), { axes: false });
  const layer = await fig.recipe('test.replacement', [], codec);
  for (let i = 0; i < 100; i++) layer.setHeights(new Float32Array([i]));
  const spec = await fig.toJSON();
  assert.equal(spec.resources[0].updates.length, 1);
  const copy = await Figure.fromJSON(spec, undefined, { engine: engine(), codecs: { 'test.replacement': codec } });
  assert.equal(copy.layers[0].value, 99);
  fig.dispose();
  copy.dispose();
});

test('linked selection states retain keys, resolution, empty brushes and undo/redo', async () => {
  const { SelectionStore } = await import('@margoengine/sciviz/link');
  for (const resolve of ['global', 'union', 'intersect']) {
    const store = new SelectionStore(['a', 'b', 'c'], { resolve, empty: false, history: 4 });
    store.select(['a', 'b'], { source: 'one' });
    store.select(['b', 'c'], { source: 'two' });
    store.undo();
    const state = store.toJSON(),
      copy = SelectionStore.fromJSON(JSON.parse(JSON.stringify(state)));
    assert.deepEqual(copy.toJSON(), state);
    assert.deepEqual(copy.rowIds, store.rowIds);
    assert.equal(copy.redo(), true);
    assert.equal(store.redo(), true);
    assert.deepEqual(copy.rowIds, store.rowIds);
    const decoded = await decodeFigureValue(await encodeFigureValue(store));
    assert.deepEqual(decoded.toJSON(), store.toJSON());
    assert.throws(
      () => SelectionStore.fromJSON({ ...state, brushes: [{ source: 'bad', rows: ['unknown'] }] }),
      /brush keys/,
    );
    decoded.dispose();
    copy.dispose();
    store.dispose();
  }
});
test('streamed selection universes retain later row keys and undo history', async () => {
  const { SelectionStore } = await import('@margoengine/sciviz/link');
  const store = new SelectionStore([], { universe: 'open', history: 3 });
  store.select(['later', 42]);
  store.select(['arrived'], { operation: 'union' });
  store.undo();
  const copy = SelectionStore.fromJSON(JSON.parse(JSON.stringify(store.toJSON())));
  assert.deepEqual(copy.toJSON(), store.toJSON());
  assert.deepEqual(copy.rowIds, ['later', 42]);
  assert.equal(copy.contains('future'), true);
  assert.equal(copy.redo(), true);
  assert.deepEqual(copy.rowIds, ['later', 42, 'arrived']);
  store.dispose();
  copy.dispose();
});

test('whole-state hashes cover plain arrays and camera validation uses the engine contract', async () => {
  const fig = Figure.attach(engine(), { axes: false }),
    spec = await fig.toJSON();
  assert.match(spec.sha256, /^[a-f0-9]{64}$/);
  await assert.rejects(
    Figure.fromJSON({ ...spec, annotations: [] }, undefined, { engine: engine() }),
    /Spec hash mismatch/,
  );
  const invalid = { ...spec, camera: { ...spec.camera, target: spec.camera.position } };
  delete invalid.sha256;
  assert.throws(() => validateFigureSpec(invalid));
  fig.dispose();
});

test('cancellation during final hashing keeps the exact reason and publishes no state', async (t) => {
  const fig = Figure.attach(engine(), { axes: false });
  const controller = new AbortController(),
    reason = new Error('abort final state hash');
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  const hook = t.mock.method(crypto.subtle, 'digest', async (...args) => {
    controller.abort(reason);
    return digest(...args);
  });
  try {
    await assert.rejects(fig.toJSON({ signal: controller.signal }), (error) => error === reason);
  } finally {
    hook.mock.restore();
    fig.dispose();
  }
});

test('URL saves verify the plotted array still matches its pinned source', async () => {
  const bytes = new Uint8Array(new Float32Array([1, 2]).buffer);
  const source = {
    url: `data:application/octet-stream;base64,${Buffer.from(bytes).toString('base64')}`,
    dtype: 'Float32Array',
    length: 2,
    sha256: await specHash(bytes),
  };
  const data = await loadSpecData(source),
    fig = Figure.attach(engine(), { axes: false });
  const codec = {
    create(f) {
      return f.addLayer({ bounds: [0, 1, 0, 1, 0, 1], setModel() {}, dispose() {} });
    },
  };
  await fig.recipe('test.url', [data], codec);
  assert.deepEqual((await fig.toJSON({ data: 'url' })).resources[0].args[0], { $url: source });
  fig.dispose();
  data[0] = 99;
  const changed = Figure.attach(engine(), { axes: false });
  await changed.recipe('test.url', [data], codec);
  await assert.rejects(changed.toJSON({ data: 'url' }), /Pinned array changed/);
  assert.equal((await decodeFigureValue((await changed.toJSON()).resources[0].args[0]))[0], 99);
  changed.dispose();
});

test('URL arrays type-check as numeric inputs without casts', () => {
  const root = fileURLToPath(new URL('../../..', import.meta.url));
  execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '--strict', '--skipLibCheck', '--target', 'es2022', '--lib', 'es2022,dom,esnext.disposable', '--module', 'esnext', '--moduleResolution', 'bundler', 'packages/sciviz/tests/spec-types.ts'], {cwd:root,timeout:30000,stdio:'pipe',windowsHide:true});
});
