import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Engine, TransformStore, box } from '../../core/dist/extension.js';
import { AlphaRaycaster, modelAlphaMasks, sampleAlpha } from '../dist/alpha.js';
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
  assert.throws(() => sampleAlpha(halves({ wrap: 'wiggle' }), 0, 0), TypeError);
  assert.throws(() => sampleAlpha(halves({ wrap: ['repeat', 'wiggle'] }), 0, 0), TypeError);
  assert.throws(() => sampleAlpha(halves({ transform: [1, 0] }), 0, 0), TypeError);
});

test('each axis wraps by itself, and mirror flips every second tile', () => {
  // Top row solid, bottom row clear: the rows show what v reads.
  const rows = (extra) => ({ width: 2, height: 2, data: new Uint8Array(16).map((_, i) => (i < 8 && i % 4 === 3 ? 255 : 0)), ...extra });
  assert.equal(sampleAlpha(halves({ wrap: 'mirror' }), 1.25, 0.25), 0, 'the next tile runs backwards');
  assert.equal(sampleAlpha(halves({ wrap: 'mirror' }), 1.75, 0.25), 1);
  assert.equal(sampleAlpha(halves({ wrap: 'mirror' }), -0.25, 0.25), 1, 'and so does the one before');
  assert.equal(sampleAlpha(halves({ wrap: ['clamp', 'repeat'] }), 3, 0.25), 0, 'u holds the edge');
  assert.equal(sampleAlpha(rows({ wrap: ['clamp', 'repeat'] }), 3, 1.25), 1, 'v wraps at the same time');
  assert.equal(sampleAlpha(rows({ wrap: ['repeat', 'clamp'] }), 0.25, 1.25), 0);
});

test('a transform maps the uv before sampling, and the factor scales the alpha', () => {
  assert.equal(sampleAlpha(halves({ transform: [1, 0, 0.5, 0, 1, 0] }), 0.25, 0.25), 0, 'offset by half');
  assert.equal(sampleAlpha(halves({ transform: [0.25, 0, 0, 0, 1, 0] }), 1, 0.25), 1, 'a quarter scale stays left');
  assert.equal(sampleAlpha(halves({ transform: [0, 1, 0, 1, 0, 0] }), 0.75, 0.25), 1, 'u and v swapped read the left column');
  assert.equal(sampleAlpha(halves({ factor: 0.25 }), 0.25, 0.25), 0.25);
});

// What gltf-pro gives: settings[0] is the alpha mode index, settings[1] the cutoff, base[3] the factor.
const material = (extra = {}) => ({ base: [1, 1, 1, 1], settings: [1, 0.5, 0], maps: [{ index: 0 }], ...extra });
const loaded = (materials, doc = {}, images = [halves()]) => ({
  primitives: materials.map((m) => ({ material: m })),
  asset: { doc: { textures: [{ source: 0 }], ...doc } },
  image: (index) => images[index],
});
const raw = (image) => image;

test('modelAlphaMasks reads a MASK material: pixels, cutoff, factor, wrap per axis and transform', async () => {
  const mask = material({
      base: [1, 1, 1, 0.5],
      settings: [1, 0.25, 0],
      maps: [{ index: 0, extensions: { KHR_texture_transform: { offset: [0.5, 0.25], rotation: Math.PI / 2, scale: [2, 3] } } }],
    }),
    model = loaded([mask], { textures: [{ source: 0, sampler: 0 }], samplers: [{ wrapS: 33071, wrapT: 33648 }] }),
    source = await modelAlphaMasks(model, { pixels: raw }),
    read = source({ primitive: model.primitives[0] });
  assert.equal(read.cutoff, 0.25);
  assert.equal(read.factor, 0.5);
  assert.deepEqual(read.wrap, ['clamp', 'mirror']);
  // rotation of the spec: u' = cos sx u + sin sy v + ox, v' = -sin sx u + cos sy v + oy
  [0, 3, 0.5, -2, 0, 0.25].forEach((value, i) => assert.ok(Math.abs(read.transform[i] - value) < 1e-12, `row ${i}`));
  assert.equal(read.width, 2);
  assert.deepEqual(source.skipped, []);
});

