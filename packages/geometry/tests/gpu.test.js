// The CPU side of GPU geometry: topology, validation and when work is sent, with a recording stand-in for the device.
// What the shaders produce is checked on a real GPU by tests/gpu-check.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { GeometryGenerator, gridIndices } from '../dist/gpu.js';

globalThis.GPUBufferUsage ??= { UNIFORM: 1, COPY_DST: 2, STORAGE: 4, COPY_SRC: 8, MAP_READ: 16 };
globalThis.GPUMapMode ??= { READ: 1 };

function fakeEngine(gpu = true) {
  const log = { dispatches: [], writes: 0, modules: 0, destroyed: 0, groups: 0 },
    buffer = () => ({ destroy: () => log.destroyed++ }),
    pipeline = { getBindGroupLayout: () => ({}) },
    device = {
      createBuffer: buffer,
      createShaderModule: () => (log.modules++, {}),
      createComputePipeline: () => pipeline,
      createBindGroup: () => (log.groups++, {}),
      queue: { writeBuffer: () => log.writes++ },
    },
    vertexBuffers = new Map(),
    passes = [],
    plugins = [],
    engine = {
      gpu: gpu ? device : null,
      use(plugin) {
        plugin.setup(engine);
        plugins.push(plugin);
        plugin.registerPasses({ add: (pass) => passes.push(pass) });
      },
      geometryBuffers(geometry) {
        if (!vertexBuffers.has(geometry)) vertexBuffers.set(geometry, { vertex: buffer() });
        return vertexBuffers.get(geometry);
      },
    },
    frame = (batches, view, delta = 0) => {
      // The engine prepares once per frame; later views of that frame only run the passes.
      if (!view || view.index === 0) for (const plugin of plugins) plugin.onPreUpdate(delta);
      passes[0].execute({
        backend: 'webgpu',
        batches,
        view,
        device,
        encoder: {
          beginComputePass: () => ({
            setPipeline() {},
            setBindGroup() {},
            dispatchWorkgroups: (count) => log.dispatches.push(count),
            end() {},
          }),
        },
      });
    };
  return { engine, log, frame, passes, vertexBuffers };
}

