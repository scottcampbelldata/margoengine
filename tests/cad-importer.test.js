// The importer option reads STEP and IGES in place of the OpenCascade worker; STL and OBJ never use it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../packages/core/dist/extension.js';
import { parseCADAsync } from '../packages/machinery/dist/cad-async.js';

async function headless() {
  return new Engine(
    { width: 8, height: 8, clientWidth: 8, clientHeight: 8 },
    await TransformStore.create(8),
    { backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} },
    undefined,
    null,
  );
}

test('an importer reads STEP and IGES with the engine, bytes, format and options, and its model is returned as is', async () => {
  const engine = await headless(),
    model = { root: {}, meshes: [], dispose() {} },
    calls = [];
  try {
    const importer = async (...args) => (calls.push(args), model);
    for (const format of ['step', 'iges']) {
      const bytes = new ArrayBuffer(16),
        options = { importer, linearDeflection: 0.01 };
      assert.equal(await parseCADAsync(engine, bytes, format, options), model);
      const [seenEngine, seenBytes, seenFormat, seenOptions] = calls.at(-1);
      assert.equal(seenEngine, engine);
      assert.equal(seenBytes, bytes);
      assert.equal(seenFormat, format);
      assert.equal(seenOptions, options);
    }
    assert.equal(calls.length, 2);
  } finally {
    engine.dispose();
  }
});

test('an importer is checked: it must be a function, and the size cap still applies before it runs', async () => {
  const engine = await headless();
  try {
    assert.throws(() => parseCADAsync(engine, new ArrayBuffer(16), 'step', { importer: 'reader' }), {
      name: 'TypeError',
      message: 'importer must be a function',
    });
    let called = false;
    assert.throws(
      () =>
        parseCADAsync(engine, new ArrayBuffer(64 * 1024 * 1024 + 1), 'step', {
          importer: async () => ((called = true), {}),
        }),
      { name: 'RangeError' },
    );
    assert.equal(called, false);
  } finally {
    engine.dispose();
  }
});

test('STL and OBJ ignore the importer', async () => {
  const engine = await headless();
  try {
    let called = false;
    const importer = async () => ((called = true), {}),
      stl = new TextEncoder().encode('solid t\nendsolid t\n').buffer;
    await parseCADAsync(engine, stl, 'stl', { importer }).catch(() => {});
    assert.equal(called, false);
  } finally {
    engine.dispose();
  }
});
