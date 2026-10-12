import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gzipSync} from 'node:zlib';
import {build} from 'vite';
import {Planet} from '../dist/index.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const identity = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
function globals(t, values) {
  for (const [name, value] of Object.entries(values)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, {configurable: true, writable: true, value});
    t.after(() => {if (previous) Object.defineProperty(globalThis, name, previous); else delete globalThis[name];});
  }
}
function fixture(t) {
  const state = {allocations: 0, bitmaps: [], resources: [], writes: [], draws: [], descriptors: [], uploads: 0};
  const resource = (kind, descriptor) => {
    state.allocations++;
    const value = {kind, descriptor, destroyed: 0, destroy() {this.destroyed++;}, createView() {state.allocations++; return {};}, getBindGroupLayout() {return {};}};
    state.resources.push(value); return value;
  };
  const device = {
    features: new Set(), limits: {maxTextureDimension2D: 8192},
    queue: {writeBuffer(buffer, offset, data) {state.writes.push({buffer, data});}, writeTexture() {}, copyExternalImageToTexture() {state.uploads++;}},
    createBuffer: descriptor => resource('buffer', descriptor),
    createTexture: descriptor => resource('texture', descriptor),
    createSampler: descriptor => resource('sampler', descriptor),
    createBindGroupLayout: descriptor => resource('layout', descriptor),
    createPipelineLayout: descriptor => resource('pipeline-layout', descriptor),
    createBindGroup: descriptor => resource('group', descriptor),
    createShaderModule: descriptor => ({...resource('shader', descriptor), async getCompilationInfo() {return {messages: []};}}),
    createRenderPipeline: descriptor => {if (state.failPipeline) throw new Error('Pipeline failed'); return resource('pipeline', descriptor);},
    createRenderPipelineAsync: async descriptor => device.createRenderPipeline(descriptor),
    pushErrorScope() {}, async popErrorScope() {return state.validationError ?? null;},
  };
  const graph = {passes: [], add(pass) {this.passes.push(pass); return () => {this.passes = this.passes.filter(value => value !== pass);};}, removeOwner() {this.passes = [];}};
  let next = 0;
  const engine = {
    gpu: device, backend: 'webgpu', disposed: false, plugins: new Map(), meshes: new Map(), frameGraph: graph,
    camera: {matrix: identity(), position: [0, 0, 4]}, canvas: {},
    hasPlugin(name) {return this.plugins.has(name);},
    use(plugin) {
      if (this.disposed) throw new Error('Engine is disposed');
      if (this.plugins.has(plugin.name)) throw new TypeError('Duplicate plugin');
      try {plugin.setup(this); plugin.registerPasses?.(graph); this.plugins.set(plugin.name, plugin);}
      catch (error) {graph.removeOwner(); plugin.dispose?.(); throw error;}
      return this;
    },
    removePlugin(name) {const plugin = this.plugins.get(name); if (plugin) {this.plugins.delete(name); graph.removeOwner(); plugin.dispose();}},
    createMesh(parent = null) {
      const vector = () => ({x: 0, y: 0, z: 0, set(x, y, z) {this.x = x; this.y = y; this.z = z; return this;}});
      const mesh = {
        id: next++, parent, matrix: identity(), rotation: vector(), scale: vector(), position: vector(),
        setParent(value) {this.parent = value; return this;},
        setRotation(value) {this.rotation.set(...value); return this;},
        setScale(value) {this.scale.set(...value); return this;},
        dispose() {engine.meshes.delete(this.id);},
      };
      this.meshes.set(mesh.id, mesh); return mesh;
    },
    dispose() {for (const name of this.plugins.keys()) this.removePlugin(name); this.disposed = true;},
  };
  globals(t, {
    GPUBufferUsage: {COPY_DST: 8, VERTEX: 32, INDEX: 16, UNIFORM: 64, STORAGE: 128},
    GPUTextureUsage: {COPY_DST: 2, TEXTURE_BINDING: 4, RENDER_ATTACHMENT: 16},
    GPUShaderStage: {VERTEX: 1, FRAGMENT: 2},
    navigator: {gpu: {getPreferredCanvasFormat: () => 'bgra8unorm'}},
    location: {href: 'https://planet.test/'},
    fetch: async () => new Response(new Uint8Array([1, 2, 3]), {headers: {'content-type': 'image/png'}}),
    createImageBitmap: async () => {
      const image = {width: 16, height: 8, closed: 0, close() {this.closed++;}};
      state.bitmaps.push(image); return image;
    },
  });
  const context = () => ({
    backend: 'webgpu', device: engine.gpu, format: 'bgra8unorm', color: {}, depth: {}, width: 256, height: 256,
    camera: engine.camera, delta: 0.016, descriptor: {depthStencil: {format: 'depth32float'}},
    encoder: {beginRenderPass(descriptor) {state.descriptors.push(descriptor); return {setPipeline() {}, setBindGroup() {}, setVertexBuffer() {}, setIndexBuffer() {}, drawIndexed(...args) {state.draws.push(args);}, end() {}};}},
  });
  const frame = () => {for (const pass of graph.passes) pass.execute(context());};
  return {engine, state, device, frame, graph};
}

