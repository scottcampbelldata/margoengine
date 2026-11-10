import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
const specModule = await import('@margoengine/sciviz/spec');
const reached = new Error('figure load reached');
let loads = 0;
mock.module('@margoengine/sciviz/spec', { namedExports: { ...specModule, Figure: {
  fromJSON: async () => { ++loads; throw reached; },
} } });
const rawNotebook = await import('@margoengine/sciviz/notebook');
const rawShare = await import('@margoengine/sciviz/share');
const spec = {
  version: 1, options: {}, limits: [0, 1, 0, 1, 0, 1], dragMode: 'orbit', resources: [], layers: [],
  camera: { position: [2, 2, 2], target: [0, 0, 0], up: [0, 1, 0], near: 0.01, far: 100, fov: 45 },
};
test('raw and forwarding hosts refuse an unprepared explicit backend before figure creation', async () => {
  const previous = globalThis.document;
  let backend;
  globalThis.document = {
    createElement: () => ({ style: {}, setAttribute() {} }),
    getElementById: () => ({ textContent: JSON.stringify({ spec, view: {}, backend }) }),
    querySelector: () => ({}),
  };
  const invoke = (module, options = {}) => module.render
    ? module.render({ ...options, model: { get: (key) => ({ spec, backend })[key], on() {}, off() {} },
      el: { style: {}, replaceChildren() {} } })
    : module.startStandalone(options);
  try {
    for (const module of [rawNotebook, rawShare]) {
      backend = 'webgl2';
      const before = loads;
      await assert.rejects(invoke(module), (e) => e.code === 'unsupported' && /prepareBackend/.test(e.message)
        && /https:\/\/margoengine.com\/errors#sciviz/.test(e.message));
      assert.equal(loads, before, 'must not silently create a native device');
    }
    for (const module of [rawNotebook, rawShare, await import('margoengine/sciviz/notebook'), await import('margoengine/sciviz/share')]) {
      backend = 'webgl2';
      await assert.rejects(invoke(module), (e) => e.code === 'unsupported' && /prepareBackend/.test(e.message));
      let custom = 0;
      await assert.rejects(invoke(module, { prepareBackend: async ({ force }) => { ++custom; assert.equal(force, true); } }),
        (e) => e === reached);
      assert.equal(custom, 1);
    }
  } finally { globalThis.document = previous; }
});
