import test, { afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import React, { StrictMode, createRef } from 'react';
import { JSDOM } from 'jsdom';

const created = [];
class Plugin {
  constructor(options = {}) {
    this.options = options;
    this.name = options.name ?? `binding:${created.length}`;
    this.items = new Set();
    this.disposed = false;
    created.push(this);
  }
  add(item, levels) {
    if (levels) {
      if (levels.some((level) => !Number.isFinite(level.distance))) throw new RangeError('Invalid LOD distance');
      const lod = { anchor: item, levels, remove: () => this.items.delete(lod) };
      this.items.add(lod);
      return lod;
    }
    this.items.add(item);
    return item;
  }
  set(items) {
    this.selected = [...items];
  }
  dispose() {
    this.disposed = true;
  }
}
class LineHandle {
  constructor(options) {
    Object.assign(this, options);
  }
  dispose() {
    this.disposed = true;
  }
  attach(mesh) {
    this.attachedMesh = mesh;
  }
}
mock.module('@margoengine/lines', { namedExports: { Line: LineHandle, Lines: Plugin } });
mock.module('@margoengine/points', { namedExports: { PointCloud: LineHandle, PointsPlugin: Plugin } });
mock.module('@margoengine/selection', { namedExports: { Selection: Plugin } });
mock.module('@margoengine/splats', { namedExports: { Splats: Plugin } });
mock.module('@margoengine/lod', { namedExports: { LODSystem: Plugin } });
mock.module('@margoengine/viewcube', {
  namedExports: {
    ViewCube: class extends Plugin {
      static attach(engine, options) {
        const value = new this(options);
        engine.use(value);
        value.engine = engine;
        return value;
      }
      dispose() {
        super.dispose();
        this.engine.plugins.delete(this.name);
      }
    },
  },
});
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { render, cleanup, act } = await import('@testing-library/react');
const { Context } = await import('../dist/internal.js');
const { Camera } = await import('@margoengine/core');
const { Line } = await import('../dist/lines.js');
const { Points } = await import('../dist/points.js');
const { Outline } = await import('../dist/selection.js');
const { Splat } = await import('../dist/splats.js');
const { Detailed } = await import('../dist/lod.js');
const { GizmoHelper } = await import('../dist/viewcube.js');
const { PerspectiveCamera, OrthographicCamera } = await import('../dist/cameras.js');
const h = React.createElement;
const scenes = [];
function scene() {
  const engine = {
    camera: new Camera(),
    disposed: false,
    plugins: new Map(),
    meshes: new Map(),
    next: 1,
    onError(error) {
      throw error;
    },
    use(plugin) {
      assert.equal(this.plugins.has(plugin.name), false);
      this.plugins.set(plugin.name, plugin);
    },
    removePlugin(name) {
      this.plugins.get(name)?.dispose();
      this.plugins.delete(name);
    },
    createMesh() {
      const mesh = {
        engine: this,
        id: this.next++,
        visible: true,
        position: {},
        rotation: {},
        scale: {},
        setPosition(v) {
          this.position = v;
        },
        setRotation(v) {
          this.rotation = v;
        },
        setScale(v) {
          this.scale = v;
        },
        setParent(v) {
          this.parent = v;
        },
        dispose() {
          engine.meshes.delete(this.id);
        },
      };
      this.meshes.set(mesh.id, mesh);
      return mesh;
    },
  };
  const value = {
    engine,
    world: null,
    registry: null,
    cameraOverrides: new Set(),
    pointerHandlers: new Map(),
    resources: { models: new Set(), lighting: new Map() },
    frames: { callbacks: new Set() },
    shadows: null,
  };
  scenes.push(value);
  return value;
}
const tree = (s, children) => h(StrictMode, null, h(Context.Provider, { value: s }, children));
const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 15));
  });
