import test, { afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import React, { StrictMode, Suspense, createRef } from 'react';
import { render, act, flush, close } from './physics-xr-support.js';
const { PBRModel: NativeModel, GLTFAsset } = await import('../../gltf-pro/dist/index.js');
const { Animation: NativeAnimation } = await import('../../animation/dist/index.js');
const { Animator: NativeAnimator } = await import('../../animator/dist/index.js');
const models = [],
  animations = [],
  animators = [],
  installations = [],
  requests = [],
  pickers = [];
let pending = false,
  installFailure = null,
  nativePlayback = false;
function nativeClips() {
  const buffers = [
    new Float32Array([-0.6, -0.6, 0, 0.6, -0.6, 0, 0, 0.6, 0]),
    new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    new Float32Array([0, 1]),
    new Float32Array([0, 0, 0, 0.4, 0, 0]),
  ];
  return new GLTFAsset(
    {
      asset: { version: '2.0' },
      buffers: buffers.map((data) => ({ byteLength: data.byteLength })),
      bufferViews: buffers.map((data, buffer) => ({ buffer, byteLength: data.byteLength })),
      accessors: buffers.map((data, bufferView) => ({
        bufferView,
        componentType: 5126,
        count: bufferView === 2 ? 2 : data.length / 3,
        type: bufferView === 2 ? 'SCALAR' : 'VEC3',
      })),
      nodes: [{ mesh: 0 }, { name: 'Joint' }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 } }] }],
      animations: [
        {
          name: 'Walk',
          channels: [{ sampler: 0, target: { node: 1, path: 'translation' } }],
          samplers: [{ input: 2, output: 3 }],
        },
        { name: 'Run', channels: [], samplers: [] },
      ],
    },
    buffers,
  );
}
function makeModel(engine, asset = { doc: { images: [] } }, geometry) {
  if (nativePlayback) {
    if (!asset.accessor) asset = nativeClips();
    const model = new NativeModel(engine, asset),
      dispose = model.dispose.bind(model);
    model.disposals = 0;
    model.setup = () => {};
    model.dispose = () => {
      if (model.disposed) return;
      model.disposals++;
      dispose();
    };
    models.push(model);
    return model;
  }
  const root = engine.createMesh(),
    node = engine.createMesh().setParent(root),
    callbacks = new Set();
  const model = {
    name: 'model:' + models.length,
    asset,
    root,
    nodes: [node],
    primitives: [
      {
        node,
        nodeIndex: 0,
        vertices: geometry?.vertices ?? new Float32Array(60),
        indices: geometry?.indices ?? new Uint32Array([0, 1, 2]),
        material: { base: [1, 1, 1, 1], factors: [0.5, 0, 1, 1], emission: [0, 0, 0], settings: [0, 0.5, 1, 0] },
        weights: new Float32Array(0),
      },
    ],
    disposed: false,
    disposals: 0,
    setup() {},
    addLighting() {
      return () => {};
    },
    onDispose(callback) {
      callbacks.add(callback);
      return () => callbacks.delete(callback);
    },
    dispose() {
      if (this.disposed) return;
      this.disposed = true;
      this.disposals++;
      engine.removePlugin(this.name);
      for (const callback of callbacks) callback();
      node.dispose();
      root.dispose();
    },
  };
  models.push(model);
  return model;
}
mock.module('@margoengine/gltf-pro', {
  namedExports: {
    PBRModel: class {
      constructor(engine, asset) {
        return makeModel(engine, asset);
      }
    },
    async loadGLTF(engine, src, { signal }) {
      const request = { src, signal };
      requests.push(request);
      if (pending) await new Promise((resolve, reject) => Object.assign(request, { resolve, reject }));
      const model = makeModel(engine);
      engine.use(model);
      return model;
    },
    parsePreparedPBR(engine, doc, geometry) {
      const model = makeModel(engine, { doc }, geometry[0][0]);
      model.primitives[0].material.base = doc.materials[0].pbrMetallicRoughness.baseColorFactor;
      engine.use(model);
      return model;
    },
  },
});
mock.module('@margoengine/animation', {
  namedExports: {
    Animation: class {
      constructor(model, options) {
        if (nativePlayback) {
          const animation = new NativeAnimation(model, options),
            dispose = animation.dispose.bind(animation);
          animation.disposals = 0;
          animation.setup = (engine) => {
            animation.engine = engine;
          };
          animation.dispose = () => {
            if (animation.disposals) return;
            animation.disposals++;
            dispose();
          };
          animations.push(animation);
          return animation;
        }
        this.model = model;
        this.options = options;
        this.name = 'animation:' + model.name;
        this.clips = [
          { name: 'Walk', duration: 1 },
          { name: 'Run', duration: 2 },
        ];
        this.playing = true;
        this.time = 0;
        this.playCalls = [];
        this.seeks = [];
        this.disposals = 0;
        animations.push(this);
      }
      setup(engine) {
        this.engine = engine;
        this.remove = this.model.onDispose(() => this.dispose());
      }
      play(clip) {
        if (!this.clips.some((value) => value.name === clip)) throw new RangeError('Unknown animation clip');
        this.playCalls.push(clip);
        this.time = 0;
        this.playing = true;
        return this;
      }
      seek(time) {
        this.time = time;
        this.seeks.push(time);
        return this;
      }
      onPreUpdate(delta) {
        if (this.playing) this.time += delta;
      }
      dispose() {
        if (this.disposals) return;
        this.disposals++;
        this.remove?.();
        this.engine?.removePlugin(this.name);
      }
    },
  },
});
mock.module('@margoengine/animator', {
  namedExports: {
    Animator: class {
      constructor(animation, options) {
        if (nativePlayback) {
          const animator = new NativeAnimator(animation, options),
            dispose = animator.dispose.bind(animator);
          animator.disposals = 0;
          animator.dispose = () => {
            if (animator.disposals) return;
            animator.disposals++;
            dispose();
          };
          animators.push(animator);
          return animator;
        }
        this.animation = animation;
        this.options = options;
        this.name = 'animator:' + animation.model.name;
        this.state = options.initial;
        this.time = 0;
        this.transitions = [];
        this.steps = [];
        this.disposals = 0;
        animators.push(this);
      }
      setup(engine) {
        this.engine = engine;
        this.animation.playing = false;
      }
      transition(state, duration) {
        this.state = state;
        this.time = 0;
        this.transitions.push({ state, duration });
        return this;
      }
      onPreUpdate(delta) {
        this.time += delta;
        this.steps.push(delta);
      }
      dispose() {
        if (this.disposals) return;
        this.disposals++;
        this.engine?.removePlugin(this.name);
      }
    },
  },
});
mock.module('@margoengine/materials', {
  namedExports: {
    install(model) {
      const installation = {
        name: 'materials:' + model.name,
        model,
        disposals: 0,
        setup() {
          if (installFailure) throw installFailure;
          model.primitives[0].material.extension = { nativeTransmission: true };
        },
        dispose() {
          if (this.disposals) return;
          this.disposals++;
          model.root.engine.removePlugin(this.name);
        },
      };
      installations.push(installation);
      model.root.engine.use(installation);
      model.onDispose(() => installation.dispose());
      return installation;
    },
  },
});
mock.module('@margoengine/selection', {
  namedExports: {
    Picking: class {
      static attach(engine, options) {
        const picker = new this(engine, options);
        engine.use(picker);
        return picker;
      }
      constructor(engine, options) {
        this.engine = engine;
        this.options = options;
        this.name = 'picking';
        this.models = new Set();
        this.disposals = 0;
        pickers.push(this);
      }
      setup() {}
      add(model) {
        assert.equal(this.models.has(model), false);
        this.models.add(model);
        return () => this.models.delete(model);
      }
      dispose() {
        if (this.disposals) return;
        this.disposals++;
        this.models.clear();
        this.engine.removePlugin(this.name);
      }
    },
  },
});
const { Canvas, Mesh, BoxGeometry, PbrMaterial } = await import('../dist/components.js');
const { Model } = await import('../dist/model.js');
const { Animation } = await import('../dist/animation.js');
const { MeshTransmissionMaterial } = await import('../dist/materials.js');
const h = React.createElement,
  tree = (children, options = {}) => h(StrictMode, null, h(Canvas, { frameloop: 'demand', ...options }, children));
