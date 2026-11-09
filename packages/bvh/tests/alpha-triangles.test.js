import test from 'node:test';
import assert from 'node:assert/strict';
import { worldTriangles } from '../dist/index.js';
import { alphaWorldTriangles } from '../dist/alpha-triangles.js';
import { modelAlphaMasks } from '../dist/alpha.js';
import { bvhWGSL } from '../dist/gpu.js';

function scene() {
  const matrices = new Float32Array(48),
    identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (let i = 0; i < 3; i++) matrices.set(identity, i * 16);
  matrices[12] = 10;
  const node = { id: 0 },
    core = {
      id: 1,
      geometry: {
        vertices: Float32Array.of(0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0),
        indices: Uint32Array.of(0, 1, 2),
      },
    },
    disposed = { id: 2 },
    vertices = new Float32Array(60),
    data = new Float32Array(48);
  [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
  ].forEach((v, i) => {
    vertices.set(v, i * 20);
    vertices.set([i / 4, i / 8], i * 20 + 12);
  });
  data.set(identity);
  data.set(identity, 24);
  data[36] = -4;
  const primitive = {
      node,
      vertices,
      indices: Uint32Array.of(2, 0, 1),
      material: { base: [1, 1, 1, 0.4], settings: [1, 0.5], maps: [] },
      instances: { count: 2, data },
    },
    model = { root: node, primitives: [primitive] },
    engine = {
      disposed: false,
      meshes: new Map([
        [0, node],
        [1, core],
      ]),
      store: {
        matrices,
        tick() {
          this.calls = (this.calls ?? 0) + 1;
        },
      },
    };
  return { node, core, disposed, primitive, model, engine };
}
test('alpha world triangles retain exact ordering, UVs and provenance through node and instance transforms', {
  timeout: 30000,
}, () => {
  const { core, primitive, model, engine } = scene();
  const actual = alphaWorldTriangles(engine, [core, model, model]);
  const expected = worldTriangles(engine, [core, model]);
  assert.deepEqual(actual.vertices, expected.vertices);
  assert.deepEqual(actual.indices, expected.indices);
  assert.deepEqual([...actual.uv], [0, 0, 0, 0, 0, 0, 0.5, 0.25, 0, 0, 0.25, 0.125, 0.5, 0.25, 0, 0, 0.25, 0.125]);
  assert.deepEqual(
    actual.ranges.map((r) => [r.firstFace, r.faceCount, r.instanceIndex]),
    [
      [0, 1, undefined],
      [1, 1, 0],
      [2, 1, 1],
    ],
  );
  assert.equal(actual.ranges[1].model, model);
  assert.equal(actual.ranges[2].primitive, primitive);
  assert.equal(actual.vertices[9], 10);
  assert.equal(actual.vertices[18], 6);
});
test('alpha collection shares filtering, disposed/live rules, refresh and empty-instance behaviour', {
  timeout: 30000,
}, () => {
  const { core, primitive, model, engine } = scene(),
    seen = [];
  const actual = alphaWorldTriangles(engine, [core, model], {
    refresh: false,
    filter(mesh, owner, part) {
      seen.push([mesh, owner, part]);
      return !owner;
    },
  });
  assert.equal(engine.store.calls, undefined);
  assert.equal(seen[1][2], primitive);
  assert.equal(actual.indices.length, 3);
  assert.equal(actual.ranges.length, 1);
  primitive.instances.count = 0;
  assert.equal(alphaWorldTriangles(engine, [model]).uv.length, 0);
  primitive.instances.count = 1;
  model.disposed = true;
  assert.equal(alphaWorldTriangles(engine, [model]).ranges.length, 0);
  model.disposed = false;
  engine.meshes.delete(0);
  assert.equal(alphaWorldTriangles(engine, [model]).indices.length, 0);
  engine.disposed = true;
  assert.throws(() => alphaWorldTriangles(engine, [core]), /disposed/);
});
test('model alpha primitive lookup checks ownership and retains shared-mask identity', { timeout: 30000 }, async () => {
  const { model, primitive } = scene();
  model.asset = { doc: {} };
  model.image = () => undefined;
  model.primitives.push({ ...primitive });
  const source = await modelAlphaMasks(model);
  assert.equal(source.forPrimitive(primitive), source({ model, primitive }));
  assert.equal(source.forPrimitive(model.primitives[1]), source.forPrimitive(primitive));
  assert.equal(source.forPrimitive({ ...primitive }), null, 'material identity does not confer primitive ownership');
});
test('candidate acceptance precedes closest/any acceptance without recasting the ray', { timeout: 30000 }, () => {
  const shader = bvhWGSL({ accept: 'coverage' }),
    start = shader.indexOf('let face = bvhFaces[at]');
  assert.ok(
    shader.indexOf('if (!coverage(face, hit.xyz)) { continue; }', start) < shader.indexOf('best = BVHHit', start),
  );
  assert.ok(shader.indexOf('best = BVHHit', start) < shader.indexOf('if (any) { return best; }', start));
  assert.doesNotMatch(bvhWGSL(), /coverage\(/);
  assert.throws(() => bvhWGSL({ accept: 'f();break' }), /identifier/);
  assert.throws(() => bvhWGSL({ accept: '' }), /identifier/);
});
