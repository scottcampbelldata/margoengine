import { assertCore, coreRequirement } from '../../core/dist/version.js';
import test, { afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import React, { StrictMode, createRef } from 'react';
import { JSDOM } from 'jsdom';

const scenes = [],
  geometries = [],
  skies = [],
  pointers = [],
  gizmos = [],
  drags = [],
  renderers = [],
  texts = [];
const identity = () => Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
class Material {
  constructor(options = {}) {
    this.options = options;
  }
}
class Node {
  constructor(engine) {
    this.engine = engine;
    this.id = engine.next++;
    this.position = { x: 0, y: 0, z: 0 };
    this.rotation = { x: 0, y: 0, z: 0 };
    this.scale = { x: 1, y: 1, z: 1 };
    this.matrix = identity();
    this.visible = true;
    this.geometry = null;
    engine.meshes.set(this.id, this);
    engine.store.parents[this.id] = -1;
  }
  check() {
    assert.equal(this.engine.meshes.get(this.id), this);
  }
  setPosition([x, y, z]) {
    Object.assign(this.position, { x, y, z });
    return this;
  }
  setQuaternion(value) {
    const length = Math.hypot(...value);
    this.quaternion = value.map((v) => v / length);
    return this;
  }
  setRotation([x, y, z]) {
    Object.assign(this.rotation, { x, y, z });
    return this;
  }
  setScale([x, y, z]) {
    Object.assign(this.scale, { x, y, z });
    return this;
  }
  setGeometry(value) {
    this.geometry = value;
    return this;
  }
  setMaterial(value) {
    this.material = value;
    return this;
  }
  setParent(value) {
    this.engine.store.parents[this.id] = value?.id ?? -1;
    return this;
  }
  dispose() {
    this.engine.meshes.delete(this.id);
  }
}
mock.module('@margoengine/core/extension', {
  namedExports: {
    assertCore,
    coreRequirement,
    meshRuntime: (mesh) => mesh,
    Engine: {},
    Mesh: Node,
    PbrMaterial: Material,
    box: () => ({}),
  },
});
mock.module('@margoengine/geometry', {
  namedExports: {
    boxGeometry: (...args) => ({ kind: 'box', args }),
    sphereGeometry: (...args) => ({ kind: 'sphere', args }),
    planeGeometry: (...args) => ({ kind: 'plane', args }),
    ...Object.fromEntries(
      [
        'cylinder',
        'cone',
        'capsule',
        'circle',
        'ring',
        'torus',
        'torusKnot',
        'tetrahedron',
        'octahedron',
        'icosahedron',
        'dodecahedron',
        'polyhedron',
        'lathe',
        'tube',
        'shape',
        'extrude',
      ].map((kind) => [`${kind}Geometry`, (...args) => ({ kind, args })]),
    ),
    toGeometry(data) {
      const geometry = { ...data, vertices: Float32Array.from([-1, 0, -1, 0, 1, 0, 1, 0, 1, 0, 1, 0]) };
      geometries.push(geometry);
      return geometry;
    },
  },
});
mock.module('@margoengine/geometry/extras', {
  namedExports: { roundedBoxGeometry: (...args) => ({ kind: 'roundedBox', args }) },
});
class Events {
  constructor() {
    this.events = new Map();
    this.disposals = 0;
  }
  addEventListener(kind, callback) {
    let callbacks = this.events.get(kind);
    if (!callbacks) this.events.set(kind, (callbacks = new Set()));
    callbacks.add(callback);
  }
  removeEventListener(kind, callback) {
    this.events.get(kind)?.delete(callback);
  }
  emit(kind) {
    for (const callback of this.events.get(kind) ?? []) callback({ type: kind });
  }
  dispose() {
    if (this.disposals) return;
    this.disposals++;
    this.events.clear();
  }
}
const controlsExports = {
  PointerLockControls: class extends Events {
    constructor(engine, canvas) {
      super();
      this.engine = engine;
      this.canvas = canvas;
      this.enabled = true;
      this.isLocked = false;
      this.updates = [];
      pointers.push(this);
      if (engine.use) {
        this.pluginName = 'test-pointer-' + pointers.length;
        engine.use({
          name: this.pluginName,
          onPreUpdate: (delta) => this.update(delta),
          dispose: () => this.dispose(),
        });
      }
    }
    dispose() {
      if (this.disposals) return;
      super.dispose();
      if (this.pluginName) this.engine.removePlugin(this.pluginName);
    }
    lock() {
      this.isLocked = true;
      this.emit('lock');
    }
    unlock() {
      this.isLocked = false;
      this.emit('unlock');
    }
    update(delta) {
      this.updates.push(delta);
    }
  },
  TransformControls: class extends Events {
    constructor(engine, options) {
      super();
      this.engine = engine;
      this.options = options;
      this.object = null;
      gizmos.push(this);
    }
    attach(mesh) {
      mesh.check();
      this.object = mesh;
      return this;
    }
    detach() {
      this.object = null;
      return this;
    }
    setMode(value) {
      this.mode = value;
    }
    setSpace(value) {
      this.space = value;
    }
    setSize(value) {
      this.size = value;
    }
    setTranslationSnap(value) {
      this.translationSnap = value;
    }
    setRotationSnap(value) {
      this.rotationSnap = value;
    }
    setScaleSnap(value) {
      this.scaleSnap = value;
    }
    setPivot(value) {
      this.pivot = value;
    }
  },
};
mock.module('@margoengine/controls', { namedExports: controlsExports });
mock.module('@margoengine/controls/transform', { namedExports: controlsExports });
mock.module('@margoengine/controls/drag', {
  namedExports: {
    DragControls: class extends Events {
      constructor(engine, objects, options) {
        super();
        Object.assign(this, { engine, objects, options, enabled: true });
        drags.push(this);
      }
    },
  },
});
mock.module('@margoengine/sky', {
  namedExports: {
    Sky: class {
      constructor(options) {
        this.name = 'sky';
        this.options = options;
        this.disposals = 0;
        skies.push(this);
      }
      setup(engine) {
        this.engine = engine;
      }
      dispose() {
        if (this.disposals) return;
        this.disposals++;
      }
    },
  },
});
class Font {
  constructor(options) {
    this.options = options;
  }
}
class TextBlock {
  constructor(options = {}) {
    Object.assign(this, options);
    this.font = options.font ?? new Font();
    texts.push(this);
  }
  set(options) {
    Object.assign(this, options);
    return this;
  }
  setTransform(position, rotation, scale) {
    Object.assign(this, { position, rotation, scale });
    return this;
  }
  setMatrix(matrix) {
    this.matrix = matrix;
    return this;
  }
  attach(mesh) {
    mesh?.check();
    this.attachedMesh = mesh;
    return this;
  }
}
mock.module('@margoengine/text', {
  namedExports: {
    Font,
    Text: TextBlock,
    TextRenderer: class {
      constructor(options) {
        this.name = options.name;
        this.texts = new Set();
        this.removals = [];
        this.disposals = 0;
        renderers.push(this);
      }
      setup(engine) {
        this.engine = engine;
      }
      add(text) {
        this.texts.add(text);
        return text;
      }
      remove(text) {
        if (this.texts.delete(text)) this.removals.push(text);
      }
      dispose() {
        if (this.disposals) return;
        this.disposals++;
        this.texts.clear();
      }
    },
  },
});
const lineGrids = [],
  panels = [];
class Panel {
  constructor(kind, options) {
    Object.assign(this, { kind, options, disposals: 0 });
    panels.push(this);
  }
  dispose() {
    this.disposals++;
  }
}
mock.module('@margoengine/inspector', {
  namedExports: { Inspector: { attach: (_, options) => new Panel('inspector', options) } },
});
mock.module('@margoengine/stats', {
  namedExports: { Stats: { attach: (_, options) => new Panel('stats', options) } },
});
const modelClones = [];
mock.module('@margoengine/animation/skeleton-utils', {
  namedExports: {
    async cloneModel(model) {
      const engine = model.root.engine,
        root = new Node(engine),
        clone = {
          disposed: false,
          root,
          nodes: [],
          bounds: model.bounds,
          primitives: model.primitives.map(() => ({ material: { base: [], factors: [], emission: [], settings: [] } })),
          lit: [],
          addLighting(effect) {
            clone.lit.push(effect);
            return () => clone.lit.splice(clone.lit.indexOf(effect), 1);
          },
          dispose() {
            clone.disposed = true;
            root.dispose();
          },
        };
      modelClones.push(clone);
      return clone;
    },
  },
});
mock.module('@margoengine/lines', {
  namedExports: {
    GridHelper: class {
      constructor(options) {
        this.options = options;
      }
      setMatrix(matrix) {
        this.matrix = matrix;
      }
    },
    Lines: class {
      name = 'lines';
      disposals = 0;
      add(grid) {
        grid.owner = this;
        lineGrids.push(grid);
      }
      dispose() {
        this.disposals++;
      }
    },
  },
});
const { Context } = await import('../dist/internal.js');
const { Mesh } = await (await import('./entries.js')).allEntries();
const {
  Billboard,
  Bounds,
  CameraShake,
  DevTools,
  Float,
  Stats,
  Grid,
  shakeNoise,
  useAspect,
  useBounds,
  useCursor,
  useIntersect,
  useViewport,
  Clone,
} = await (await import('./entries.js')).allEntries();
const { Box, Sphere, Plane, Sky, ContactShadows, Center, PointerLock, TransformControls, DragControls, Text } = await (
  await import('./entries.js')
).allEntries();
const { sceneWorldBounds } = await import('../dist/center.js');
const { ContactGround } = await import('../dist/kit-contact.js');
const dom = new JSDOM('<!doctype html><html><body></body></html>');
for (const key of ['window', 'document', 'HTMLElement', 'HTMLCanvasElement', 'navigator'])
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.GPUBufferUsage = { UNIFORM: 1, COPY_DST: 2 };
const { render, act, cleanup } = await import('@testing-library/react');
const flush = () => act(async () => {});
function multiply(a, b) {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return out;
}
function makeScene() {
  const engine = {
    next: 0,
    disposed: false,
    backend: 'webgpu',
    gpu: {},
    canvas: document.createElement('canvas'),
    meshes: new Map(),
    plugins: new Map(),
    errors: [],
    camera: { matrix: identity() },
    createMesh() {
      return new Node(this);
    },
    onError(error) {
      this.errors.push(error);
    },
    hasPlugin(name) {
      return this.plugins.has(name);
    },
    use(plugin) {
      assert.equal(this.plugins.has(plugin.name), false);
      plugin.setup?.(this);
      this.plugins.set(plugin.name, plugin);
      return this;
    },
    removePlugin(name) {
      const plugin = this.plugins.get(name);
      this.plugins.delete(name);
      plugin?.dispose?.();
    },
  };
  engine.store = {
    parents: [],
    hidden: [],
    visible: [],
    tick() {
      const done = new Set();
      function update(mesh) {
        if (done.has(mesh)) return;
        const parent = engine.meshes.get(engine.store.parents[mesh.id]);
        if (parent) update(parent);
        const local = identity(),
          c = Math.cos(mesh.rotation.z),
          s = Math.sin(mesh.rotation.z);
        local.set([
          c * mesh.scale.x,
          s * mesh.scale.x,
          0,
          0,
          -s * mesh.scale.y,
          c * mesh.scale.y,
          0,
          0,
          0,
          0,
          mesh.scale.z,
          0,
          mesh.position.x,
          mesh.position.y,
          mesh.position.z,
          1,
        ]);
        mesh.matrix.set(parent ? multiply(parent.matrix, local) : local);
        done.add(mesh);
      }
      for (const mesh of engine.meshes.values()) update(mesh);
    },
  };
  const scene = {
    engine,
    registry: null,
    frames: { callbacks: new Set(), elapsed: 0, last: null },
    resources: { models: new Set(), lighting: new Map() },
    shadows: null,
    shadowUsers: 0,
    requestShadows: () => {
      scene.shadowUsers++;
      return () => scene.shadowUsers--;
    },
    pointerHandlers: new Map(),
    cameraOverrides: new Set(),
    assetCache: {},
  };
  scenes.push(scene);
  return scene;
}
const tree = (scene, children) =>
  React.createElement(StrictMode, null, React.createElement(Context.Provider, { value: scene }, children));
async function frame(scene, delta = 0.1) {
  await act(async () => {
    for (const plugin of scene.engine.plugins.values()) plugin.onPreUpdate?.(delta);
    for (const callback of scene.frames.callbacks) callback(scene.engine, delta);
  });
}
afterEach(async () => {
  cleanup();
  await flush();
  for (const scene of scenes) {
    assert.equal(scene.frames.callbacks.size, 0);
    assert.equal(scene.engine.meshes.size, 0);
    assert.equal(scene.engine.plugins.size, 0);
    assert.equal(scene.shadowUsers, 0);
    assert.deepEqual(scene.engine.errors, []);
    scene.engine.disposed = true;
  }
  assert.ok([...skies, ...pointers, ...gizmos, ...renderers].every((item) => item.disposals === 1));
});

test('kit shapes use optional geometry factories, preserve children and replace geometry on args updates', async () => {
  const scene = makeScene(),
    box = createRef(),
    sphere = createRef(),
    plane = createRef();
  const content = (args) => [
    React.createElement(
      Box,
      { key: 'box', ref: box, args, position: [1, 2, 3], onClick: () => {} },
      React.createElement(Mesh),
    ),
    React.createElement(Sphere, { key: 'sphere', ref: sphere, args: [2, 12, 6] }),
    React.createElement(Plane, { key: 'plane', ref: plane, args: [4, 8] }),
  ];
  const view = render(tree(scene, content([2, 3, 4])));
  await flush();
  assert.equal(scene.engine.meshes.size, 4);
  assert.deepEqual(box.current.position, { x: 1, y: 2, z: 3 });
  assert.equal(box.current.geometry.kind, 'box');
  assert.deepEqual(box.current.geometry.args, [2, 3, 4]);
  assert.equal(sphere.current.geometry.kind, 'sphere');
  assert.deepEqual(sphere.current.geometry.args, [2, 12, 6]);
  assert.equal(plane.current.geometry.kind, 'plane');
  const first = box.current.geometry;
  view.rerender(tree(scene, content([5, 6, 7])));
  await flush();
  assert.notEqual(box.current.geometry, first);
  assert.deepEqual(box.current.geometry.args, [5, 6, 7]);
  view.unmount();
  assert.equal(scene.pointerHandlers.size, 0);
});

test('shape color, roughness and metalness props reach the attached material and update in place', async () => {
  const scene = makeScene(),
    ref = createRef(),
    content = (color) => React.createElement(Box, { ref, color, roughness: 0.25, metalness: 0.6 });
  const view = render(tree(scene, content('#84d6bd')));
  await flush();
  const mesh = ref.current;
  assert.deepEqual(mesh.material.options, { color: '#84d6bd', roughness: 0.25, metalness: 0.6 });
  view.rerender(tree(scene, content('#ff0000')));
  await flush();
  assert.equal(ref.current, mesh);
  assert.equal(mesh.material.options.color, '#ff0000');
});

test('Sky dynamically owns one plugin in StrictMode and updates its options without reattaching', async () => {
  const scene = makeScene(),
    ref = createRef(),
    start = skies.length;
  const view = render(
    tree(scene, React.createElement(Sky, { ref, hours: 6, turbidity: 3, clouds: { coverage: 0.2 } })),
  );
  await flush();
  const sky = ref.current;
  assert.equal(skies.length, start + 1);
  assert.equal(scene.engine.plugins.get('sky'), sky);
  assert.equal(sky.options.hours, 6);
  assert.equal(sky.options.environment, true, 'a React Sky supplies the fallback environment by default');
  view.rerender(tree(scene, React.createElement(Sky, { ref, hours: 18, exposure: 1 })));
  await flush();
  assert.equal(ref.current, sky);
  assert.deepEqual(sky.options, { environment: true, hours: 18, exposure: 1 });
  view.unmount();
  assert.equal(sky.disposals, 1);
});

test('shape casters register native meshes with shared Shadows and release on prop changes and unmount', async () => {
  const scene = makeScene(),
    ref = createRef(),
    casters = new Set();
  let adds = 0,
    removes = 0;
  scene.shadows = {
    add(mesh) {
      mesh.check();
      assert.equal(casters.has(mesh), false);
      casters.add(mesh);
      adds++;
      return () => {
        if (casters.delete(mesh)) removes++;
      };
    },
  };
  const content = (cast, args) => React.createElement(Box, { ref, castShadow: cast, args });
  const view = render(tree(scene, content(true, [2, 2, 2])));
  await flush();
  assert.deepEqual([...casters], [ref.current]);
  assert.equal(scene.shadowUsers, 0, 'castShadow alone requests no shadows (a <Shadows> does)');
  const first = ref.current.geometry;
  view.rerender(tree(scene, content(true, [3, 3, 3])));
  await flush();
  assert.notEqual(ref.current.geometry, first);
  assert.deepEqual([...casters], [ref.current]);
  assert.equal(scene.shadowUsers, 0, 'castShadow alone requests no shadows (a <Shadows> does)');
  view.rerender(tree(scene, content(false, [3, 3, 3])));
  await flush();
  assert.equal(casters.size, 0);
  assert.equal(scene.shadowUsers, 0);
  assert.equal(adds, removes);
  view.rerender(tree(scene, content(true, [3, 3, 3])));
  await flush();
  assert.equal(casters.size, 1);
  view.unmount();
  assert.equal(casters.size, 0);
  assert.equal(adds, removes);
});

test('PointerLock binds once, updates options and frame delta, and releases canvas clicks and lock', async () => {
  const scene = makeScene(),
    ref = createRef(),
    events = [],
    start = pointers.length;
  const view = render(
    tree(
      scene,
      React.createElement(PointerLock, {
        ref,
        pointerSpeed: 2,
        movementSpeed: 4,
        onLock: () => events.push('lock'),
        onUnlock: () => events.push('unlock'),
      }),
    ),
  );
  await flush();
  const controls = ref.current;
  assert.equal(pointers.length, start + 1);
  assert.equal(controls.canvas, scene.engine.canvas);
  assert.equal(controls.pointerSpeed, 2);
  assert.equal(controls.movementSpeed, 4);
  scene.engine.canvas.click();
  assert.equal(controls.isLocked, true);
  assert.deepEqual(events, ['lock']);
  await frame(scene, 0.25);
  assert.deepEqual(controls.updates, [0.25]);
  view.rerender(
    tree(scene, React.createElement(PointerLock, { ref, enabled: false, movementSpeed: 0, lockOnClick: false })),
  );
  await flush();
  assert.equal(controls.enabled, false);
  assert.equal(controls.movementSpeed, 0);
  controls.unlock();
  scene.engine.canvas.click();
  assert.equal(controls.isLocked, false);
  view.unmount();
  scene.engine.canvas.click();
  assert.equal(controls.isLocked, false);
  assert.equal(controls.disposals, 1);
});

test('TransformControls wraps children as a group, changes modes, and supports parent/object ref attachment', async () => {
  const scene = makeScene(),
    ref = createRef(),
    start = gizmos.length;
  const child = (mode) => React.createElement(TransformControls, { ref, mode, size: 2 }, React.createElement(Box));
  const view = render(tree(scene, child('translate')));
  await flush();
  const controls = ref.current,
    object = controls.object;
  assert.equal(gizmos.length, start + 1);
  assert.ok(object);
  assert.equal(object.geometry, null);
  const shape = [...scene.engine.meshes.values()].find((node) => node.geometry);
  assert.equal(scene.engine.store.parents[shape.id], object.id);
  assert.equal(controls.size, 2);
  view.rerender(tree(scene, child('rotate')));
  await flush();
  assert.equal(controls.object, object);
  assert.equal(controls.mode, 'rotate');
  view.unmount();
  assert.equal(controls.disposals, 1);
  const parent = createRef(),
    external = createRef(),
    ref2 = createRef();
  const next = render(
    tree(
      scene,
      React.createElement(
        Mesh,
        { ref: parent },
        React.createElement(TransformControls, { ref: ref2, object: external }),
      ),
    ),
  );
  await flush();
  assert.equal(ref2.current.object, null);
  external.current = parent.current;
  await frame(scene);
  assert.equal(ref2.current.object, parent.current);
  next.unmount();
});

test('DragControls drags its children as one group, locks an axis and holds the group within its limits', async () => {
  const scene = makeScene(),
    ref = createRef(),
    seen = [];
  const drag = (props) =>
    tree(
      scene,
      React.createElement(
        DragControls,
        {
          ref,
          position: [1, 0, 0],
          dragLimits: [[-2, 2], undefined, [0, 0]],
          onDragStart: (origin) => seen.push(['start', origin]),
          onDrag: (position) => seen.push(['drag', position]),
          onDragEnd: () => seen.push(['end']),
          onHover: (hovering) => seen.push(['hover', hovering]),
          ...props,
        },
        React.createElement(Box),
      ),
    );
  const view = render(drag({ axisLock: 'x' }));
  await flush();
  const controls = ref.current,
    [group] = controls.objects;
  assert.equal(controls, drags.at(-1));
  assert.equal(controls.options.transformGroup, true, 'the whole group moves, whichever child is grabbed');
  assert.equal(group.geometry, null);
  const shape = [...scene.engine.meshes.values()].find((node) => node.geometry);
  assert.equal(scene.engine.store.parents[shape.id], group.id, 'the children hang under the dragged group');
  assert.deepEqual(controls.axis, [1, 0, 0]);
  assert.equal(controls.mode, 'translate');
  controls.emit('hoveron');
  controls.emit('dragstart');
  group.setPosition([5, 3, -1]);
  controls.emit('drag');
  controls.emit('dragend');
  assert.deepEqual([group.position.x, group.position.y, group.position.z], [2, 3, 0], 'the limits hold the group');
  assert.deepEqual(seen, [['hover', true], ['start', [1, 0, 0]], ['drag', [2, 3, 0]], ['end']]);
  view.rerender(drag({ mode: 'rotate', enabled: false }));
  await flush();
  assert.equal(controls.axis, null);
  assert.equal(controls.mode, 'rotate');
  assert.equal(controls.enabled, false);
  view.unmount();
  assert.equal(controls.disposals, 1);
  assert.equal(controls.events.size, 0);
});

test('Text shares an optional renderer, attaches to parent meshes and updates content/style/transform', async () => {
  const scene = makeScene(),
    ref = createRef(),
    parent = createRef(),
    start = renderers.length;
  const child = (text, color) =>
    React.createElement(
      Mesh,
      { ref: parent },
      React.createElement(Text, { ref, font: { family: 'serif' }, fontSize: 0.5, color, position: [0, 2, 0] }, text),
      React.createElement(Text, { text: 'Second' }),
    );
  const view = render(tree(scene, child('First', '#ff0000')));
  await flush();
  const item = ref.current,
    renderer = renderers.at(-1);
  assert.equal(renderers.length, start + 1);
  assert.equal(renderer.texts.size, 2);
  assert.equal(item.attachedMesh, parent.current);
  assert.equal(item.text, 'First');
  assert.deepEqual(item.position, [0, 2, 0]);
  view.rerender(tree(scene, child('Updated', '#00ff00')));
  await flush();
  assert.equal(ref.current, item);
  assert.equal(item.text, 'Updated');
  assert.equal(item.color, '#00ff00');
  assert.equal(item.fontSize, 0.5);
  assert.equal(renderer.texts.size, 2);
  view.unmount();
  await flush();
  assert.equal(renderer.texts.size, 0);
  assert.equal(renderer.removals.length, 2);
  assert.equal(renderer.disposals, 1);
});

test('Center uses world bounds through nested rotated/scaled groups and keeps its declared position', async () => {
  const scene = makeScene(),
    outer = createRef(),
    geometry = { vertices: Float32Array.from([2, 0, 0, 0, 0, 1, 4, 2, 0, 0, 0, 1]) };
  function Geometry() {
    const registry = React.useContext(Context).registry;
    React.useEffect(() => {
      const attach = (mesh) => mesh.setGeometry(geometry);
      registry.attachments.add(attach);
      if (registry.current) attach(registry.current);
      return () => registry.attachments.delete(attach);
    }, [registry]);
    return null;
  }
  const view = render(
    tree(
      scene,
      React.createElement(
        Center,
        { ref: outer, position: [10, 5, 0], rotation: [0, 0, Math.PI / 2], scale: [2, 3, 1] },
        React.createElement(Mesh, { position: [1, 0, 0] }, React.createElement(Geometry)),
      ),
    ),
  );
  await flush();
  await frame(scene);
  assert.deepEqual(outer.current.position, { x: 10, y: 5, z: 0 });
  const bounds = sceneWorldBounds(scene, outer.current);
  assert.ok(Math.abs((bounds[0] + bounds[3]) / 2 - 10) < 1e-4);
  assert.ok(Math.abs((bounds[1] + bounds[4]) / 2 - 5) < 1e-4);
  const first = [...bounds];
  await frame(scene);
  assert.deepEqual([...sceneWorldBounds(scene, outer.current)], first);
  view.unmount();
});

test('Center includes loader-owned PBR bounds without requiring core geometry', () => {
  const scene = makeScene(),
    root = scene.engine.createMesh(),
    modelRoot = scene.engine.createMesh().setParent(root);
  scene.resources.models.add({ root: modelRoot, disposed: false, bounds: Float32Array.from([-2, -3, -4, 5, 6, 7]) });
  assert.deepEqual([...sceneWorldBounds(scene, root)], [-2, -3, -4, 5, 6, 7]);
  modelRoot.dispose();
  root.dispose();
});

test('unmount before optional imports settle constructs no helpers or leaked plugins', async () => {
  const scene = makeScene(),
    before = [skies.length, pointers.length, gizmos.length, renderers.length];
  const view = render(
    tree(scene, [
      React.createElement(Sky, { key: 'sky' }),
      React.createElement(PointerLock, { key: 'pointer' }),
      React.createElement(TransformControls, { key: 'gizmo' }),
      React.createElement(Text, { key: 'text', text: 'late' }),
      React.createElement(Box, { key: 'box' }),
    ]),
  );
  view.unmount();
  await flush();
  assert.equal(skies.length, before[0]);
  assert.equal(pointers.length, before[1]);
  assert.equal(gizmos.length, before[2]);
  assert.equal(renderers.length, before[3] + 1, 'a shared renderer that resolves late is disposed by the lease');
  assert.equal(renderers.at(-1).disposals, 1);
});

test('ContactShadows requests the shared shadow map and registers a transparent ground pass', async () => {
  const scene = makeScene(),
    ref = createRef();
  scene.shadows = { shader: (source) => source, bindings: () => [] };
  const view = render(
    tree(scene, React.createElement(ContactShadows, { ref, width: 6, height: 8, opacity: 0.4, position: [0, -1, 0] })),
  );
  await flush();
  assert.equal(scene.shadowUsers, 1);
  assert.equal(ref.current.geometry, null);
  assert.equal(scene.engine.plugins.size, 1);
  const plugin = [...scene.engine.plugins.values()][0],
    passes = [];
  plugin.registerPasses({ add: (pass) => passes.push(pass) });
  assert.equal(passes[0].order, 4);
  assert.deepEqual(ref.current.position, { x: 0, y: -1, z: 0 });
  view.unmount();
  assert.equal(scene.shadowUsers, 0);
  assert.equal(scene.engine.plugins.size, 0);
});

test('shadow-only receiver samples the existing map, blends only occlusion, and releases GPU resources', () => {
  const scene = makeScene(),
    mesh = scene.engine.createMesh(),
    registry = { current: mesh },
    buffers = [],
    pipelines = [],
    codes = [],
    draws = [],
    writes = [],
    shadowBindings = [
      { binding: 1, resource: {} },
      { binding: 2, resource: {} },
      { binding: 3, resource: {} },
    ];
  const ground = new ContactGround(
    registry,
    {
      shader: (source) => {
        codes.push(source);
        return (
          'shadow code\n' +
          source.replace('let linear=direct*', 'let linear=direct*shadowVisibility(i.position,i.normal)*')
        );
      },
      bindings: () => shadowBindings,
    },
    () => ({ width: 4, height: 8, opacity: 0.7, color: [0.2, 0.3, 0.4] }),
  );
  const device = {
    createBuffer(options) {
      const buffer = {
        ...options,
        destroys: 0,
        destroy() {
          this.destroys++;
        },
      };
      buffers.push(buffer);
      return buffer;
    },
    createShaderModule: (options) => options,
    createRenderPipeline(options) {
      pipelines.push(options);
      return { getBindGroupLayout: () => ({}) };
    },
    createBindGroup: (options) => options,
    queue: {
      writeBuffer(buffer, offset, value) {
        writes.push([...value]);
      },
    },
  };
  const context = {
    backend: 'webgpu',
    device,
    format: 'rgba8unorm',
    camera: scene.engine.camera,
    descriptor: { multisample: { count: 4 }, depthStencil: { format: 'depth24plus-stencil8' } },
    color: {},
    depth: {},
    encoder: {
      beginRenderPass(options) {
        draws.push(options);
        return {
          setPipeline() {},
          setBindGroup(index, group) {
            assert.deepEqual(group.entries.slice(1), shadowBindings);
          },
          draw(count) {
            assert.equal(count, 6);
          },
          end() {},
        };
      },
    },
  };
  const passes = [];
  ground.setup(scene.engine);
  ground.registerPasses({ add: (pass) => passes.push(pass) });
  scene.engine.store.tick();
  passes[0].execute(context);
  assert.match(codes[0], /\(1\.0-linear\.x\)\*f\.color\.a/);
  assert.equal(pipelines[0].depthStencil.depthWriteEnabled, false);
  assert.equal(pipelines[0].fragment.targets[0].blend.color.dstFactor, 'one-minus-src-alpha');
  assert.equal(draws[0].colorAttachments[0].loadOp, 'load');
  assert.ok(Math.abs(writes[0][35] - 0.7) < 1e-6);
  assert.deepEqual(writes[0].slice(36, 38), [4, 8]);
  ground.onDeviceRestored(scene.engine);
  assert.equal(buffers[0].destroys, 1);
  passes[0].execute(context);
  ground.dispose();
  ground.dispose();
  assert.ok(buffers.every((buffer) => buffer.destroys === 1));
  mesh.dispose();
});

for (const [name, make, disposed] of [
  ['Sky', (ref) => React.createElement(Sky, { ref }), (sky) => sky.disposals > 0],
  ['PointerLock', (ref) => React.createElement(PointerLock, { ref }), (controls) => controls.disposals > 0],
  ['TransformControls', (ref) => React.createElement(TransformControls, { ref }), (controls) => controls.disposals > 0],
  [
    'Text',
    (ref) => React.createElement(Text, { ref, text: 'live' }),
    (item) => !renderers.some((renderer) => renderer.texts.has(item)),
  ],
])
  test(`${name} ref never points at a disposed object when its effect recreates it (StrictMode)`, async () => {
    // The effect that creates the object reruns when the engine changes. Between that cleanup and the new object's
    // creation no render happens, so a ref that was a state snapshot kept pointing at the disposed object.
    const first = makeScene(),
      second = makeScene();
    let current = null;
    const track = (value) => {
      current = value;
    };
    const view = render(tree(first, make(track)));
    await flush();
    const original = current;
    assert.ok(original, `${name} exposes its object through the ref`);
    assert.equal(disposed(original), false);
    view.rerender(tree(second, make(track)));
    // The old object is disposed and the new one is not created yet (its package import is still pending).
    assert.equal(disposed(original), true);
    assert.ok(current === null || !disposed(current), `${name} ref points at a disposed object`);
    await flush();
    assert.ok(current && !disposed(current) && current !== original, `${name} ref reaches the new live object`);
    view.unmount();
    await flush();
    assert.equal(current, null, `${name} ref is cleared on unmount`);
  });

const axis = (q, v) => {
  // v rotated by unit quaternion q.
  const [x, y, z, w] = q,
    c = [y * v[2] - z * v[1] + w * v[0], z * v[0] - x * v[2] + w * v[1], x * v[1] - y * v[0] + w * v[2]];
  return [v[0] + 2 * (y * c[2] - z * c[1]), v[1] + 2 * (z * c[0] - x * c[2]), v[2] + 2 * (x * c[1] - y * c[0])];
};
const near = (actual, expected) =>
  assert.ok(
    Array.from(actual).every((v, i) => Math.abs(v - expected[i]) < 1e-5),
    actual + ' is not ' + expected,
  );

test('Billboard turns its children to the camera in world space, under a rotated parent, and honours its locks', async () => {
  const scene = makeScene(),
    inner = createRef();
  scene.engine.camera.position = [3, 4, 0];
  // A parent turned a quarter about Y: its columns are local X -> world -Z, local Z -> world X.
  const content = (props) => React.createElement(Billboard, props, React.createElement(Mesh, { ref: inner }));
  const view = render(tree(scene, content({})));
  await flush();
  const billboard = scene.engine.meshes.get(scene.engine.store.parents[inner.current.id]),
    outer = scene.engine.meshes.get(scene.engine.store.parents[billboard.id]),
    tick = scene.engine.store.tick;
  scene.engine.store.tick = () => {
    tick();
    outer.matrix.set([0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1]);
  };
  await frame(scene);
  // The world direction (0.6, 0.8, 0) is local (0, 0.8, 0.6) in that parent.
  near(axis(billboard.quaternion, [0, 0, 1]), [0, 0.8, 0.6]);
  view.rerender(tree(scene, content({ lockX: true })));
  await frame(scene);
  near(axis(billboard.quaternion, [0, 0, 1]), [0, 0, 1]);
  const before = billboard.quaternion;
  view.rerender(tree(scene, content({ follow: false })));
  await frame(scene);
  assert.equal(billboard.quaternion, before, 'follow false leaves it alone');
  view.unmount();
});

test('Float bobs inside floatingRange around its own position and stops with its intensities at 0', async () => {
  const scene = makeScene(),
    inner = createRef(),
    outer = createRef();
  const content = (props) =>
    React.createElement(
      Float,
      { ref: outer, position: [5, 5, 5], floatingRange: [1, 2], ...props },
      React.createElement(Mesh, { ref: inner }),
    );
  const view = render(tree(scene, content({})));
  await flush();
  const group = scene.engine.meshes.get(scene.engine.store.parents[inner.current.id]),
    heights = [];
  for (let i = 0; i < 40; i++) {
    await frame(scene, 0.25);
    heights.push(group.position.y);
  }
  assert.ok(Math.min(...heights) >= 1 && Math.max(...heights) <= 2);
  assert.ok(Math.max(...heights) - Math.min(...heights) > 0.9, 'it covers the range');
  assert.deepEqual(outer.current.position, { x: 5, y: 5, z: 5 }, 'the declared position stays');
  view.rerender(tree(scene, content({ floatIntensity: 0, rotationIntensity: 0 })));
  await frame(scene);
  assert.equal(Math.abs(group.position.y), 0);
  assert.equal(Math.abs(group.rotation.x), 0);
  view.unmount();
});

test('Bounds waits for content, fits it, clips, refits on resize, and useBounds fits one mesh', async () => {
  const scene = makeScene(),
    fits = [],
    box = createRef();
  let api;
  Object.assign(scene.engine.camera, {
    fov: 60,
    near: 0.1,
    far: 1000,
    fitToBoundingBox: (min, max, options) => fits.push({ min, max, options }),
  });
  const Grab = () => {
    api = useBounds();
    return null;
  };
  const content = (children) =>
    React.createElement(Bounds, { fit: true, clip: true, observe: true, margin: 1.5, duration: 0 }, children);
  const view = render(tree(scene, content(React.createElement(Grab))));
  await flush();
  await frame(scene);
  assert.equal(fits.length, 0, 'no geometry yet');
  view.rerender(
    tree(
      scene,
      content([
        React.createElement(Grab, { key: 'grab' }),
        React.createElement(Box, { key: 'box', ref: box, position: [10, 0, 0] }),
      ]),
    ),
  );
  await flush();
  box.current.geometry.vertices = new Float32Array([-1, -1, -1, 0, 0, 0, 1, 1, 1, 0, 0, 0]);
  await frame(scene);
  assert.equal(fits.length, 1);
  near(fits[0].min, [9, -1, -1]);
  near(fits[0].max, [11, 1, 1]);
  assert.equal(fits[0].options.padding, 1.5);
  assert.ok(scene.engine.camera.far > scene.engine.camera.near);
  assert.ok(scene.engine.camera.far < 1000, 'clip closes the far plane in');
  await frame(scene);
  assert.equal(fits.length, 1, 'once');
  Object.defineProperty(scene.engine.canvas, 'clientWidth', { configurable: true, value: 640 });
  Object.defineProperty(scene.engine.canvas, 'clientHeight', { configurable: true, value: 320 });
  await frame(scene);
  assert.equal(fits.length, 2, 'observe refits');
  assert.equal(fits[1].options.aspect, 2);
  assert.equal(api.fit(box.current), true);
  assert.equal(fits.length, 3);
  view.unmount();
});

test('a failed Bounds fit goes to onError once and is not retried each frame', async () => {
  const scene = makeScene(),
    errors = [],
    box = createRef();
  let calls = 0;
  Object.assign(scene.engine.camera, {
    fitToBoundingBox() {
      calls++;
      throw new RangeError('Bounds exceed far');
    },
  });
  const view = render(
    tree(
      scene,
      React.createElement(
        Bounds,
        { fit: true, onError: (e) => errors.push(e) },
        React.createElement(Box, { ref: box }),
      ),
    ),
  );
  await flush();
  box.current.geometry.vertices = new Float32Array([0, 0, 0, 0, 0, 0]);
  await frame(scene);
  await frame(scene);
  assert.equal(calls, 1);
  assert.match(errors[0].message, /far/);
  assert.equal(scene.engine.errors.length, 1, 'the Canvas hears it too');
  scene.engine.errors.length = 0;
  view.unmount();
});

test('Grid draws one GridHelper with its props, and rebuilds when they change', async () => {
  const scene = makeScene();
  lineGrids.length = 0;
  const view = render(
    tree(scene, React.createElement(Grid, { size: 4, divisions: 2, color: '#123456', position: [1, 2, 3] })),
  );
  await flush();
  assert.equal(lineGrids.length, 1);
  assert.deepEqual(lineGrids[0].options, { size: 4, divisions: 2, color1: undefined, color2: '#123456' });
  assert.deepEqual(lineGrids[0].matrix.slice(12), [1, 2, 3, 1]);
  assert.ok(scene.engine.plugins.has('lines'));
  view.rerender(tree(scene, React.createElement(Grid, { size: 8 })));
  await flush();
  assert.equal(lineGrids.at(-1).options.size, 8);
  assert.ok(lineGrids.at(-2).owner.disposals >= 1, 'the old grid goes');
  view.unmount();
});

test('Grid attaches, rebuilds and unmounts in its enclosing secondary Scene', async () => {
  const scene = makeScene(),
    world = { plugins: new Map(), use: scene.engine.use, removePlugin: scene.engine.removePlugin };
  scene.world = world;
  const view = render(tree(scene, React.createElement(Grid, { size: 4 })));
  await flush();
  assert.equal(scene.engine.plugins.size, 0, 'Grid leaked into the default scene');
  assert.equal(world.plugins.size, 1);
  const original = [...world.plugins.values()][0];
  const primary = { name: original.name, setup() {} };
  scene.engine.use(primary);
  view.rerender(tree(scene, React.createElement(Grid, { size: 8 })));
  await flush();
  assert.ok(original.disposals >= 1);
  assert.equal(world.plugins.size, 1);
  assert.equal(scene.engine.plugins.get(primary.name), primary);
  view.unmount();
  assert.equal(world.plugins.size, 0);
  assert.equal(scene.engine.plugins.get(primary.name), primary);
  scene.engine.removePlugin(primary.name);
});

test('DevTools opens both panels, names meshes by their components, closes them, and stays out when disabled', async () => {
  const scene = makeScene(),
    inner = createRef();
  panels.length = 0;
  const Car = () => React.createElement(Mesh, { ref: inner });
  const view = render(
    tree(scene, [React.createElement(DevTools, { key: 'd' }), React.createElement(Car, { key: 'c' })]),
  );
  await flush();
  const open = panels.filter((p) => !p.disposals);
  assert.deepEqual(open.map((p) => p.kind).sort(), ['inspector', 'stats']);
  const label = open.find((p) => p.kind === 'inspector').options.label;
  // React 18 has no owner stacks (the packed run installs it): the mesh then simply has no component name.
  if (React.captureOwnerStack) assert.match(label(inner.current), /^Car/);
  else assert.equal(label(inner.current), undefined);
  assert.equal(label({}), undefined);
  view.unmount();
  await flush();
  assert.ok(panels.every((p) => p.disposals >= 1));
  panels.length = 0;
  const off = render(tree(scene, React.createElement(DevTools, { enabled: false })));
  await flush();
  assert.equal(panels.length, 0);
  const only = render(tree(scene, React.createElement(DevTools, { stats: false })));
  await flush();
  assert.deepEqual(
    panels.filter((p) => !p.disposals).map((p) => p.kind),
    ['inspector'],
  );
  off.unmount();
  only.unmount();
});

test('DevTools on a React without owner stacks opens its panels and leaves meshes unnamed', async () => {
  const scene = makeScene(),
    inner = createRef(),
    capture = React.captureOwnerStack;
  panels.length = 0;
  delete React.captureOwnerStack;
  try {
    const Car = () => React.createElement(Mesh, { ref: inner });
    const view = render(
      tree(scene, [React.createElement(DevTools, { key: 'd' }), React.createElement(Car, { key: 'c' })]),
    );
    await flush();
    const open = panels.filter((p) => !p.disposals);
    assert.equal(open.find((p) => p.kind === 'inspector').options.label(inner.current), undefined);
    view.unmount();
    await flush();
  } finally {
    if (capture) React.captureOwnerStack = capture;
  }
});

test('every geometry builder has a shape component and a geometry child; equal inline args keep the geometry, a replaced object argument rebuilds it', async () => {
  const entries = await (await import('./entries.js')).allEntries();
  const cases = {
    Cylinder: ['cylinder', [0.5, 1, 2, 16]],
    Cone: ['cone', [1, 2, 24]],
    Capsule: ['capsule', [0.5, 1]],
    Circle: ['circle', [1, 24]],
    Ring: ['ring', [0.5, 1, 32]],
    Torus: ['torus', [1, 0.3, 12, 48]],
    TorusKnot: ['torusKnot', [1, 0.3, 64, 8, 2, 3]],
    Tetrahedron: ['tetrahedron', [1]],
    Octahedron: ['octahedron', [1, 1]],
    Icosahedron: ['icosahedron', [1, 2, true]],
    Dodecahedron: ['dodecahedron', [1]],
    Polyhedron: ['polyhedron', [[1, 1, 1, -1, -1, 1, -1, 1, -1, 1, -1, -1], [2, 1, 0, 0, 3, 2, 1, 3, 0, 2, 3, 1], 1]],
    Lathe: [
      'lathe',
      [
        [
          [0, 0],
          [1, 0.5],
          [0, 1],
        ],
        12,
      ],
    ],
    RoundedBox: ['roundedBox', [1, 2, 3, 4, 0.25]],
  };
  for (const [name, [kind, args]] of Object.entries(cases)) {
    const scene = makeScene(),
      shape = createRef(),
      child = createRef(),
      Child = entries[`${name}Geometry`];
    assert.equal(typeof entries[name], 'object', `${name} is exported`);
    assert.equal(typeof Child, 'function', `${name}Geometry is exported`);
    // Fresh but equal array literals on every render, as JSX writes them.
    const content = () => [
      React.createElement(entries[name], { key: 'shape', ref: shape, args: structuredClone(args) }),
      React.createElement(
        Mesh,
        { key: 'child', ref: child },
        React.createElement(Child, { args: structuredClone(args) }),
      ),
    ];
    const view = render(tree(scene, content()));
    await flush();
    assert.equal(shape.current.geometry.kind, kind, name);
    assert.deepEqual(shape.current.geometry.args, args, name);
    assert.equal(child.current.geometry.kind, kind, `${name}Geometry`);
    assert.deepEqual(child.current.geometry.args, args, `${name}Geometry`);
    const first = [shape.current.geometry, child.current.geometry];
    view.rerender(tree(scene, content()));
    await flush();
    assert.equal(shape.current.geometry, first[0], `${name} keeps its geometry for equal args`);
    assert.equal(child.current.geometry, first[1], `${name}Geometry keeps its geometry for equal args`);
    view.unmount();
  }
  // A Curve or Shape instance counts by identity: the same object keeps the geometry, a new one rebuilds it.
  class Path {
    constructor(length) {
      this.length = length;
    }
  }
  const scene = makeScene(),
    tube = createRef(),
    path = new Path(2);
  const content = (curve) => React.createElement(entries.Tube, { ref: tube, args: [curve, 32, 0.1] });
  const view = render(tree(scene, content(path)));
  await flush();
  assert.equal(tube.current.geometry.kind, 'tube');
  assert.equal(tube.current.geometry.args[0], path);
  const first = tube.current.geometry;
  view.rerender(tree(scene, content(path)));
  await flush();
  assert.equal(tube.current.geometry, first);
  view.rerender(tree(scene, content(new Path(2))));
  await flush();
  assert.notEqual(tube.current.geometry, first);
  view.unmount();
});

test('useCursor sets the canvas cursor while hovered and puts it back', async () => {
  const scene = makeScene(),
    Hover = ({ on }) => {
      useCursor(on, 'grab');
      return null;
    };
  const view = render(tree(scene, React.createElement(Hover, { on: false })));
  await flush();
  assert.equal(scene.engine.canvas.style.cursor, '');
  view.rerender(tree(scene, React.createElement(Hover, { on: true })));
  await flush();
  assert.equal(scene.engine.canvas.style.cursor, 'grab');
  view.rerender(tree(scene, React.createElement(Hover, { on: false })));
  await flush();
  assert.equal(scene.engine.canvas.style.cursor, 'auto');
  view.rerender(tree(scene, React.createElement(Hover, { on: true })));
  await flush();
  view.unmount();
  assert.equal(scene.engine.canvas.style.cursor, 'auto', 'unmounting while hovered restores it');
});

test('useViewport and useAspect measure the view at the camera target and cover it', async () => {
  const scene = makeScene();
  Object.assign(scene.engine.camera, { fov: 90, position: [0, 0, 2], target: [0, 0, 0] });
  Object.defineProperty(scene.engine.canvas, 'clientWidth', { value: 200 });
  Object.defineProperty(scene.engine.canvas, 'clientHeight', { value: 100 });
  let viewport, wide, tall;
  const Read = () => {
    viewport = useViewport();
    wide = useAspect(16, 9);
    tall = useAspect(1, 2, 2);
    return null;
  };
  render(tree(scene, React.createElement(Read)));
  await flush();
  // 2 * distance * tan(45 degrees) = 4 units high; the 2:1 canvas makes it 8 wide; 100 px over 4 units.
  assert.ok(Math.abs(viewport.height - 4) < 1e-12 && Math.abs(viewport.width - 8) < 1e-12);
  assert.equal(viewport.aspect, 2);
  assert.ok(Math.abs(viewport.factor - 25) < 1e-12);
  // 16:9 is narrower than 2:1, so it fills the width: 8 by 4.5.
  assert.ok(Math.abs(wide[0] - 8) < 1e-12 && Math.abs(wide[1] - 4.5) < 1e-12 && wide[2] === 1);
  // 1:2 fills the width too: 8 by 16, times factor 2.
  assert.ok(Math.abs(tall[0] - 16) < 1e-12 && Math.abs(tall[1] - 32) < 1e-12);
});

test('shakeNoise is continuous, bounded and differs by seed', () => {
  let previous = shakeNoise(0, 7),
    largest = 0,
    differs = false;
  assert.equal(previous, 0, 'zero at every lattice point');
  for (let x = 0.001; x < 50; x += 0.001) {
    const value = shakeNoise(x, 7);
    assert.ok(Math.abs(value - previous) < 0.02, `jump at ${x}`);
    largest = Math.max(largest, Math.abs(value));
    if (Math.abs(value - shakeNoise(x, 8)) > 0.1) differs = true;
    previous = value;
  }
  assert.ok(largest <= 1 && largest > 0.3);
  assert.ok(differs);
});

test('CameraShake turns the view within its limits, follows a moved camera, decays and restores on unmount', async () => {
  const scene = makeScene(),
    shake = createRef(),
    camera = scene.engine.camera;
  Object.assign(camera, { position: [0, 0, 5], target: [0, 0, 0], up: [0, 1, 0] });
  const angle = (a, b) =>
    Math.acos(Math.min(1, (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / Math.hypot(...a) / Math.hypot(...b)));
  const view = render(
    tree(
      scene,
      React.createElement(CameraShake, {
        ref: shake,
        maxYaw: 0.2,
        maxPitch: 0.2,
        maxRoll: 0.3,
        yawFrequency: 3,
        pitchFrequency: 3,
        rollFrequency: 3,
      }),
    ),
  );
  await flush();
  let moved = 0;
  for (let i = 0; i < 60; i++) {
    await frame(scene, 0.05);
    const forward = camera.target.map((v, k) => v - camera.position[k]);
    const off = angle(forward, [0, 0, -1]);
    assert.ok(off <= Math.hypot(0.2, 0.2) + 1e-9, 'yaw and pitch stay inside their limits');
    assert.ok(Math.abs(Math.hypot(...forward) - 5) < 1e-9, 'the target keeps its distance');
    assert.ok(Math.abs(Math.hypot(...camera.up) - 1) < 1e-9);
    moved = Math.max(moved, off);
  }
  assert.ok(moved > 0.01, 'it shakes');
  // Something else moves the camera: the shake builds on the new place instead of pulling it back.
  camera.target = [10, 0, 5];
  await frame(scene, 0.05);
  assert.ok(Math.hypot(camera.target[0] - 10, camera.target[1], camera.target[2] - 5) < 10 * 0.3);
  shake.current.setIntensity(0);
  await frame(scene, 0.05);
  assert.deepEqual(camera.target, [10, 0, 5]);
  assert.equal(shake.current.getIntensity(), 0);
  view.rerender(
    tree(scene, React.createElement(CameraShake, { ref: shake, decay: true, decayRate: 1, intensity: 0.75 })),
  );
  await flush();
  assert.equal(shake.current.getIntensity(), 0.75, 'a new intensity prop applies');
  for (let i = 0; i < 4; i++) await frame(scene, 0.25);
  assert.equal(shake.current.getIntensity(), 0, '0.75 lasts 0.75 s at decayRate 1');
  shake.current.setIntensity(1);
  await frame(scene, 0.1);
  view.unmount();
  assert.deepEqual(camera.target, [10, 0, 5], 'unmount puts the camera back');
  assert.deepEqual(camera.up, [0, 1, 0]);
});

test('Stats opens the readout alone with its options and closes it on unmount', async () => {
  const scene = makeScene(),
    parent = document.createElement('div');
  panels.length = 0;
  const view = render(tree(scene, React.createElement(Stats, { parent, samples: 60 })));
  await flush();
  const open = panels.filter((p) => !p.disposals);
  assert.deepEqual(
    open.map((p) => p.kind),
    ['stats'],
  );
  assert.equal(open[0].options.parent, parent);
  assert.equal(open[0].options.samples, 60);
  view.unmount();
  await flush();
  assert.ok(panels.every((p) => p.disposals >= 1));
  panels.length = 0;
  render(tree(scene, React.createElement(Stats, { enabled: false })));
  await flush();
  assert.equal(panels.length, 0);
});

test("useIntersect reports entering and leaving the view by the last frame's culling, for meshes, groups and models", async () => {
  const scene = makeScene(),
    { engine } = scene,
    calls = [],
    group = createRef(),
    child = createRef();
  // Camera planes: only x >= 0 is in view (normal +x, distance 0); the other five pass everything.
  engine.camera.planes = Float32Array.from([1, 0, 0, 0, ...Array.from({ length: 5 }, () => [0, 0, 0, 1]).flat()]);
  let ref;
  const Watch = () => {
    ref = useIntersect((visible) => calls.push(visible));
    return React.createElement(
      Mesh,
      { ref: (node) => ((ref.current = node), (group.current = node)) },
      React.createElement(Mesh, { ref: child }),
    );
  };
  const view = render(tree(scene, React.createElement(Watch)));
  await flush();
  await frame(scene);
  assert.deepEqual(calls, [], 'a group with nothing drawn is not visible and reports nothing');
  child.current.geometry = { indices: [0, 1, 2] };
  engine.store.visible[child.current.id] = 1;
  await frame(scene);
  await frame(scene);
  assert.deepEqual(calls, [true], 'a drawn child makes the group visible, reported once');
  engine.store.hidden[group.current.id] = 1;
  await frame(scene);
  assert.deepEqual(calls, [true, false], 'a hidden group is not visible');
  engine.store.hidden[group.current.id] = 0;
  engine.store.visible[child.current.id] = 0;
  await frame(scene);
  assert.deepEqual(calls, [true, false], 'culled: still not visible');
  const model = { disposed: false, root: child.current, bounds: [-3, -1, -1, -2, 1, 1] };
  scene.resources.models.add(model);
  await frame(scene);
  assert.deepEqual(calls, [true, false], 'a model wholly on the culled side is not visible');
  model.bounds = [-3, -1, -1, 0.5, 1, 1];
  await frame(scene);
  assert.deepEqual(calls, [true, false, true], 'a model whose bounds meet the view is visible');
  scene.resources.models.delete(model);
  view.unmount();
  await frame(scene);
  assert.deepEqual(calls, [true, false, true]);
});

test('Clone copies a mesh tree with shared geometry and material, copies models, places the copy and cleans up', async () => {
  const scene = makeScene(),
    { engine } = scene,
    source = createRef(),
    child = createRef(),
    copyRef = createRef(),
    geometry = { indices: [0, 1, 2] },
    material = new Material({ color: 'red' });
  // The store inputs Clone reads, from the mock's transforms.
  const lane = (read) => new Proxy([], { get: (_, id) => read(engine.meshes.get(Number(id))) });
  engine.store.transforms = {
    x: lane((m) => m?.position.x),
    y: lane((m) => m?.position.y),
    z: lane((m) => m?.position.z),
    qx: lane(() => 0),
    qy: lane(() => 0),
    qz: lane(() => 0),
    qw: lane(() => 1),
    sx: lane((m) => m?.scale.x),
    sy: lane((m) => m?.scale.y),
    sz: lane((m) => m?.scale.z),
  };
  const Source = () =>
    React.createElement(
      Mesh,
      { ref: source, position: [1, 2, 3] },
      React.createElement(Mesh, { ref: child, position: [0, 1, 0], scale: [2, 2, 2] }),
    );
  const view = render(tree(scene, React.createElement(Source)));
  await flush();
  child.current.setGeometry(geometry).setMaterial(material);
  child.current.visible = false;
  const material2 = { base: [1, 0, 0, 1], factors: [0.3, 0.7, 1, 1], emission: [0, 0, 0], settings: [0, 0.5, 0] };
  const model = {
    disposed: false,
    root: new Node(engine),
    nodes: [],
    bounds: [0, 0, 0, 1, 1, 1],
    primitives: [{ material: material2, node: null }],
  };
  model.root.setParent(child.current);
  scene.resources.models.add(model);
  const effect = {};
  scene.resources.lighting.set(effect, new Map());
  const before = new Set(engine.meshes.keys());
  view.rerender(
    tree(
      scene,
      React.createElement(
        React.Fragment,
        null,
        React.createElement(Source),
        React.createElement(Clone, { ref: copyRef, object: source, position: [10, 0, 0] }),
      ),
    ),
  );
  await flush();
  await flush();
  const added = [...engine.meshes.values()].filter((m) => !before.has(m.id));
  const group = copyRef.current;
  assert.deepEqual(group.position, { x: 10, y: 0, z: 0 });
  const rootCopy = added.find((m) => engine.store.parents[m.id] === group.id && m !== group);
  assert.deepEqual(rootCopy.position, { x: 1, y: 2, z: 3 }, 'the copied root keeps its local transform');
  const childCopy = added.find((m) => engine.store.parents[m.id] === rootCopy.id && m.geometry);
  assert.equal(childCopy.geometry, geometry, 'geometry is shared');
  assert.equal(childCopy.material, material, 'material is shared');
  assert.deepEqual(childCopy.scale, { x: 2, y: 2, z: 2 });
  assert.equal(childCopy.visible, false);
  assert.equal(modelClones.length, 1, 'the model is copied once, not as plain meshes');
  const modelCopy = modelClones[0];
  assert.equal(engine.store.parents[modelCopy.root.id], childCopy.id, 'the model copy hangs under the copied parent');
  assert.deepEqual(
    modelCopy.primitives[0].material.factors,
    [0.3, 0.7, 1, 1],
    'material values as the source shows them',
  );
  assert.notEqual(modelCopy.primitives[0].material.factors, material2.factors);
  assert.ok(scene.resources.models.has(modelCopy));
  assert.deepEqual(modelCopy.lit, [effect]);
  assert.equal(
    added.filter((m) => m.id !== modelCopy.root.id).length,
    3,
    'the group, the root copy and the child copy',
  );
  view.rerender(tree(scene, React.createElement(Source)));
  await flush();
  assert.ok(modelCopy.disposed);
  assert.equal(scene.resources.models.has(modelCopy), false);
  assert.deepEqual(modelCopy.lit, []);
  assert.deepEqual(
    [...engine.meshes.keys()].filter((id) => !before.has(id)),
    [],
    'every copy is disposed',
  );
  scene.resources.models.delete(model);
  scene.resources.lighting.clear();
  model.root.dispose();
  view.unmount();
});

test('BakeShadows makes every caster static while mounted and dynamic again after', async () => {
  const { BakeShadows } = await (await import('./entries.js')).allEntries();
  const scene = makeScene(),
    ref = createRef(),
    casters = new Map();
  scene.shadows = {
    add(mesh, options) {
      casters.set(mesh, options);
      return () => casters.delete(mesh);
    },
  };
  const content = (bake) =>
    React.createElement(
      React.Fragment,
      null,
      React.createElement(Mesh, { ref, castShadow: true }),
      bake && React.createElement(BakeShadows),
    );
  const view = render(tree(scene, content(false)));
  await flush();
  assert.equal(casters.get(ref.current).static, false);
  view.rerender(tree(scene, content(true)));
  await flush();
  assert.equal(casters.size, 1);
  assert.equal(casters.get(ref.current).static, true, 'baked: the caster is static');
  view.rerender(tree(scene, content(false)));
  await flush();
  assert.equal(casters.get(ref.current).static, false, 'unbaked: dynamic again');
  view.unmount();
  assert.equal(casters.size, 0);
});

test('AdaptiveEvents pauses hover picking while performance has declined and resumes it', async () => {
  const { AdaptiveEvents, PerformanceMonitor } = await (await import('./entries.js')).allEntries();
  const { hoverPaused } = await import('../dist/events.js');
  const scene = makeScene(),
    content = (factor) => React.createElement(PerformanceMonitor, { factor }, React.createElement(AdaptiveEvents));
  const view = render(tree(scene, content(0.5)));
  await flush();
  assert.equal(hoverPaused(scene.engine), true, 'declined: paused');
  view.rerender(tree(scene, content(1)));
  await flush();
  assert.equal(hoverPaused(scene.engine), false, 'back at full quality: resumed');
  view.rerender(tree(scene, content(0.5)));
  await flush();
  view.unmount();
  await flush();
  assert.equal(hoverPaused(scene.engine), false, 'unmounting resumes');
});

test('Preload draws everything once with culling off, hidden meshes too with all, and again when a model arrives', async () => {
  const { Preload } = await (await import('./entries.js')).allEntries();
  const scene = makeScene(),
    hidden = createRef(),
    draws = [];
  scene.engine.render = (options) => draws.push({ ...options, hiddenShown: hidden.current?.visible });
  scene.assetCache = { tracker: { state: { active: false } } };
  const view = render(
    tree(
      scene,
      React.createElement(
        React.Fragment,
        null,
        React.createElement(Mesh, { ref: hidden }),
        React.createElement(Preload, { all: true }),
      ),
    ),
  );
  await flush();
  hidden.current.visible = false;
  view.rerender(
    tree(
      scene,
      React.createElement(
        React.Fragment,
        null,
        React.createElement(Mesh, { ref: hidden }),
        React.createElement(Preload, { all: true, key: 2 }),
      ),
    ),
  );
  await flush();
  const last = draws.at(-1);
  assert.deepEqual(
    [last.culling, last.delta, last.hiddenShown],
    [false, 0, true],
    'culling off, the hidden mesh drawn',
  );
  assert.equal(hidden.current.visible, false, 'and hidden again after');
  const count = draws.length;
  await frame(scene);
  assert.equal(draws.length, count, 'no draw without a new model');
  scene.assetCache.tracker.state.active = true;
  scene.resources.models.add({});
  await frame(scene);
  assert.equal(draws.length, count, 'not while files are still loading');
  scene.assetCache.tracker.state.active = false;
  await frame(scene);
  assert.equal(draws.length, count + 1, 'once loading settles with a new model');
  await frame(scene);
  assert.equal(draws.length, count + 1);
  scene.resources.models.clear();
  view.unmount();
});