test('Planet owns two transform nodes, two draws, retained uploads and detachable resources', async t => {
  const {engine, state, frame, graph} = fixture(t);
  const planet = await Planet.create(engine, {dayMap: '/day.png', clouds: '/clouds.png', tilt: 23.4});
  assert.equal(engine.plugins.get('planet'), planet);
  assert.equal(engine.meshes.size, 2);
  const child = [...engine.meshes.values()].find(mesh => mesh.parent);
  assert.equal(planet.rotation, child.rotation);
  assert.ok(Math.abs(child.parent.rotation.z - 23.4 * Math.PI / 180) < 1e-6);
  planet.clouds.offsetU = -0.25;
  assert.equal(planet.clouds.offsetU, 0.75);
  assert.throws(() => {planet.clouds.offsetU = NaN;}, /finite|Invalid|offset/i);
  assert.throws(() => planet.setSunDirection([0, 0, 0]), /nonzero|direction/i);
  planet.setSunDirection([-2, 0, 0]);
  frame();
  assert.equal(state.draws.length, 2);
  const allocations = state.allocations, uploads = state.uploads;
  const uniform = state.writes.find(write => write.data instanceof Float32Array && write.data.length === 48)?.data;
  assert.ok(uniform, 'Expected retained 192-byte planet uniform data');
  for (let i = 0; i < 4; i++) frame();
  assert.equal(state.allocations, allocations, 'Steady frames allocated GPU resources or views');
  assert.equal(state.uploads, uploads, 'Steady frames re-uploaded image assets');
  assert.ok(state.writes.filter(write => write.data.length === 48).every(write => write.data === uniform));
  assert.equal(uniform[36], -1);
  assert.equal(uniform[39], 0.75);
  assert.equal(uniform[46], 3, 'Planet factory must preserve the night emission boost');
  assert.equal(new Set(state.descriptors).size, 2, 'Steady frames replaced pass descriptors');
  planet.dispose(); planet.dispose();
  assert.equal(engine.hasPlugin('planet'), false);
  assert.equal(engine.meshes.size, 0);
  assert.equal(graph.passes.length, 0);
  assert.ok(state.bitmaps.every(image => image.closed === 1));
  assert.ok(state.resources.filter(value => ['buffer', 'texture'].includes(value.kind)).every(value => value.destroyed === 1));
});

test('invalid options and unsupported engines fail without attached state', async t => {
  const {engine} = fixture(t);
  for (const options of [{radius: 0}, {tilt: Infinity}, {sunDirection: [0, 0, 0]}, {atmosphere: {color: [-1, 0, 0]}}]) {
    await assert.rejects(Planet.create(engine, {dayMap: '/day.png', ...options}));
    assert.equal(engine.plugins.size, 0); assert.equal(engine.meshes.size, 0);
  }
  engine.backend = 'webgl2'; engine.gpu = null;
  await assert.rejects(Planet.create(engine, {dayMap: '/day.png'}), /WebGPU/);
  assert.equal(engine.plugins.size, 0);
});

