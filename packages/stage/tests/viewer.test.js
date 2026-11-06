import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

// The viewer's wiring against stand-ins; scripts/stage-viewer-gpu-check.js runs the real packages on real WebGPU.
const log = [];
const world = { modelFailure: null, lightFailure: null, modelGate: null };
const part = (name, extra = {}) => ({
  name,
  disposed: 0,
  dispose() {
    this.disposed++;
    log.push(`dispose ${name}`);
  },
  ...extra,
});
const bounds = new Float32Array([-1, 0, -2, 1, 2, 2]);
const loadGLTF = async (engine, url, options) => {
  log.push(`load ${url}`);
  world.options = options;
  if (world.modelGate) await world.modelGate;
  options.signal.throwIfAborted();
  if (world.modelFailure) throw world.modelFailure;
  return (world.model = part('model', {
    bounds: world.emptyModel ? new Float32Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]) : bounds,
  }));
};
const EnvironmentLighting = {
  async load(engine, source, options) {
    log.push('light');
    world.source = source;
    world.lightOptions = options;
    if (world.lightFailure) throw world.lightFailure;
    return (world.light = part('light', { added: [], add: (model) => world.light.added.push(model) }));
  },
};
const ColorBackground = {
  attach(engine, options) {
    return (world.backdrop = part('backdrop', { options }));
  },
};
const ContactShadows = {
  attach(engine, options) {
    return (world.contact = part('contact', {
      options,
      add(model) {
        this.source = model;
      },
    }));
  },
};
const Shadows = {
  attach(engine, options) {
    return (world.cast = part('shadows', {
      options,
      added: [],
      add(source, how) {
        this.added.push([source, how]);
      },
    }));
  },
};
const Tonemap = {
  attach(engine, options) {
    if (world.tonemapFailure) throw world.tonemapFailure;
    return (world.tonemap = part('tonemap', { options }));
  },
};
mock.module('@margoengine/gltf-pro', { namedExports: { loadGLTF } });
mock.module('@margoengine/environment', { namedExports: { EnvironmentLighting, ColorBackground } });
mock.module('@margoengine/staging', { namedExports: { ContactShadows } });
mock.module('@margoengine/shadows', { namedExports: { Shadows } });
mock.module('@margoengine/tonemap', { namedExports: { Tonemap } });
const { addViewer } = await import('@margoengine/stage/viewer');

function fixture() {
  log.length = 0;
  for (const key of Object.keys(world)) world[key] = null;
  const disposal = new AbortController(),
    ticks = new Set(),
    canvas = new EventTarget();
  Object.assign(canvas, { clientWidth: 800, clientHeight: 400 });
  const stage = {
    canvas,
    signal: disposal.signal,
    engine: {
      camera: {
        position: [0, 2, 5],
        target: [0, 0, 0],
        near: 0.1,
        far: 1000,
        fitToBoundingBox(min, max, options) {
          this.fit = { min, max, options };
        },
      },
    },
    onTick(callback) {
      ticks.add(callback);
      return () => ticks.delete(callback);
    },
    box(options) {
      return (world.floor = part('floor', { options }));
    },
  };
  return { stage, canvas, tick: (delta) => ticks.forEach((tick) => tick(delta)), ticks, dispose: () => disposal.abort() };
}

test('defaults: model, studio light on it, contact shadow fitted to it, tonemap, framed camera, turntable', async () => {
  const { stage } = fixture(),
    viewer = await addViewer(stage, '/shoe.glb');
  assert.equal(viewer.model, world.model);
  assert.equal(viewer.environment, world.light);
  assert.deepEqual(world.light.added, [world.model]);
  assert.deepEqual(
    [world.source.width, world.source.height, world.source.data.length],
    [128, 64, 128 * 64 * 4],
    'the built-in studio is an RGBA equirect',
  );
  assert.ok(world.source.data.every(Number.isFinite));
  assert.ok(Math.max(...world.source.data) > 4, 'the lamps are brighter than display white, or nothing glints');
  assert.equal(viewer.background, world.backdrop);
  assert.equal(world.backdrop.options.color, '#dfe1e4');
  assert.equal(viewer.shadows, world.contact);
  assert.deepEqual(world.contact.options.position, [0, 0, 0], 'on the ground under the model');
  assert.equal(world.contact.options.size, 12, 'three times the larger footprint side');
  assert.equal(world.contact.options.height, 2);
  assert.equal(world.contact.source, world.model);
  assert.equal(world.contact.options.static, true);
  assert.equal(viewer.floor, null);
  assert.equal(viewer.tonemap, world.tonemap);
  assert.equal(viewer.turntable, true);
  const { camera } = stage.engine,
    size = Math.hypot(2, 2, 4);
  assert.deepEqual(camera.target, [0, 1, 0]);
  assert.deepEqual([camera.near, camera.far], [size / 200, size * 50]);
  assert.deepEqual(camera.fit.min, [-1, 0, -2]);
  assert.deepEqual(camera.fit.max, [1, 2, 2]);
  assert.deepEqual(camera.fit.options, { aspect: 2, duration: 0 });
});

