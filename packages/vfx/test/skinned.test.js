import test from 'node:test';
import assert from 'node:assert/strict';
import { VFX } from '../dist/index.js';
import { VFX as Base } from '../dist/base.js';
import { skinned, skinnedTriangles } from '../dist/skinned.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

const attach = (options, features) => {
  const h = optionalGPU();
  h.engine.stats = { drawCalls: 0 };
  const effect = features ? new Base(options, features) : new VFX(options);
  h.engine.use(effect);
  return { h, effect };
};
const code = (h) => h.pipelines.map((p) => (p.compute ?? p.vertex).module.code).join('\n');
// Two triangles, bind-pose areas 1 and 3; 20 floats a vertex, position first.
const primitive = (more = {}) => {
  const rest = [
    [0, 0, 0],
    [2, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
    [3, 0, 1],
    [0, 2, 1],
  ];
  const vertices = new Float32Array(rest.length * 20);
  rest.forEach((v, i) => vertices.set(v, i * 20));
  return { vertices, indices: new Uint32Array([0, 1, 2, 3, 4, 5]), ...more };
};

test('triangles carry their indices and running bind-pose area share; zero-area ones are left out', () => {
  const p = primitive();
  const words = skinnedTriangles(p.vertices, new Uint32Array([0, 1, 2, 0, 0, 1, 3, 4, 5]));
  assert.equal(words.length, 8);
  assert.deepEqual([...words.subarray(0, 3)], [0, 1, 2]);
  assert.deepEqual([...words.subarray(4, 7)], [3, 4, 5]);
  const share = new Float32Array(words.buffer);
  assert.equal(share[3], 0.25);
  assert.equal(share[7], 1);
  assert.throws(() => skinnedTriangles(p.vertices, [0, 0, 1]), RangeError);
});

test('each frame copies the posed vertices from the deformer at its offset after the triangles, with transform and speed', () => {
  const deformed = { data: new ArrayBuffer(64 + 6 * 80) };
  new Float32Array(deformed.data).fill(9);
  const p = primitive({ deformed, deformedOffset: 64 });
  const transform = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 7, 1];
  const { h, effect } = attach({ capacity: 8, rate: 10, skinned: { primitive: p, transform, speed: 2 } }, { skinned });
  const storage = h.resources.find((r) => r.size === 32 + 6 * 80 && new Uint32Array(r.data, 0, 3).join() === '0,1,2');
  assert.ok(storage, 'triangles and vertices in one storage buffer');
  // Before a frame: the bind pose.
  assert.deepEqual([...new Float32Array(storage.data, 32, 3)], [0, 0, 0]);
  h.frame();
  assert.deepEqual([...new Float32Array(storage.data, 32, 3)], [9, 9, 9], 'the posed vertices');
  assert.deepEqual([...new Uint32Array(storage.data, 0, 3)], [0, 1, 2]);
  const uniform = h.resources.find((r) => r.size === 96);
  const f = new Float32Array(uniform.data),
    u = new Uint32Array(uniform.data);
  assert.deepEqual([...f.subarray(12, 17)], [5, 6, 7, 1, 2]);
  assert.deepEqual([...u.subarray(20, 22)], [2, 8]);
  effect.options.skinned.speed = -1;
  new Float32Array(deformed.data).fill(3);
  h.frame();
  assert.equal(f[16], -1);
  assert.deepEqual([...new Float32Array(storage.data, 32, 3)], [3, 3, 3]);
  assert.ok(code(h).includes('var<storage,read> skin:array<u32>') && code(h).includes('shapeDir*sk.a.x'));
  // The transform alone places births: the emitter position (default [0, 1, 0]) is not added.
  assert.ok(code(h).includes('var origin=(vec3f(random(seed+5u)') && !code(h).includes('var origin=f.emitterTime'));
  effect.options.skinned = { primitive: primitive() };
  assert.throws(() => h.frame(), /fixed at attach/);
  effect.dispose();
  assert.ok(h.resources.every((r) => r.destroyed));
});

test('skinned is validated; effects without it compile no skinned code', () => {
  assert.throws(
    () => new Base({ skinned: { primitive: primitive() } }, {}),
    /needs skinned from @margoengine\/vfx\/skinned/,
  );
  assert.throws(() => new VFX({ skinned: {} }), TypeError);
  assert.throws(
    () => new VFX({ skinned: { primitive: primitive() }, emitter: { shape: 'sphere' } }),
    /use one of them/,
  );
  assert.throws(() => new VFX({ skinned: { primitive: primitive({ vertices: new Float32Array(50) }) } }), TypeError);
  assert.throws(() => new VFX({ skinned: { primitive: primitive({ indices: new Uint32Array([0, 1]) }) } }), TypeError);
  assert.throws(
    () => new VFX({ skinned: { primitive: primitive({ indices: new Uint32Array([0, 1, 6]) }) } }),
    RangeError,
  );
  assert.throws(() => new VFX({ skinned: { primitive: primitive(), transform: [1, 0, 0] } }), TypeError);
  assert.throws(() => new VFX({ skinned: { primitive: primitive(), speed: 1001 } }), RangeError);
  const { h, effect } = attach({ capacity: 8, initialCount: 8 });
  h.frame();
  assert.ok(!code(h).includes('skinVertex'));
  effect.dispose();
});