afterEach(async () => {
  cleanup();
  await flush();
  for (const s of scenes) {
    assert.equal(s.engine.plugins.size, 0);
    assert.equal(s.frames.callbacks.size, 0);
    assert.equal(s.engine.meshes.size, 0);
  }
  scenes.length = 0;
  assert.ok(created.every((p) => p.disposed));
});
test('native bindings attach independently in their owning Scene and clean up StrictMode refs', async () => {
  const s = scene(),
    world = { plugins: new Map(), use: s.engine.use, removePlugin: s.engine.removePlugin };
  s.world = world;
  const refs = Array.from({ length: 4 }, () => createRef());
  const points = [
      [-1, 0, 0],
      [1, 0, 0],
    ],
    positions = new Float32Array([0, 0, 0]);
  const view = render(
    tree(s, [
      h(Line, { key: 'l', ref: refs[0], points, lineWidth: 4, dashed: true }),
      h(Points, { key: 'p', ref: refs[1], positions, material: { size: 12 } }),
      h(Outline, { key: 'o', ref: refs[2], selection: [], width: 6 }),
      h(Splat, { key: 's', ref: refs[3], data: { positions }, antialias: true }),
    ]),
  );
  await flush();
  assert.equal(s.engine.plugins.size, 0);
  assert.equal(world.plugins.size, 4);
  assert.deepEqual(refs[0].current.positions, [-1, 0, 0, 1, 0, 0]);
  assert.equal(refs[0].current.width, 4);
  assert.equal(refs[0].current.dashed, true);
  assert.equal(refs[1].current.positions, positions);
  assert.equal(refs[3].current.antialias, true);
  view.unmount();
  await flush();
  assert.equal(world.plugins.size, 0);
  assert.ok(refs.every((r) => r.current === null));
});
test('Outline resolves refs after mount and follows a changed selection on each frame', async () => {
  const s = scene(),
    selected = createRef(),
    ref = createRef(),
    mesh = { id: 8 };
  render(tree(s, h(Outline, { ref, selection: [selected] })));
  await flush();
  assert.deepEqual(ref.current.selected, []);
  selected.current = mesh;
  for (const callback of s.frames.callbacks) callback(s.engine, 0);
  assert.deepEqual(ref.current.selected, [mesh]);
  selected.current = null;
  for (const callback of s.frames.callbacks) callback(s.engine, 0);
  assert.deepEqual(ref.current.selected, []);
});
test('line and point bindings follow their enclosing mesh unless given an explicit transform', async () => {
  const s = scene(),
    mesh = { id: 9 },
    line = createRef(),
    points = createRef();
  s.registry = { current: mesh };
  const positions = new Float32Array([0, 0, 0, 1, 0, 0]);
  const view = render(
    tree(s, [h(Line, { key: 'l', ref: line, points: positions }), h(Points, { key: 'p', ref: points, positions })]),
  );
  await flush();
  assert.equal(line.current.mesh, mesh);
  assert.equal(points.current.attachedMesh, mesh);
  const matrix = new Float32Array(16);
  view.rerender(
    tree(s, [
      h(Line, { key: 'l', ref: line, points: positions, mesh: null }),
      h(Points, { key: 'p', ref: points, positions, matrix }),
    ]),
  );
  await flush();
  assert.equal(line.current.mesh, null);
  assert.equal(points.current.attachedMesh, undefined);
});
test('Detailed passes stable child groups and hysteresis to the native LOD system', async () => {
  const s = scene(),
    ref = createRef();
  const view = render(
    tree(s, h(Detailed, { ref, distances: [0, 10], hysteresis: 0.2 }, h('i', { key: 'a' }), h('i', { key: 'b' }))),
  );
  await flush();
  assert.deepEqual(
    ref.current.levels.map((l) => l.distance),
    [0, 10],
  );
  assert.equal(ref.current.levels[0].object.parent, ref.current.anchor);
  const old = ref.current;
  view.rerender(tree(s, h(Detailed, { ref, distances: [0, 20] }, h('i', { key: 'a' }), h('i', { key: 'b' }))));
  await flush();
  assert.notEqual(ref.current, old);
  assert.deepEqual(
    ref.current.levels.map((l) => l.distance),
    [0, 20],
  );
});
test('GizmoHelper exposes the native widget and disposes it when its options change', async () => {
  const s = scene(),
    ref = createRef();
  const view = render(tree(s, h(GizmoHelper, { ref, corner: 'bottom-left', roll: true })));
  await flush();
  const old = ref.current;
  assert.equal(old.options.corner, 'bottom-left');
  assert.equal(old.options.roll, true);
  view.rerender(tree(s, h(GizmoHelper, { ref, size: 96 })));
  await flush();
  assert.equal(old.disposed, true);
  assert.equal(ref.current.options.size, 96);
});
test('camera defaults update, nest, and restore through an underlying mount removed first', async () => {
  const s = scene(),
    ref = createRef(),
    base = s.engine.camera,
    original = base.position;
  const view = render(tree(s, h(PerspectiveCamera, { key: 'a', makeDefault: true, position: [1, 2, 6], ref })));
  assert.equal(ref.current, base);
  assert.deepEqual(base.position, [1, 2, 6]);
  view.rerender(
    tree(s, [
      h(PerspectiveCamera, { key: 'a', makeDefault: true, position: [2, 2, 6] }),
      h(PerspectiveCamera, { key: 'b', makeDefault: true, position: [3, 2, 6] }),
    ]),
  );
  assert.deepEqual(base.position, [3, 2, 6]);
  view.rerender(tree(s, h(PerspectiveCamera, { key: 'b', makeDefault: true, position: [3, 2, 6] })));
  assert.deepEqual(base.position, [3, 2, 6]);
  view.unmount();
  assert.equal(base.position, original);
  assert.equal(s.cameraOverrides.size, 0);
});
test('orthographic defaults use native projection, restore perspective and non-default cameras stay independent', async () => {
  const s = scene(),
    ref = createRef(),
    independent = createRef(),
    base = s.engine.camera;
  const view = render(
    tree(s, [
      h(OrthographicCamera, { key: 'o', ref, makeDefault: true, height: 4, zoom: 2, position: [0, 0, 5] }),
      h(PerspectiveCamera, { key: 'p', ref: independent, position: [0, 0, 10] }),
    ]),
  );
  await flush();
  assert.equal(ref.current, base);
  assert.notEqual(independent.current, base);
  base.update(1, true);
  assert.equal(base.matrix[15], 1);
  assert.equal(base.matrix[11], 0);
  assert.equal(base.matrix[5], 1);
  view.unmount();
  await flush();
  assert.equal(base.project, undefined);
  assert.equal(ref.current, null);
  assert.equal(independent.current, null);
});
test('camera rerenders preserve control movement and restore the latest underlying camera props', () => {
  const s = scene(),
    ref = createRef(),
    base = s.engine.camera;
  const camera = (key, position) => h(PerspectiveCamera, { key, makeDefault: true, position });
  const view = render(tree(s, camera('a', [1, 2, 6])));
  base.position = [7, 2, 6];
  view.rerender(tree(s, camera('a', [1, 2, 6])));
  assert.deepEqual(base.position, [7, 2, 6], 'an unrelated rerender keeps control movement');
  view.rerender(tree(s, [camera('a', [1, 2, 6]), camera('b', [3, 2, 6])]));
  view.rerender(tree(s, [camera('a', [2, 2, 6]), camera('b', [3, 2, 6])]));
  view.rerender(tree(s, h(PerspectiveCamera, { key: 'a', makeDefault: true, position: [2, 2, 6], ref })));
  assert.deepEqual(base.position, [2, 2, 6]);
  assert.equal(ref.current, base);
});
test('orthographic framing tracks control dolly through the stable default handle', async () => {
  const s = scene(),
    base = s.engine.camera;
  render(tree(s, h(OrthographicCamera, { makeDefault: true, position: [0, 0, 5] })));
  await flush();
  base.update(1, true);
  const before = base.matrix[0];
  base.position = [0, 0, 10];
  base.update(1, true);
  assert.equal(base.matrix[0], before / 2);
});
test('default orthographic cameras preserve native control metadata and vertical projection in the same frame', async () => {
  const s = scene(),
    base = s.engine.camera;
  const view = render(tree(s, h(OrthographicCamera, { makeDefault: true, height: 4, position: [0, 0, 5] })));
  await flush();
  assert.equal(base.fixedOrthographic, true, 'native controls must see the fixed-size projection');
  base.position = [0, 5, 0];
  base.update(1, true);
  assert.deepEqual(base.up, [0, 0, -1]);
  assert.ok([...base.matrix].every(Number.isFinite));
  view.unmount();
  await flush();
  assert.equal(base.fixedOrthographic, undefined);
});
test('invalid native LOD registration reports the error and rolls back its attached system', async () => {
  const s = scene(),
    errors = [];
  s.engine.onError = (e) => errors.push(e);
  render(tree(s, h(Detailed, { distances: [0, NaN] }, h('i', { key: 'a' }), h('i', { key: 'b' }))));
  await flush();
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /Invalid LOD distance/);
  assert.equal(s.engine.plugins.size, 0);
});
test('changing orthographic projection options and makeDefault never reattaches a superseded projection', async () => {
  const s = scene(),
    ref = createRef(),
    base = s.engine.camera;
  const child = (zoom, makeDefault) =>
    h(OrthographicCamera, { ref, height: 4, zoom, makeDefault, position: [0, 0, 5] });
  const view = render(tree(s, child(1, true)));
  await flush();
  base.update(1, true);
  assert.equal(base.matrix[0], 0.5);
  view.rerender(tree(s, child(2, true)));
  await flush();
  base.update(1, true);
  assert.equal(base.matrix[0], 1);
  view.rerender(tree(s, child(2, false)));
  await flush();
  assert.equal(base.project, undefined);
  assert.notEqual(ref.current, base);
  ref.current.update(1, true);
  assert.equal(ref.current.matrix[0], 1);
  view.rerender(tree(s, child(2, true)));
  await flush();
  assert.equal(ref.current, base);
  base.update(1, true);
  assert.equal(base.matrix[0], 1);
});