test('each part can be left out, and then its package is not imported', async () => {
  const { stage } = fixture(),
    viewer = await addViewer(stage, '/shoe.glb', {
      environment: false,
      background: false,
      shadows: false,
      tonemap: false,
      turntable: false,
      fit: false,
    });
  assert.deepEqual(log, ['load /shoe.glb']);
  assert.deepEqual([viewer.environment, viewer.shadows, viewer.tonemap, viewer.turntable], [null, null, null, false]);
  assert.equal(stage.engine.camera.fit, undefined);
  assert.deepEqual(stage.engine.camera.position, [0, 2, 5]);
});

test('options reach the packages they belong to', async () => {
  const { stage } = fixture(),
    draco = {};
  await addViewer(stage, '/shoe.glb', {
    environment: '/studio.hdr',
    lighting: { intensity: 2 },
    shadow: { opacity: 0.3, static: false },
    tonemap: { exposure: 1 },
    gltf: { draco },
  });
  assert.equal(world.source, '/studio.hdr');
  assert.equal(world.lightOptions.intensity, 2);
  assert.equal(world.contact.options.static, false);
  assert.equal(world.contact.options.opacity, 0.3);
  assert.deepEqual(world.tonemap.options, { exposure: 1 });
  assert.equal(world.options.draco, draco);
});

test('cascaded shadows get a floor at the foot of the model, and bounds, bias sized to it', async () => {
  const { stage } = fixture(),
    viewer = await addViewer(stage, '/shoe.glb', { shadows: 'cascaded' }),
    size = Math.hypot(2, 2, 4);
  assert.equal(viewer.shadows, world.cast);
  assert.equal(viewer.floor, world.floor);
  const { position, size: extent } = world.floor.options;
  assert.ok(Math.abs(position[1] + extent[1] / 2) < 1e-9, 'the top of the floor is the bottom of the model');
  assert.ok(extent[0] >= size * 2);
  assert.deepEqual(world.cast.added, [
    [world.model, { static: true }],
    [world.floor, { static: true, castShadow: false }],
  ]);
  assert.equal(world.cast.options.normalBias, size * 0.002);
  assert.ok(world.cast.options.bounds.max[1] >= 2);
});

test('the turntable orbits at the set speed, keeps height and radius, and waits for the visitor', async () => {
  const { stage, canvas, tick } = fixture(),
    viewer = await addViewer(stage, '/shoe.glb', { turntable: { seconds: 4, resumeAfter: 1 }, fit: false }),
    { camera } = stage.engine;
  camera.position = [0, 2, 5];
  tick(1); // a quarter turn
  assert.ok(Math.abs(camera.position[0] - 5) < 1e-9 && Math.abs(camera.position[2]) < 1e-9, String(camera.position));
  assert.equal(camera.position[1], 2);
  canvas.dispatchEvent(new Event('pointerdown'));
  const held = [...camera.position];
  tick(1);
  assert.deepEqual(camera.position, held, 'a drag owns the camera');
  canvas.dispatchEvent(new Event('pointerup'));
  tick(0.5);
  assert.deepEqual(camera.position, held, 'it waits resumeAfter seconds');
  tick(0.6);
  tick(0.5);
  assert.notDeepEqual(camera.position, held);
  canvas.dispatchEvent(new Event('wheel'));
  const zoomed = [...camera.position];
  tick(0.5);
  assert.deepEqual(camera.position, zoomed, 'the wheel pauses it too');
  viewer.turntable = false;
  tick(5);
  assert.deepEqual(camera.position, zoomed);
});

