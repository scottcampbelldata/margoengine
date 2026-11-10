import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
const specModule = await import('@margoengine/sciviz/spec');
const reached = new Error('figure load reached');
const loads = [];
mock.module('@margoengine/sciviz/spec', {
  namedExports: {
    ...specModule,
    Figure: {
      fromJSON: async (...args) => {
        loads.push(args);
        throw reached;
      },
    },
  },
});
const { render } = await import('@margoengine/sciviz/notebook');
const { startStandalone } = await import('@margoengine/sciviz/share');
const spec = {
  version: 1,
  options: {},
  limits: [0, 1, 0, 1, 0, 1],
  dragMode: 'orbit',
  resources: [],
  layers: [],
  camera: { position: [2, 2, 2], target: [0, 0, 0], up: [0, 1, 0], near: 0.01, far: 100, fov: 45 },
};

for (const host of ['notebook', 'standalone'])
  test(`${host} uses only the host backend setup and propagates aborts and errors`, async () => {
    const previous = globalThis.document;
    let backend;
    globalThis.document = {
      createElement: () => ({ style: {}, setAttribute() {} }),
      getElementById: () => ({ textContent: JSON.stringify({ spec, view: {}, backend }) }),
      querySelector: () => ({}),
    };
    const invoke = (prepareBackend, signal) =>
      host === 'standalone'
        ? startStandalone({ prepareBackend, signal })
        : render({
            prepareBackend,
            signal,
            model: { get: (key) => ({ spec, backend })[key], on() {}, off() {} },
            el: { style: {}, replaceChildren() {} },
          });
    try {
      for (backend of ['auto', 'webgpu', 'webgl2']) {
        const calls = [];
        const before = loads.length;
        await assert.rejects(
          invoke(async (options) => {
            calls.push(options);
            assert.equal(loads.length, before);
          }),
          (e) => e === reached,
        );
        assert.equal(loads.length, before + 1);
        assert.equal(calls.length, backend === 'webgpu' ? 0 : 1);
        if (calls.length) assert.equal(calls[0].force, backend === 'webgl2');
        assert.equal('prepareBackend' in loads.at(-1)[2], false);
      }
      backend = 'auto';
      await assert.rejects(invoke(), (e) => e === reached);
      const failure = new Error('host backend refused');
      const before = loads.length;
      await assert.rejects(
        invoke(async () => {
          throw failure;
        }),
        (e) => e === failure,
      );
      assert.equal(loads.length, before);
      const controller = new AbortController();
      const cancelled = invoke(async ({ signal }) => {
        assert.equal(signal.aborted, false);
        controller.abort(failure);
      }, controller.signal);
      if (host === 'notebook') (await cancelled)();
      else await assert.rejects(cancelled, (e) => e === failure);
      assert.equal(loads.length, before);
      await assert.rejects(
        invoke(async () => {
          assert.fail('aborted setup ran');
        }, controller.signal),
        (e) => e === failure,
      );
    } finally {
      globalThis.document = previous;
    }
  });