test('engine teardown aborts an in-flight fetch and removes loading passes', async t => {
  const {engine, state, frame} = fixture(t);
  let started;
  const requested = new Promise(resolve => {started = resolve;});
  globals(t, {fetch: (url, {signal}) => new Promise((resolve, reject) => {
    started(signal); signal.addEventListener('abort', () => reject(signal.reason), {once: true});
  })});
  const loading = Planet.create(engine, {dayMap: '/slow.png'});
  const signal = await requested;
  frame(); assert.equal(state.draws.length, 0, 'Loading planet drew partial resources');
  engine.dispose();
  await assert.rejects(loading);
  assert.equal(signal.aborted, true);
  assert.equal(engine.meshes.size, 0); assert.equal(engine.plugins.size, 0);
});

test('maps download concurrently and a failed map aborts siblings before rollback', async t => {
  const {engine, state} = fixture(t), requests = [];
  let fail;
  globals(t, {fetch: (url, {signal}) => new Promise((resolve, reject) => {
    requests.push({url, signal});
    if (url === '/day.png') fail = () => resolve(new Response(null, {status: 503}));
    signal.addEventListener('abort', () => reject(signal.reason), {once: true});
  })});
  const loading = Planet.create(engine, {dayMap: '/day.png', nightMap: '/night.png', clouds: '/clouds.png'});
  assert.deepEqual(requests.map(request => request.url), ['/day.png', '/night.png', '/clouds.png']);
  fail();
  await assert.rejects(loading, /503/);
  assert.ok(requests.every(request => request.signal.aborted));
  assert.equal(engine.plugins.size, 0); assert.equal(engine.meshes.size, 0);
  assert.ok(state.bitmaps.every(image => image.closed === 1));
});

test('a sibling image decoded after a failed map is closed before create rejects', async t => {
  const {engine} = fixture(t);
  let decoded, started, fail;
  const decoding = new Promise(resolve => {started = resolve;});
  const image = {width: 16, height: 8, closed: 0, close() {this.closed++;}};
  globals(t, {
    fetch: (url) => url === '/night.png' ? new Promise(resolve => {fail = () => resolve(new Response(null, {status: 503}));}) : Promise.resolve(new Response(new Uint8Array([1]))),
    createImageBitmap: () => new Promise(resolve => {decoded = resolve; started();}),
  });
  const loading = Planet.create(engine, {dayMap: '/day.png', nightMap: '/night.png'});
  await decoding; fail(); await new Promise(resolve => setImmediate(resolve)); decoded(image);
  await assert.rejects(loading, /503/);
  assert.equal(image.closed, 1); assert.equal(engine.plugins.size, 0); assert.equal(engine.meshes.size, 0);
});

test('caller cancellation closes an image decoded after teardown', async t => {
  const {engine} = fixture(t);
  let decoded, started;
  const decoding = new Promise(resolve => {started = resolve;});
  const image = {width: 16, height: 8, closed: 0, close() {this.closed++;}};
  globals(t, {createImageBitmap: () => new Promise(resolve => {decoded = resolve; started();})});
  const controller = new AbortController();
  const loading = Planet.create(engine, {dayMap: '/day.png', signal: controller.signal});
  await decoding; controller.abort(); decoded(image);
  await assert.rejects(loading);
  assert.equal(image.closed, 1);
  assert.equal(engine.plugins.size, 0); assert.equal(engine.meshes.size, 0);
});