test('a visitor who asks for reduced motion gets a still model until the page turns it on', async (t) => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'matchMedia');
  t.after(() => (saved ? Object.defineProperty(globalThis, 'matchMedia', saved) : delete globalThis.matchMedia));
  globalThis.matchMedia = (query) => ({ matches: query === '(prefers-reduced-motion: reduce)' });
  const { stage, tick } = fixture(),
    viewer = await addViewer(stage, '/shoe.glb', { fit: false }),
    { camera } = stage.engine;
  assert.equal(viewer.turntable, false);
  tick(1);
  assert.deepEqual(camera.position, [0, 2, 5]);
  viewer.turntable = true;
  tick(1);
  assert.notDeepEqual(camera.position, [0, 2, 5]);
});

test('dispose removes everything in reverse order, once, and stops the turntable', async () => {
  const { stage, canvas, ticks } = fixture(),
    viewer = await addViewer(stage, '/shoe.glb', { shadows: 'cascaded' });
  log.length = 0;
  viewer.dispose();
  viewer[Symbol.dispose]();
  assert.deepEqual(log, [
    'dispose tonemap',
    'dispose floor',
    'dispose shadows',
    'dispose backdrop',
    'dispose light',
    'dispose model',
  ]);
  assert.equal(ticks.size, 0);
  canvas.dispatchEvent(new Event('pointerdown'));
});

test('any failure leaves nothing behind', async () => {
  const { stage, ticks } = fixture();
  world.lightFailure = new Error('bad hdr');
  await assert.rejects(addViewer(stage, '/shoe.glb'), /bad hdr/);
  assert.deepEqual(log.slice(-1), ['dispose model']);
  world.lightFailure = null;
  world.modelFailure = new Error('bad glb');
  await assert.rejects(addViewer(stage, '/shoe.glb'), /bad glb/);
  assert.deepEqual(log.slice(-1), ['dispose light']);
  world.modelFailure = null;
  world.tonemapFailure = new Error('no tonemap');
  log.length = 0;
  await assert.rejects(addViewer(stage, '/shoe.glb'), /no tonemap/);
  assert.deepEqual(log.slice(-4), ['dispose contact', 'dispose backdrop', 'dispose light', 'dispose model']);
  assert.equal(ticks.size, 0);
});

test('a model with nothing to frame rejects and leaves nothing behind', async () => {
  const { stage } = fixture();
  world.emptyModel = true;
  await assert.rejects(addViewer(stage, '/empty.glb'), { code: 'state', message: /no geometry/ });
  assert.deepEqual(log.slice(-2), ['dispose light', 'dispose model']);
});

test('abort and stage disposal reject with AbortError and add nothing', async () => {
  const { stage, dispose } = fixture(),
    caller = new AbortController();
  let open;
  world.modelGate = new Promise((resolve) => (open = resolve));
  const pending = addViewer(stage, '/shoe.glb', { signal: caller.signal });
  await new Promise((resolve) => setTimeout(resolve));
  caller.abort();
  open();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(world.light.disposed, 1);
  world.modelGate = null;
  dispose();
  await assert.rejects(addViewer(stage, '/shoe.glb'), { name: 'AbortError' });
});

test('after the stage is disposed the engine owns the teardown, so dispose touches nothing', async () => {
  const { stage, dispose } = fixture(),
    viewer = await addViewer(stage, '/shoe.glb');
  log.length = 0;
  dispose();
  viewer.dispose();
  assert.deepEqual(log, []);
});

test('bad options throw before anything loads', async () => {
  const { stage } = fixture();
  await assert.rejects(addViewer(stage, '/shoe.glb', { shadows: 'soft' }), TypeError);
  await assert.rejects(addViewer(stage, '/shoe.glb', { fit: 1 }), TypeError);
  await assert.rejects(addViewer(stage, '/shoe.glb', { turntable: { seconds: 0 } }), RangeError);
  await assert.rejects(addViewer(stage, '/shoe.glb', { turntable: { resumeAfter: -1 } }), RangeError);
  assert.deepEqual(log, []);
});
