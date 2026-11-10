import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { LinkedCameras, volumeSlice, FigureLayout, ComparativeGrid } from '../dist/views.js';
const linear = { type: 'linear', forward: (v) => v, inverse: (v) => v };
function figure(is2d = false, bounds = [0, 10, 0, 20, 0, 30], origin = 0) {
  const callbacks = new Set(),
    controls = new EventTarget();
  let limits = [...bounds],
    disposed = 0;
  const f = {
    is2d,
    controls,
    axisScales: [
      origin ? { type: 'date', forward: (v) => v - origin, inverse: (v) => v + origin } : linear,
      linear,
      linear,
    ],
    get bounds() {
      return [...limits];
    },
    setLimits(b) {
      limits = [...b];
    },
    engine: {
      camera: { position: [2, 3, 4], target: [0, 0, 0], up: [0, 1, 0], fov: 60, near: 0.1, far: 100 },
      onFrame(cb) {
        callbacks.add(cb);
        return () => callbacks.delete(cb);
      },
    },
    ready: async () => {},
    dispose() {
      disposed++;
    },
    get disposed() {
      return disposed;
    },
    frame() {
      for (const cb of callbacks) cb();
    },
    get callbacks() {
      return callbacks.size;
    },
  };
  return f;
}
test('bidirectional camera links transfer complete pose, avoid echoes and remove all callbacks', () => {
  const a = figure(),
    b = figure(),
    c = figure();
  using link = new LinkedCameras([a, b, c]);
  let changes = 0;
  link.addEventListener('change', () => changes++);
  a.engine.camera.position = [6, 7, 8];
  a.engine.camera.fov = 40;
  a.frame();
  assert.deepEqual(b.engine.camera.position, [6, 7, 8]);
  assert.equal(c.engine.camera.fov, 40);
  assert.notEqual(b.engine.camera.position, a.engine.camera.position);
  b.frame();
  c.frame();
  assert.equal(changes, 1);
  c.engine.camera.target = [1, 2, 3];
  c.controls.dispatchEvent(new Event('change'));
  assert.deepEqual(a.engine.camera.target, [1, 2, 3]);
  assert.equal(changes, 2);
  link.dispose();
  assert.equal(a.callbacks + b.callbacks + c.callbacks, 0);
  assert.throws(() => link.sync(), { code: 'disposed' });
  assert.equal(a.disposed, 0);
});
test('2D linking transfers physical date coordinates across different origins and selected axes only', () => {
  const a = figure(true, [0, 10, 5, 20, -1, 1], 1000),
    b = figure(true, [0, 5, 70, 90, -1, 1], 900);
  using link = new LinkedCameras([a, b], { axes: ['x'] });
  assert.deepEqual(b.bounds, [100, 110, 70, 90, -1, 1]);
  a.setLimits([20, 30, 6, 10, -1, 1]);
  a.frame();
  assert.deepEqual(b.bounds, [120, 130, 70, 90, -1, 1]);
  b.setLimits([140, 150, 70, 90, -1, 1]);
  b.frame();
  assert.deepEqual(a.bounds, [40, 50, 6, 10, -1, 1]);
});
test('links validate before installing callbacks and AbortSignal disposes links', () => {
  const a = figure(),
    b = figure();
  assert.throws(() => new LinkedCameras([a, a]));
  assert.throws(() => new LinkedCameras([a, figure(true)]));
  assert.throws(() => new LinkedCameras([a, b], { axes: ['q'] }));
  assert.equal(a.callbacks, 0);
  const abort = new AbortController();
  new LinkedCameras([a, b], { signal: abort.signal });
  abort.abort();
  assert.equal(a.callbacks + b.callbacks, 0);
  assert.throws(() => new LinkedCameras([a, b], { signal: abort.signal }), { name: 'AbortError' });
});
test('orthogonal slices retain exact voxel IDs, physical spacing and descending endpoint orientation', () => {
  const volume = {
    dims: [3, 4, 2],
    bounds: [10, 6, 20, 32, -4, 4],
    data: Float64Array.from({ length: 24 }, (_, i) => i),
  };
  const x = volumeSlice(volume, 'x', 8);
  assert.equal(x.index, 1);
  assert.equal(x.nx, 4);
  assert.equal(x.ny, 2);
  assert.deepEqual([...x.indices], [1, 4, 7, 10, 13, 16, 19, 22]);
  assert.deepEqual(x.x, [20, 32]);
  assert.deepEqual(x.y, [-4, 4]);
  const y = volumeSlice(volume, 'y', 32);
  assert.deepEqual([...y.data], [9, 10, 11, 21, 22, 23]);
  assert.deepEqual(y.x, [10, 6]);
  assert.deepEqual(y.axes, [0, 2]);
  const z = volumeSlice(volume, 'z', 1e9);
  assert.equal(z.index, 1);
  assert.equal(z.position, 4);
  assert.deepEqual(
    [...z.indices],
    Array.from({ length: 12 }, (_, i) => i + 12),
  );
  assert.throws(() => volumeSlice({ ...volume, data: new Float32Array(2) }, 'z', 0));
  assert.throws(() => volumeSlice(volume, 'z', NaN));
  assert.throws(() => volumeSlice(volume, 'q', 0));
});
test('comparative cells run one immutable graph at independent times and parameters and release their outputs', async () => {
  const dom = new JSDOM('<div id="views"></div>');
  const old = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    const container = document.querySelector('#views'),
      definition = {
        version: 1,
        nodes: [
          { id: 'input', type: 'source' },
          { id: 'output', type: 'scale', inputs: ['input'], params: 2 },
        ],
      };
    let releases = 0;
    const registry = {
      source: { kind: 'source', timeDependent: true, execute: ({ time }) => time + 1 },
      scale: { kind: 'filter', execute: ({ inputs, params }) => inputs[0] * params, release: () => releases++ },
    };
    const made = [],
      drawn = [];
    const grid = await ComparativeGrid.create(container, definition, registry, {
      cells: [{ time: 0 }, { time: 3, params: { output: 4 } }],
      target: 'output',
      linked: false,
      createFigure: async () => {
        const f = figure();
        made.push(f);
        return f;
      },
      draw: (_f, output) => drawn.push(output),
    });
    assert.deepEqual(drawn, [2, 16]);
    assert.equal(definition.nodes[1].params, 2);
    assert.equal(grid.layout.canvases.length, 2);
    assert.equal(grid.pipelines[1].toJSON().nodes[1].params, 4);
    grid.dispose();
    assert.equal(releases, 2);
    assert.ok(made.every((f) => f.disposed === 1));
    assert.equal(container.children.length, 0);
  } finally {
    globalThis.document = old;
    dom.window.close();
  }
});
test('layout creation is transactional on factory failure or cancellation and preserves unrelated DOM', async () => {
  const dom = new JSDOM('<div id="views"><p>Keep</p></div>');
  const old = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    const container = document.querySelector('#views'),
      made = [];
    await assert.rejects(
      FigureLayout.create(container, 3, {
        createFigure: async (_c, _o, i) => {
          if (i === 1) throw new Error('factory failure');
          const f = figure();
          made.push(f);
          return f;
        },
      }),
      /factory failure/,
    );
    assert.equal(made[0].disposed, 1);
    assert.equal(container.children.length, 1);
    const abort = new AbortController();
    await assert.rejects(
      FigureLayout.create(container, 2, {
        signal: abort.signal,
        createFigure: async () => {
          const f = figure();
          made.push(f);
          abort.abort();
          return f;
        },
      }),
      { name: 'AbortError' },
    );
    assert.equal(made[1].disposed, 1);
    assert.equal(container.children.length, 1);
  } finally {
    globalThis.document = old;
    dom.window.close();
  }
});
