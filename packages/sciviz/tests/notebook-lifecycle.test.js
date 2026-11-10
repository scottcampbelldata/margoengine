import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
const spec = await import('@margoengine/sciviz/spec');
const pending = [];
mock.module('@margoengine/sciviz/spec', {
  namedExports: {
    ...spec,
    Figure: { fromJSON: (...args) => new Promise((resolve) => pending.push({ args, resolve })) },
  },
});
const { render } = await import('@margoengine/sciviz/notebook');

test('superseded and aborted AFM loads dispose late figures and remove every model listener', async () => {
  const previous = globalThis.document;
  globalThis.document = { createElement: () => ({ style: {}, setAttribute() {} }) };
  try {
    const state = {
      spec: {
        version: 1,
        options: {},
        limits: [0, 1, 0, 1, 0, 1],
        dragMode: 'orbit',
        resources: [],
        layers: [],
        camera: { position: [2, 2, 2], target: [0, 0, 0], up: [0, 1, 0], near: 0.01, far: 100, fov: 45 },
      },
      buffers: {},
      backend: 'webgpu',
    };
    const events = new Map(),
      model = {
        get: (key) => state[key],
        set: (key, value) => {
          state[key] = value;
          for (const f of events.get(`change:${key}`) ?? []) f();
        },
        save_changes() {},
        on: (key, f) => events.set(key, [...(events.get(key) ?? []), f]),
        off: (key, f) =>
          events.set(
            key,
            (events.get(key) ?? []).filter((x) => x !== f),
          ),
      };
    const el = Object.assign(new EventTarget(), {
      style: {},
      children: [],
      replaceChildren(...children) {
        this.children = children;
      },
    });
    const signal = new AbortController();
    const first = render({ model, el, signal: signal.signal });
    assert.equal(pending.length, 1);
    model.set('spec', { ...state.spec, options: { axes: false } });
    assert.equal(pending.length, 2);
    assert.equal(pending[0].args[2].signal.aborted, true);
    const figure = () =>
      Object.assign(new EventTarget(), {
        layers: [],
        disposed: 0,
        setSelection() {},
        dispose() {
          ++this.disposed;
        },
      });
    const stale = figure();
    pending[0].resolve(stale);
    const dispose = await first;
    assert.equal(stale.disposed, 1);
    signal.abort();
    const late = figure();
    pending[1].resolve(late);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(late.disposed, 1);
    assert.equal(el.children.length, 0);
    assert.equal([...events.values()].flat().length, 0);
    dispose();
    assert.equal(late.disposed, 1);
    // Invalid live updates must close their engine before the error replaces its canvas.
    const second = render({ model, el });
    const live = figure();
    live.controls = new EventTarget();
    live.engine = { camera: state.spec.camera };
    pending[2].resolve(live);
    const close = await second;
    model.set('height', 99);
    assert.equal(live.disposed, 1);
    assert.match(state.error, /height/);
    close();
    state.height = 360;
    state.camera = state.spec.camera;
    let ready = 0;
    el.addEventListener('margo-notebook-ready', () => ++ready);
    const third = render({ model, el });
    const superseded = figure();
    superseded.engine = { camera: { ...state.spec.camera } };
    pending[3].resolve(superseded);
    // Supersede specifically during the camera application's promise continuation.
    queueMicrotask(() => model.set('spec', { ...state.spec }));
    const finish = await third;
    assert.equal(superseded.disposed, 1);
    assert.equal(ready, 0);
    const current = figure();
    current.engine = { camera: { ...state.spec.camera } };
    pending[4].resolve(current);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ready, 1);
    finish();
    assert.equal(current.disposed, 1);
  } finally {
    globalThis.document = previous;
  }
});
