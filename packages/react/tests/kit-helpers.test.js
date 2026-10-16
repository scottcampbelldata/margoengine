import test, { afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import React, { StrictMode, createRef } from 'react';
import { JSDOM } from 'jsdom';

const scenes = [],
  geometries = [],
  skies = [],
  pointers = [],
  gizmos = [],
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
  namedExports: { Engine: {}, Mesh: Node, PbrMaterial: Material, box: () => ({}) },
});
mock.module('@margoengine/geometry', {
  namedExports: {
    boxGeometry: (...args) => ({ kind: 'box', args }),
    sphereGeometry: (...args) => ({ kind: 'sphere', args }),
    planeGeometry: (...args) => ({ kind: 'plane', args }),
    toGeometry(data) {
      const geometry = { ...data, vertices: Float32Array.from([-1, 0, -1, 0, 1, 0, 1, 0, 1, 0, 1, 0]) };
      geometries.push(geometry);
      return geometry;
    },
  },
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
mock.module('@margoengine/controls', {
  namedExports: {
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
  },
});
mock.module('@margoengine/gizmo', {
  namedExports: {
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
const { Context } = await import('../dist/internal.js');
const { Mesh } = await import('../dist/components.js');
const { Box, Sphere, Plane, Sky, ContactShadows, Center, PointerLock, TransformControls, Text, sceneWorldBounds } =
  await import('../dist/kit-helpers.js');
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
  view.rerender(tree(scene, React.createElement(Sky, { ref, hours: 18, exposure: 1 })));
  await flush();
  assert.equal(ref.current, sky);
  assert.deepEqual(sky.options, { hours: 18, exposure: 1 });
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
  assert.equal(scene.shadowUsers, 1);
  const first = ref.current.geometry;
  view.rerender(tree(scene, content(true, [3, 3, 3])));
  await flush();
  assert.notEqual(ref.current.geometry, first);
  assert.deepEqual([...casters], [ref.current]);
  assert.equal(scene.shadowUsers, 1);
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