test('grid indices cover every cell, with shared vertices and one winding', () => {
  const indices = gridIndices(3, 2);
  assert.equal(indices.length, 3 * 2 * 6);
  assert.equal(Math.max(...indices), 4 * 3 - 1);
  assert.deepEqual([...indices.slice(0, 6)], [0, 1, 5, 0, 5, 4]);
  const edges = new Map();
  for (let t = 0; t < indices.length; t += 3)
    for (let k = 0; k < 3; k++) {
      const key = `${indices[t + k]}>${indices[t + ((k + 1) % 3)]}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  for (const [edge, count] of edges) assert.equal(count, 1, `directed edge ${edge} once`);
});

test('each kind gets the size and params it was asked for', () => {
  const { engine } = fakeEngine(),
    generator = GeometryGenerator.attach(engine);
  const sphere = generator.sphere({ radius: 2 });
  assert.equal(sphere.vertexCount, 33 * 17);
  assert.deepEqual([...sphere.params], [2, 0, 0, 0]);
  assert.deepEqual([...generator.torus({ radius: 3, tube: 0.5 }).params], [3, 0.5, 0, 0]);
  assert.deepEqual([...generator.cylinder({ radiusTop: 1, radiusBottom: 2, height: 5 }).params], [1, 2, 5, 0]);
  assert.deepEqual([...generator.grid({ width: 4, depth: 2 }).params], [4, 2, 0, 0]);
  const rope = generator.tube({ points: 4, sides: 6, segments: 10, radius: 0.5 });
  assert.equal(rope.vertexCount, 7 * 11);
  assert.equal(rope.geometry.indices.length, 6 * 10 * 6);
  assert.equal(generator.tube({ points: 4 }).rows, 64, 'segments default to 16 per point');
  assert.equal(generator.ribbon({ points: 3, segments: 5 }).vertexCount, 2 * 6);
  const custom = generator.surface({ code: 'fn surface(u: f32, v: f32, time: f32, p: vec4f) -> vec3f { return vec3f(u); }', columns: 2, rows: 3 });
  assert.equal(custom.vertexCount, 3 * 4);
  assert.equal(custom.geometry.indices.length, 2 * 3 * 6);
});

test('bounds go on the geometry, and default to never culled', () => {
  const { engine } = fakeEngine(),
    generator = GeometryGenerator.attach(engine);
  assert.deepEqual([...generator.sphere().geometry.bounds], [0, 0, 0, 1_000_000]);
  assert.deepEqual([...generator.sphere({ bounds: 3 }).geometry.bounds], [0, 0, 0, 3]);
  assert.deepEqual([...generator.sphere({ bounds: [1, 2, 3, 4] }).geometry.bounds], [1, 2, 3, 4]);
  assert.throws(() => generator.sphere({ bounds: 0 }), RangeError);
  assert.throws(() => generator.sphere({ bounds: [1, 2, 3] }), RangeError);
});

test('work goes out only for geometry on a mesh, once a frame', () => {
  const { engine, log, frame } = fakeEngine(),
    generator = GeometryGenerator.attach(engine),
    sphere = generator.sphere({ columns: 7, rows: 7 }),
    unused = generator.sphere();
  frame([]);
  assert.deepEqual(log.dispatches, [], 'nothing is drawn yet');
  frame([{ geometry: sphere.geometry }]);
  assert.deepEqual(log.dispatches, [1], '64 vertices is one group');
  frame([{ geometry: sphere.geometry }], { index: 1 });
  assert.deepEqual(log.dispatches, [1], 'a later view reuses the frame');
  assert.notEqual(unused.geometry, sphere.geometry);
  sphere.active = false;
  frame([{ geometry: sphere.geometry }]);
  assert.deepEqual(log.dispatches, [1], 'a paused item keeps its last result');
});

test('a later view generates what only it draws, and nothing twice', () => {
  const { engine, log, frame } = fakeEngine(),
    generator = GeometryGenerator.attach(engine),
    a = generator.sphere({ columns: 7, rows: 7 }),
    b = generator.sphere({ columns: 15, rows: 15 });
  frame([{ geometry: a.geometry }], { index: 0 });
  frame([{ geometry: a.geometry }, { geometry: b.geometry }], { index: 1 });
  assert.deepEqual(log.dispatches, [1, 4]);
  frame([{ geometry: a.geometry }], { index: 0 });
  assert.deepEqual(log.dispatches, [1, 4, 1], 'the next frame starts over');
});

test('time follows the frame for active items only', () => {
  const { engine, frame } = fakeEngine(),
    generator = GeometryGenerator.attach(engine),
    running = generator.sphere(),
    paused = generator.sphere();
  paused.active = false;
  frame([], undefined, 0.25);
  frame([], undefined, 0.25);
  assert.equal(running.time, 0.5);
  assert.equal(paused.time, 0);
});

test('paths walk their frames first, then build vertices', () => {
  const { engine, log, frame } = fakeEngine(),
    generator = GeometryGenerator.attach(engine),
    rope = generator.tube({ points: 4, sides: 7, segments: 15 });
  frame([{ geometry: rope.geometry }]);
  assert.deepEqual(log.dispatches, [1, 2]);
});

test('a new vertex buffer gets a new binding', () => {
  const { engine, log, frame, vertexBuffers } = fakeEngine(),
    generator = GeometryGenerator.attach(engine),
    sphere = generator.sphere();
  frame([{ geometry: sphere.geometry }]);
  frame([{ geometry: sphere.geometry }]);
  assert.equal(log.groups, 1, 'kept between frames');
  vertexBuffers.get(sphere.geometry).vertex = { destroy() {} };
  frame([{ geometry: sphere.geometry }]);
  assert.equal(log.groups, 2, 'core replaced the buffer');
  const rope = generator.tube({ points: 3 });
  frame([{ geometry: rope.geometry }]);
  frame([{ geometry: rope.geometry }]);
  assert.equal(log.groups, 4, 'a path keeps both of its bindings');
});

test('pipelines are shared by items with the same code', () => {
  const { engine, log, frame } = fakeEngine(),
    generator = GeometryGenerator.attach(engine),
    a = generator.sphere(),
    b = generator.sphere({ radius: 3 });
  frame([{ geometry: a.geometry }, { geometry: b.geometry }]);
  assert.equal(log.modules, 1);
});

test('dispose stops generating and frees what the item owns', () => {
  const { engine, log, frame } = fakeEngine(),
    generator = GeometryGenerator.attach(engine),
    rope = generator.tube({ points: 3 });
  rope.dispose();
  assert.equal(log.destroyed, 3, 'settings, points and frames');
  rope.dispose();
  assert.equal(log.destroyed, 3, 'twice is harmless');
  frame([{ geometry: rope.geometry }]);
  assert.deepEqual(log.dispatches, []);
  assert.throws(() => rope.setPoints(new Float32Array(12)), /disposed/);
  assert.throws(() => rope.points, /disposed/);
  {
    using sphere = generator.sphere();
    assert.ok(sphere);
  }
  assert.equal(log.destroyed, 4);
  const other = generator.sphere();
  generator.dispose();
  assert.equal(log.destroyed, 5);
  assert.throws(() => generator.sphere(), /not attached/);
  assert.ok(other);
});

test('setPoints takes arrays or flat values and refuses the wrong size', () => {
  const { engine, log } = fakeEngine(),
    generator = GeometryGenerator.attach(engine),
    rope = generator.tube({ points: 2 }),
    before = log.writes;
  rope.setPoints([
    [0, 0, 0],
    [1, 2, 3, 0.5],
  ]);
  rope.setPoints(new Float32Array(8));
  assert.equal(log.writes, before + 2);
  assert.throws(() => rope.setPoints([[0, 0, 0]]), RangeError);
  assert.throws(() => rope.setPoints(new Float32Array(8).fill(NaN)), RangeError);
});

test('options are checked before anything is made', () => {
  const { engine } = fakeEngine(),
    generator = GeometryGenerator.attach(engine);
  assert.throws(() => generator.sphere({ columns: 0 }), RangeError);
  assert.throws(() => generator.sphere({ rows: 1.5 }), RangeError);
  assert.throws(() => generator.grid({ columns: 2000, rows: 2000 }), RangeError);
  assert.throws(() => generator.sphere({ params: [1, 2, 3, NaN] }), RangeError);
  assert.throws(() => generator.surface({ code: 'nothing here' }), TypeError);
  assert.throws(() => generator.surface({}), TypeError);
  assert.throws(() => generator.tube({ points: 1 }), RangeError);
  assert.throws(() => generator.tube({ points: 2, closed: true }), RangeError);
  assert.throws(() => generator.tube({ points: 3, sides: 0 }), RangeError);
  assert.throws(() => generator.tube({ points: 3, up: [0, NaN, 0] }), RangeError);
  assert.throws(() => new GeometryGenerator({ order: NaN }), RangeError);
});

test('the WebGL2 backend is refused by name', () => {
  const { engine } = fakeEngine(false);
  assert.throws(() => GeometryGenerator.attach(engine), { name: 'MargoError', code: 'unsupported' });
});

test('a stopped read does not start', async () => {
  const { engine } = fakeEngine(),
    generator = GeometryGenerator.attach(engine),
    sphere = generator.sphere(),
    controller = new AbortController();
  controller.abort();
  await assert.rejects(sphere.read({ signal: controller.signal }), { name: 'AbortError' });
});