test('texture and pipeline failures roll back decoded and allocated resources', async t => {
  const {engine, state} = fixture(t);
  globals(t, {fetch: async url => new Response(new Uint8Array([1]), {status: String(url).includes('night') ? 503 : 200})});
  await assert.rejects(Planet.create(engine, {dayMap: '/day.png', nightMap: '/night.png'}), /503/);
  assert.equal(engine.plugins.size, 0); assert.equal(engine.meshes.size, 0);
  assert.ok(state.bitmaps.every(image => image.closed === 1));
  globals(t, {fetch: async () => new Response(new Uint8Array([1]))});
  state.failPipeline = true;
  await assert.rejects(Planet.create(engine, {dayMap: '/day.png'}), /Pipeline failed/);
  assert.equal(engine.plugins.size, 0); assert.equal(engine.meshes.size, 0);
  assert.ok(state.bitmaps.every(image => image.closed === 1));
  assert.ok(state.resources.filter(value => ['buffer', 'texture'].includes(value.kind)).every(value => value.destroyed === 1));
});

test('restoration reuses decoded images and transform refs, then full disposal closes images', async t => {
  const {engine, state, frame, device} = fixture(t);
  const planet = await Planet.create(engine, {dayMap: '/day.png', clouds: '/cloud.png'});
  const rotation = planet.rotation, nodes = [...engine.meshes.values()];
  const images = [...state.bitmaps], uploads = state.uploads;
  engine.gpu = {...device};
  planet.onDeviceRestored(engine); frame();
  assert.equal(planet.rotation, rotation); assert.deepEqual([...engine.meshes.values()], nodes);
  assert.equal(state.bitmaps.length, images.length);
  assert.ok(images.every(image => image.closed === 0));
  assert.ok(state.uploads > uploads);
  engine.dispose(); assert.ok(images.every(image => image.closed === 1));
});

test('GPU validation failure rolls back the candidate pass before create resolves', async t => {
  const {engine, state} = fixture(t);
  state.validationError = {message: 'mock invalid pipeline'};
  await assert.rejects(Planet.create(engine, {dayMap: '/day.png'}), /mock invalid pipeline/);
  assert.equal(engine.plugins.size, 0); assert.equal(engine.meshes.size, 0);
  assert.ok(state.bitmaps.every(image => image.closed === 1));
  assert.ok(state.resources.filter(value => ['buffer', 'texture'].includes(value.kind)).every(value => value.destroyed === 1));
});

test('device replacement during asynchronous GPU validation retires only the old candidate', async t => {
  const {engine, state, device, frame} = fixture(t);
  let release, started;
  const validating = new Promise(resolve => {started = resolve;});
  device.popErrorScope = () => new Promise(resolve => {release = resolve; started();});
  const loading = Planet.create(engine, {dayMap: '/day.png'});
  await validating;
  const old = state.resources.filter(value => ['buffer', 'texture'].includes(value.kind));
  engine.gpu = {...device, async popErrorScope() {return null;}};
  engine.plugins.get('planet').onDeviceRestored(engine); release(null);
  const planet = await loading; frame();
  assert.ok(old.every(value => value.destroyed === 1));
  assert.ok(state.bitmaps.every(image => image.closed === 0));
  assert.equal(state.draws.length, 2);
  planet.dispose();
  assert.ok(state.resources.filter(value => ['buffer', 'texture'].includes(value.kind)).every(value => value.destroyed === 1));
});

test('Planet remains optional in core and particle consumer bundles', async () => {
  for (const kind of ['core', 'particle']) {
    const result = await build({
      root, configFile: false, publicDir: false, logLevel: 'silent',
      build: {write: false, minify: true, target: 'es2022', lib: {entry: resolve(root, `tests/fixtures/${kind}-consumer.js`), formats: ['es']},
        rollupOptions: {external: kind === 'particle' ? ['@margoengine/core', '@margoengine/core/extension'] : []}},
    });
    const chunks = (Array.isArray(result) ? result[0] : result).output.filter(item => item.type === 'chunk');
    const code = chunks.map(chunk => chunk.code).join('\n');
    assert.ok(!code.includes('cloudOffset') && !code.includes('Planet requires WebGPU'), `Planet code leaked into ${kind} bundle`);
    if (kind === 'core') assert.ok(gzipSync(code).length < 20 * 1024, 'Existing core bundle exceeds its 20 KiB gzip budget');
  }
});
