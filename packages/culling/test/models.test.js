import test from 'node:test';
import assert from 'node:assert/strict';
import { CulledModels } from '../dist/models.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

const vertices = (...points) => {
  const out = new Float32Array(points.length * 20);
  points.forEach((p, i) => out.set(p, i * 20));
  return out;
};
const primitive = (extra = {}) => {
  const rows = { size: 96 * 300 };
  return {
    node: { matrix: new Float32Array([2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 5, 6, 7, 1]) },
    vertices: vertices([-1, 0, 0], [3, 0, 0]),
    indices: new Uint32Array(6),
    instances: { count: 300, capacity: 512, upload: () => rows },
    ...extra,
  };
};
function harness() {
  const h = optionalGPU();
  h.context.camera.matrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -0.001, -1, 0, 0, 1, 0]);
  h.engine.canvas = { clientWidth: 64 };
  h.engine.gpu.createBindGroupLayout = (d) => d;
  h.engine.gpu.createPipelineLayout = (d) => d;
  return { ...h, run: () => h.engine.frameGraph.execute(h.context) };
}
const uniforms = (h) => h.resources.filter((r) => r.size === 96 && !r.destroyed);

test('an instanced primitive gets a cull, a uniform with its node and sphere, and a redirect', () => {
  const h = harness(),
    p = primitive(),
    plain = primitive({ instances: undefined }),
    plugin = CulledModels.attach(h.engine, [{ primitives: [p, plain] }]);
  h.run();
  assert.ok(p.redirect, 'kept rows drawn from the package buffer');
  assert.equal(plain.redirect, undefined, 'a primitive without instances is left alone');
  assert.equal(p.redirect.instances.size, 512 * 96, 'sized to the capacity');
  assert.equal(p.redirect.args.usage, 128 | 256 | 4 | 8);
  const [uniform] = uniforms(h),
    words = new Uint32Array(uniform.data),
    floats = new Float32Array(uniform.data);
  assert.deepEqual([words[0], words[1]], [300, 6]);
  assert.deepEqual([...floats.subarray(4, 8)], [1, 0, 0, 2], 'the sphere of the vertices');
  assert.deepEqual([...floats.subarray(8, 24)], [...p.node.matrix]);
  assert.match(h.pipelines.find((x) => x.compute).compute.module.code, /keep\(bound\(b\.node\*records\[i\]\.m\)\)/);
  const created = { ...h.counts };
  for (let i = 0; i < 20; i++) h.run();
  assert.equal(h.counts.buffers, created.buffers, 'no per-frame buffers');
  assert.equal(h.counts.groups, created.groups);
  plugin.dispose();
  assert.equal(p.redirect, undefined, 'dispose restores the draws');
  assert.ok(h.resources.every((r) => r.destroyed));
});

test('padding grows the sphere, new vertices refresh it, and a new row buffer rebinds', () => {
  const h = harness(),
    p = primitive(),
    model = { primitives: [p] },
    plugin = CulledModels.attach(h.engine),
    sphere = () => [...new Float32Array(uniforms(h)[0].data).subarray(4, 8)];
  plugin.add(model, { padding: 1.5 });
  h.run();
  assert.deepEqual(sphere(), [1, 0, 0, 3.5]);
  p.vertices = vertices([0, 0, 0], [0, 4, 0]);
  h.run();
  assert.deepEqual(sphere(), [0, 2, 0, 3.5]);
  const groups = h.counts.groups;
  p.instances.upload = () => ({ size: 96 * 512 });
  h.run();
  assert.equal(h.counts.groups, groups + 1);
});

test('skinned, emptied, removed and disposed models draw every row again', () => {
  const h = harness(),
    p = primitive(),
    q = primitive(),
    r = primitive(),
    gone = { primitives: [r], disposed: false },
    model = { primitives: [p, q] },
    plugin = CulledModels.attach(h.engine, [model, gone]);
  h.run();
  assert.ok(p.redirect && q.redirect && r.redirect);
  p.deformed = {};
  q.instances.count = 0;
  gone.disposed = true;
  h.run();
  assert.equal(p.redirect, undefined);
  assert.equal(q.redirect, undefined);
  assert.equal(r.redirect, undefined);
  p.deformed = undefined;
  h.run();
  assert.ok(p.redirect);
  plugin.remove(model);
  assert.equal(p.redirect, undefined);
});

test('a larger capacity replaces the storage', () => {
  const h = harness(),
    p = primitive();
  CulledModels.attach(h.engine, [{ primitives: [p] }]);
  h.run();
  const old = p.redirect.instances;
  p.instances.capacity = 1024;
  h.run();
  assert.ok(old.destroyed);
  assert.equal(p.redirect.instances.size, 1024 * 96);
});

test('on the WebGL2 layer nothing is culled', () => {
  const h = harness();
  h.engine.gpu.adapterInfo = { vendor: 'margo-webgl2' };
  const p = primitive();
  CulledModels.attach(h.engine, [{ primitives: [p] }]);
  h.run();
  assert.equal(p.redirect, undefined);
});

test('bad input is refused', () => {
  assert.throws(() => new CulledModels({ minRadius: -1 }), /minRadius/);
  const plugin = new CulledModels();
  assert.throws(() => plugin.add({}), /primitives/);
  assert.throws(() => plugin.add({ primitives: [] }, { padding: -1 }), /padding/);
});