test('a hit with only a primitive index finds its mask; other hits and materials stay solid', async () => {
  const mask = material(),
    other = { base: [1, 1, 1, 1], settings: [0, 0.5, 0], maps: [] },
    blend = { ...other, settings: [2, 0.5, 0] },
    model = loaded([other, mask, blend, mask]),
    source = await modelAlphaMasks(model, { pixels: raw });
  assert.ok(source({ primitiveIndex: 1 }));
  assert.equal(source({ primitiveIndex: 0 }), null, 'opaque');
  assert.equal(source({ primitiveIndex: 2 }), null, 'blend');
  assert.equal(source({ primitiveIndex: 9 }), null);
  assert.equal(source({ model: {}, primitive: model.primitives[1] }), null, 'a hit of another model');
  assert.equal(source({ primitiveIndex: 1 }), source({ primitiveIndex: 3 }), 'one read for a shared material');
});

test('a MASK material with no map is its factor, everywhere', async () => {
  const cut = material({ base: [1, 1, 1, 0.2], maps: [] }),
    kept = material({ base: [1, 1, 1, 0.8], maps: [] }),
    model = loaded([cut, kept]),
    source = await modelAlphaMasks(model, { pixels: raw }),
    alpha = (index) => sampleAlpha(source({ primitiveIndex: index }), 0.3, 0.7);
  assert.ok(alpha(0) < 0.5);
  assert.ok(alpha(1) >= 0.5);
});

test('a mask on a later UV set is listed under the set it reads', async () => {
  const later = material({ maps: [{ index: 0, texCoord: 3 }] }),
    source = await modelAlphaMasks(loaded([later], { textures: [{ source: 0 }] }, [halves()]), { pixels: raw });
  assert.match(source.skipped[0].reason, /TEXCOORD_3/);
});

test('what cannot be read picks solid and is listed with why', async () => {
  const second = material({ maps: [{ index: 0, texCoord: 1 }] }),
    moved = material({ maps: [{ index: 0, extensions: { KHR_texture_transform: { texCoord: 1 } } }] }),
    packed = material({ maps: [{ index: 1 }] }),
    source = await modelAlphaMasks(
      loaded([second, moved, packed], { textures: [{ source: 0 }, { source: 1 }] }, [halves(), { ktx2: {} }]),
      { pixels: raw },
    );
  assert.deepEqual(source.skipped.map(({ material }) => material), [second, moved, packed]);
  assert.match(source.skipped[0].reason, /TEXCOORD_1/);
  assert.match(source.skipped[2].reason, /compressed/);
  assert.equal(source({ primitiveIndex: 0 }), null);
});

test('a decoded webp or basisu source wins over the fallback, as gltf-pro takes it', async () => {
  const model = loaded([material()], { textures: [{ source: 0, extensions: { EXT_texture_webp: { source: 1 } } }] }, [
      null,
      halves(),
    ]),
    source = await modelAlphaMasks(model, { pixels: raw });
  assert.equal(source({ primitiveIndex: 0 }).width, 2);
});

test('modelAlphaMasks stops on an aborted signal, and says what it needs where no canvas exists', async () => {
  await assert.rejects(modelAlphaMasks(loaded([material()]), { signal: AbortSignal.abort(), pixels: raw }), {
    name: 'AbortError',
  });
  await assert.rejects(modelAlphaMasks(loaded([material()])), /pixels option/);
});

test('modelAlphaMasks drives a raycast through a real hole', async () => {
  const engine = await world(),
    front = card(engine, 1),
    back = card(engine, 0);
  front.primitive.material = material();
  const ray = new AlphaRaycaster();
  ray.alphaMask = await modelAlphaMasks(loaded([front.primitive.material]), { pixels: raw });
  const source = ray.alphaMask;
  ray.alphaMask = (hit) => (hit.primitive === front.primitive ? source({ primitiveIndex: 0 }) : null);
  ray.set([0.5, 0, 5], [0, 0, -1]);
  assert.deepEqual(faces(ray.intersectEngine(engine)), [back.primitive]);
  ray.set([-0.5, 0, 5], [0, 0, -1]);
  assert.equal(faces(ray.intersectEngine(engine))[0], front.primitive);
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
