import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Engine, TransformStore, box } from '../../core/dist/extension.js';
import { AlphaRaycaster, sampleAlpha } from '../dist/alpha.js';
import { SceneBVH } from '../dist/scene.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { setMeshSource } from '../../shared/mesh-source.js';

async function world() {
  const h = optionalGPU();
  return new Engine(
    { width: 128, height: 96, clientWidth: 128, clientHeight: 96 },
    await TransformStore.create(64),
    { backend: 'webgpu', gpu: h.engine.gpu, add() {}, remove() {}, render() {}, dispose() {} },
    { position: [0, 0, 4], target: [0, 0, 0] },
    null,
  );
}

// A quad from -1 to 1 at depth z whose uv runs 0 to 1, as a one-primitive model.
function card(engine, z) {
  const node = engine.createMesh().setPosition([0, 0, z]),
    vertices = new Float32Array(80);
  [
    [-1, -1, 0, 1],
    [1, -1, 1, 1],
    [1, 1, 1, 0],
    [-1, 1, 0, 0],
  ].forEach(([x, y, u, v], i) => {
    vertices.set([x, y, 0, 0, 0, 0, 1], i * 20);
    vertices.set([u, v], i * 20 + 12);
  });
  const primitive = { node, vertices, indices: new Uint32Array([0, 1, 2, 0, 2, 3]), material: { settings: [0, 0, 1] } },
    model = { root: node, primitives: [primitive] };
  setMeshSource(node, { model, primitives: [primitive] });
  return { node, primitive, model };
}

// Two by two pixels: left column solid, right column clear.
function halves(extra = {}) {
  const data = new Uint8Array(16);
  data[3] = data[11] = 255;
  return { width: 2, height: 2, data, ...extra };
}

const faces = (hits) => hits.map((hit) => hit.primitive);

test('sampling filters between pixels, wraps and clamps', () => {
  const mask = halves();
  assert.equal(sampleAlpha(mask, 0.25, 0.25), 1);
  assert.equal(sampleAlpha(mask, 0.75, 0.25), 0);
  assert.equal(sampleAlpha(mask, 0.5, 0.5), 0.5);
  assert.equal(sampleAlpha(mask, 1.25, 0.25), 1, 'repeat');
  assert.equal(sampleAlpha(mask, -0.75, 0.25), 1, 'repeat below 0');
  assert.equal(sampleAlpha(mask, 0, 0.25), 0.5, 'repeat filters across the seam');
  assert.equal(sampleAlpha(halves({ wrap: 'clamp' }), 0, 0.25), 1);
  assert.equal(sampleAlpha(halves({ wrap: 'clamp' }), 3, 0.25), 0);
  assert.throws(() => sampleAlpha({ width: 2, height: 2, data: [] }, 0, 0), TypeError);
  assert.throws(() => sampleAlpha(halves({ wrap: 'mirror' }), 0, 0), TypeError);
});

test('a ray through a hole lands on what is behind, and firstHitOnly finds that too', async () => {
  const engine = await world(),
    front = card(engine, 1),
    back = card(engine, 0),
    ray = new AlphaRaycaster();
  ray.alphaMask = (hit) => (hit.primitive === front.primitive ? halves() : null);
  ray.set([0.5, 0, 5], [0, 0, -1]);
  assert.deepEqual(faces(ray.intersectEngine(engine)), [back.primitive]);
  ray.set([-0.5, 0, 5], [0, 0, -1]);
  assert.deepEqual(faces(ray.intersectEngine(engine)), [front.primitive, back.primitive]);
  ray.firstHitOnly = true;
  assert.deepEqual(faces(ray.intersectEngine(engine)), [front.primitive]);
  ray.set([0.5, 0, 5], [0, 0, -1]);
  assert.deepEqual(faces(ray.intersectEngine(engine)), [back.primitive]);
  assert.equal(ray.firstHitOnly, true, 'the setting survives the query');
  assert.deepEqual(faces(ray.intersectObjects(engine, [back.model, front.model])), [back.primitive]);
});

test('the cutoff decides, equal to it counts as solid', async () => {
  const engine = await world(),
    ray = new AlphaRaycaster([0, 0.3, 5], [0, 0, -1]);
  card(engine, 0);
  ray.alphaMask = () => halves({ cutoff: 0.5 });
  assert.equal(ray.intersectEngine(engine).length, 1, 'alpha 0.5 at the centre');
  ray.alphaMask = () => halves({ cutoff: 0.51 });
  assert.equal(ray.intersectEngine(engine).length, 0);
  ray.alphaMask = () => halves({ cutoff: 2 });
  assert.throws(() => ray.intersectEngine(engine), RangeError);
});

test('with no mask, and on core geometry with no uv, hits stay', async () => {
  const engine = await world(),
    mesh = engine.createMesh().setGeometry(box(1, 1, 1)),
    ray = new AlphaRaycaster([0.1, 0.2, 5], [0, 0, -1]);
  ray.side = 'double';
  assert.equal(ray.intersectEngine(engine).length, 2);
  ray.firstHitOnly = true;
  assert.equal(ray.intersectEngine(engine).length, 1);
  let asked = 0;
  ray.alphaMask = () => (asked++, halves({ cutoff: 1 }));
  assert.equal(ray.intersectEngine(engine)[0].mesh, mesh);
  assert.equal(asked, 0);
});

test('a scene BVH honours the mask', async () => {
  const engine = await world(),
    front = card(engine, 1),
    back = card(engine, 0),
    ray = new AlphaRaycaster([0.5, 0, 5], [0, 0, -1]);
  using scene = new SceneBVH(engine);
  ray.alphaMask = (hit) => (hit.primitive === front.primitive ? halves() : null);
  ray.firstHitOnly = true;
  assert.deepEqual(faces(scene.intersect(ray)), [back.primitive]);
});

test('intersectModel drops holes from the pose it reads, and firstHitOnly is back before it answers', async () => {
  const engine = await world(),
    { node, primitive } = card(engine, 0),
    matrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    source = {
      root: node,
      disposed: false,
      readPickingGeometry: async () => [
        { node, vertices: primitive.vertices, indices: primitive.indices, doubleSided: true, matrix },
      ],
    },
    ray = new AlphaRaycaster([0.5, 0, 5], [0, 0, -1]);
  ray.alphaMask = () => halves();
  ray.firstHitOnly = true;
  const pending = ray.intersectModel(source);
  assert.equal(ray.firstHitOnly, true);
  assert.deepEqual(await pending, []);
  ray.set([-0.5, 0, 5], [0, 0, -1]);
  assert.equal((await ray.intersectModel(source)).length, 1);
});