const animated = (src, options = {}) =>
  h(Suspense, { fallback: h('p', null, 'Loading') }, h(Model, { src }, h(Animation, { clip: 'Walk', ...options })));
afterEach(async () => {
  pending = false;
  installFailure = null;
  nativePlayback = false;
  for (const request of requests) request.resolve?.();
  await close();
  assert.ok(models.every((value) => value.disposals === 1));
  assert.ok(animations.every((value) => value.disposals === 1));
  assert.ok(animators.every((value) => value.disposals === 1));
  assert.ok(installations.every((value) => value.disposals === 1));
  assert.ok(pickers.every((value) => value.disposals === 1 && value.models.size === 0));
});

test('Animation uses its loaded model once in StrictMode, updates clips and playback, and releases on child removal', async () => {
  const start = animations.length;
  const view = render(tree(animated('/clips.gltf')));
  await flush();
  assert.equal(animations.length, start + 1);
  const animation = animations.at(-1);
  assert.deepEqual(animation.playCalls, ['Walk']);
  assert.equal(animation.model, models.at(-1));
  view.rerender(tree(animated('/clips.gltf', { clip: 'Run', playing: false, loop: false })));
  await flush();
  assert.equal(animations.at(-1), animation);
  assert.deepEqual(animation.playCalls, ['Walk', 'Run']);
  assert.equal(animation.playing, false);
  assert.equal(animation.options.loop, false);
  view.rerender(tree(h(Model, { src: '/clips.gltf' })));
  await flush();
  assert.equal(animation.disposals, 1);
  assert.equal(models.at(-1).disposed, false);
});
test('Animation defers attachment through Suspense, reloads cleanly, and never attaches after a pending unmount', async () => {
  pending = true;
  const start = animations.length;
  const view = render(tree(animated('/pending-clips.gltf')));
  await flush();
  assert.equal(view.getByText('Loading').textContent, 'Loading');
  assert.equal(animations.length, start);
  await act(async () => requests.at(-1).resolve());
  await flush();
  assert.equal(view.queryByText('Loading'), null);
  assert.equal(animations.length, start + 1);
  const first = animations.at(-1);
  view.rerender(tree(animated('/replacement-clips.gltf')));
  await flush();
  await act(async () => requests.at(-1).resolve());
  await flush();
  assert.equal(first.disposals, 1);
  assert.equal(animations.length, start + 2);
  view.rerender(tree(animated('/aborted-clips.gltf')));
  await flush();
  const request = requests.at(-1);
  view.rerender(tree(null));
  await flush();
  assert.equal(request.signal.aborted, true);
  await act(async () => request.resolve());
  await flush();
  assert.equal(animations.length, start + 2);
});
test('blend delegates transitions to the native Animator and respects playing plus a nonlooping final pose', async () => {
  const view = render(tree(animated('/blended-clips.gltf', { blend: 0.3 })));
  await flush();
  const animation = animations.at(-1),
    animator = animators.at(-1);
  assert.equal(animator.animation, animation);
  assert.equal(animator.state, 'Walk');
  view.rerender(tree(animated('/blended-clips.gltf', { clip: 'Run', blend: 0.4 })));
  await flush();
  assert.deepEqual(animator.transitions, [{ state: 'Run', duration: 0.4 }]);
  animator.onPreUpdate(0.5);
  assert.equal(animator.time, 0.5);
  view.rerender(tree(animated('/blended-clips.gltf', { clip: 'Run', blend: 0.4, playing: false })));
  await flush();
  animator.onPreUpdate(0.5);
  assert.equal(animator.time, 0.5);
  view.rerender(tree(animated('/blended-clips.gltf', { clip: 'Run', blend: 0.4, loop: false })));
  await flush();
  animator.onPreUpdate(10);
  assert.equal(animator.time, 2);
  assert.deepEqual(animation.seeks, [2]);
  assert.equal(animation.clip, 1, 'the final seek must use the selected Run clip');
  animator.onPreUpdate(1);
  assert.equal(animator.time, 2);
  assert.deepEqual(animation.seeks, [2]);
});
test('enabling and disabling blend retains the running Animation and transitions through one lazy native Animator', async () => {
  const start = animators.length,
    view = render(tree(animated('/toggle-blend.gltf', { blend: 0 })));
  await flush();
  const animation = animations.at(-1);
  animation.onPreUpdate(0.6);
  assert.equal(animation.time, 0.6);
  assert.equal(animators.length, start, 'Zero blend must not create the optional mixer');
  view.rerender(tree(animated('/toggle-blend.gltf', { clip: 'Run', blend: 0.3 })));
  await flush();
  const animator = animators.at(-1);
  assert.equal(animations.at(-1), animation);
  assert.equal(animation.disposals, 0);
  assert.equal(animation.time, 0.6);
  assert.deepEqual(animation.playCalls, ['Walk']);
  assert.equal(animator.options.initial, 'Walk');
  assert.deepEqual(animator.steps, [0.6]);
  assert.deepEqual(animator.transitions, [{ state: 'Run', duration: 0.3 }]);
  animator.onPreUpdate(0.2);
  assert.equal(animator.time, 0.2);
  view.rerender(tree(animated('/toggle-blend.gltf', { clip: 'Walk', blend: 0 })));
  await flush();
  assert.equal(animations.at(-1), animation);
  assert.equal(animators.at(-1), animator);
  assert.equal(animators.length, start + 1);
  assert.equal(animator.disposals, 0);
  assert.deepEqual(animator.transitions, [
    { state: 'Run', duration: 0.3 },
    { state: 'Walk', duration: 0 },
  ]);
});
test('enabling blend after native clip playback crossfades from the current pose to the original rest pose', async () => {
  nativePlayback = true;
  const view = render(tree(animated('/native-toggle-blend.gltf', { blend: 0 })));
  await flush();
  const animation = animations.at(-1),
    model = animation.model;
  animation.onPreUpdate(0.5);
  assert.ok(Math.abs(model.nodes[1].position.x - 0.2) < 1e-7);
  view.rerender(tree(animated('/native-toggle-blend.gltf', { clip: 'Run', blend: 0.3 })));
  await flush();
  const animator = animators.at(-1);
  assert.ok(animation instanceof NativeAnimation);
  assert.ok(animator instanceof NativeAnimator);
  assert.equal(animations.at(-1), animation);
  assert.equal(animation.time, 0.5);
  assert.ok(
    Math.abs(model.nodes[1].position.x - 0.2) < 1e-7,
    'Attaching the mixer must retain the running visual pose',
  );
  animator.onPreUpdate(0.15);
  assert.ok(
    Math.abs(model.nodes[1].position.x - 0.1) < 1e-7,
    'The untracked Run clip must blend toward the original rest pose',
  );
  view.rerender(tree(animated('/native-toggle-blend.gltf', { clip: 'Walk', blend: 0 })));
  await flush();
  assert.equal(animators.at(-1), animator);
  animator.onPreUpdate(0);
  assert.equal(model.nodes[1].position.x, 0);
  assert.equal(animation.disposals, 0);
});
test('invalid clip errors name the animation and report through component and Canvas callbacks once', async () => {
  const errors = [];
  const view = render(
    tree(animated('/bad-clip.gltf', { clip: 'Missing', onError: (error) => errors.push(error) }), {
      onError: (error) => errors.push(error),
    }),
  );
  await flush();
  assert.equal(errors.length, 2);
  assert.match(errors[0].message, /Animation: unknown clip "Missing"/);
  assert.equal(errors[0], errors[1]);
  assert.match(view.getByRole('alert').textContent, /Missing/);
});
test('duplicate Animation children report ownership conflicts without removing the first plugin', async () => {
  const errors = [],
    start = animations.length;
  render(
    tree(
      h(
        Model,
        { src: '/duplicate-animation.gltf' },
        h(Animation, { clip: 'Walk' }),
        h(Animation, { clip: 'Run', onError: (error) => errors.push(error) }),
      ),
      { onError: (error) => errors.push(error) },
    ),
  );
  await flush();
  assert.equal(animations.length, start + 1);
  const animation = animations.at(-1);
  assert.equal(animation.disposals, 0);
  assert.equal(animation.engine.hasPlugin(animation.name), true);
  assert.deepEqual(animation.playCalls, ['Walk']);
  assert.equal(errors.length, 2);
  assert.match(errors[0].message, /already has an animation plugin/);
});
test('factor zero is the exact core PbrMaterial without a PBR model or native material installation', async () => {
  const ref = createRef(),
    start = models.length;
  const view = render(
    tree(
      h(
        Mesh,
        { ref },
        h(BoxGeometry),
        h(MeshTransmissionMaterial, { factor: 0, color: '#aabbcc', roughness: 0.2, metalness: 0.4 }),
      ),
    ),
  );
  await flush();
  const geometry = ref.current.geometry,
    data = ref.current.material.data.slice();
  assert.equal(models.length, start);
  assert.ok(geometry);
  view.rerender(
    tree(h(Mesh, { ref }, h(BoxGeometry), h(PbrMaterial, { color: '#aabbcc', roughness: 0.2, metalness: 0.4 }))),
  );
  await flush();
  assert.equal(ref.current.geometry, geometry);
  assert.deepEqual(ref.current.material.data, data);
});
test('positive transmission uses native install on a bridge with the original transform and pick id, and updates geometry', async () => {
  const ref = createRef();
  let clicks = 0;
  const content = (args) =>
    h(
      Mesh,
      { ref, position: [1, 2, 3], rotation: [0, 0.5, 0], scale: [2, 2, 2], onClick: () => clicks++ },
      h(BoxGeometry, { args }),
      h(MeshTransmissionMaterial, { factor: 0.8, ior: 1.4, volume: { thicknessFactor: 0.5 }, color: '#aabbcc' }),
    );
  const view = render(tree(content([1, 2, 3])));
  await flush();
  const original = ref.current,
    first = models.at(-1),
    primitive = first.primitives[0];
  assert.equal(original.geometry, null);
  assert.equal(primitive.node, original);
  assert.equal(primitive.vertices.length, 24 * 20);
  assert.equal(primitive.indices.length, 36);
  assert.equal(first.root.engine.store.parents[first.root.id], original.id);
  assert.equal(installations.at(-1).model, first);
  assert.equal(primitive.material.extension.nativeTransmission, true);
  assert.equal(primitive.material.transmission.factor, 0.8);
  assert.deepEqual([original.position.x, original.position.y, original.position.z], [1, 2, 3]);
  original.engine.pick = async () => original;
  const canvas = original.engine.canvas;
  await act(async () => {
    for (const type of ['pointerdown', 'pointerup']) {
      const event = new window.MouseEvent(type, { clientX: 20, clientY: 20, button: 0, bubbles: true });
      Object.defineProperty(event, 'pointerId', { value: 1 });
      canvas.dispatchEvent(event);
    }
  });
  await flush();
  assert.equal(clicks, 1);
  const picker = pickers.at(-1);
  assert.deepEqual(picker.options, { capture: false });
  assert.ok(picker.models.has(first));
  view.rerender(tree(content([3, 4, 5])));
  await flush();
  assert.equal(ref.current, original);
  assert.equal(first.disposals, 1);
  assert.notEqual(models.at(-1), first);
  assert.equal(models.at(-1).primitives[0].node, original);
});
test('removing positive transmission restores procedural geometry and changing back to zero removes native plugins', async () => {
  const ref = createRef(),
    content = (factor) => h(Mesh, { ref }, h(BoxGeometry), h(MeshTransmissionMaterial, { factor }));
  const view = render(tree(content(1)));
  await flush();
  const model = models.at(-1);
  assert.equal(ref.current.geometry, null);
  view.rerender(tree(content(0)));
  await flush();
  assert.equal(model.disposals, 1);
  assert.ok(ref.current.geometry);
  assert.equal(ref.current.engine.hasPlugin('materials:' + model.name), false);
});
test('native transmission setup failures keep a usable procedural mesh and report the original diagnostic', async () => {
  const errors = [],
    ref = createRef(),
    failure = new Error('Native transmission capture unavailable');
  installFailure = failure;
  render(
    tree(h(Mesh, { ref }, h(BoxGeometry), h(MeshTransmissionMaterial, { onError: (error) => errors.push(error) })), {
      onError: (error) => errors.push(error),
    }),
  );
  await flush();
  assert.deepEqual(errors, [failure, failure]);
  assert.ok(ref.current.geometry);
  assert.equal(models.at(-1).disposed, true);
});
