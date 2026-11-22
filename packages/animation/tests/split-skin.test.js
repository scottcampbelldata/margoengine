// A skinned and morphed primitive over gltf/pbr's default maxPartVertices (262,144) loads as parts and deforms exactly
// as the same mesh split by hand into one primitive per part, and as the same vertices of the whole primitive: the
// parts read JOINTS_0, WEIGHTS_0 and the morph deltas through their vertexMap (packages/shared/vertex-map.js).
// Before the fix gltf/pbr refused such a primitive ('unsupported', "only static primitives split into parts").
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { parseGLTF } from '../../gltf/dist/pbr.js';
import { Animation } from '../dist/index.js';
import { bakeVAT, vatTexel } from '../dist/vat.js';
import { bakeBones } from '../dist/instanced-skin.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { splitSkinGrid, handSplit, partsOf } from '../../../tests/support/split-skin-fixture.js';

// gltf/pbr places models on a device: optionalGPU's mock one, so the test runs without a GPU.
const headless = async () =>
  new Engine({ width: 16, height: 16, clientWidth: 16, clientHeight: 16 }, await TransformStore.create(64), {
    backend: 'webgpu',
    gpu: optionalGPU().engine.gpu,
    add() {},
    remove() {},
    render() {},
    dispose() {},
  });
// Element by element, naming the first difference (assert.deepEqual's diff of a million-element array takes minutes).
function same(a, b, label) {
  assert.equal(a.length, b.length, `${label}: length`);
  for (let i = 0; i < a.length; i++)
    if (!Object.is(a[i], b[i])) assert.fail(`${label}: element ${i} is ${a[i]}, expected ${b[i]}`);
}
const load = (engine, { doc, buffers }, options = {}) => parseGLTF(engine, doc, buffers, [], {}, options);
// 520 x 520 = 270,400 vertices: over 262,144, so the default splits it.
const grid = splitSkinGrid(520, 520);

test('a skinned, morphed primitive of 270,400 vertices loads as parts and bakes the same VAT as the mesh split by hand', async () => {
  const engine = await headless();
  const auto = load(engine, grid);
  assert.ok(auto.primitives.length >= 2, `${auto.primitives.length} parts`);
  for (const p of auto.primitives) {
    assert.ok(p.vertices.length / 20 <= 262_144);
    assert.equal(p.part.count, auto.primitives.length);
  }
  const hand = load(engine, handSplit(grid, partsOf(auto)));
  assert.equal(hand.primitives.length, auto.primitives.length);
  hand.primitives.forEach((p, k) => {
    assert.equal(p.part, undefined, 'a hand-made part is a primitive of its own');
    same(p.vertices, auto.primitives[k].vertices, `part ${k} vertices`);
    same(p.indices, auto.primitives[k].indices, `part ${k} indices`);
  });
  const bake = (model) => {
    const animation = new Animation(model);
    return bakeVAT(animation, { fps: 2, clips: ['bend'] });
  };
  const a = bake(auto),
    b = bake(hand);
  assert.equal(a.vertexCount, b.vertexCount);
  assert.equal(a.rows, 3);
  // Byte for byte: every part's skinned and morphed position and normal at every sampled time.
  same(new Uint32Array(a.texels.buffer), new Uint32Array(b.texels.buffer), 'VAT texels');
  // And the bend is there: at t = 0.5 (row 1) the far corner (2, 1), wholly on joint 1 turned 45 degrees, sits at
  // (1, sqrt 2), lifted by half the morph target.
  const corner = grid.count - 1;
  let base = 0;
  for (const p of auto.primitives) {
    const j = p.part.vertexMap.indexOf(corner);
    if (j >= 0) {
      const [x, y] = vatTexel(1, base + j, 0, a.vertexCount, a.width),
        o = (y * a.width + x) * 4,
        expected = [1, Math.SQRT2, 0.05 * Math.sin(14) * Math.cos(5)];
      for (let k = 0; k < 3; k++)
        assert.ok(Math.abs(a.texels[o + k] - expected[k]) < 1e-5, `${a.texels.subarray(o, o + 3)} vs ${expected}`);
      break;
    }
    base += p.vertices.length / 20;
  }
  engine.dispose();
});

test('each part deforms its vertices exactly as the whole primitive deforms them', async () => {
  const engine = await headless();
  const auto = load(engine, grid),
    whole = load(engine, grid, { maxPartVertices: 1_048_576 });
  assert.equal(whole.primitives.length, 1);
  assert.equal(whole.primitives[0].part, undefined);
  const a = bakeVAT(new Animation(auto), { fps: 2, clips: ['bend'] }),
    b = bakeVAT(new Animation(whole), { fps: 2, clips: ['bend'] });
  let base = 0;
  for (const p of auto.primitives) {
    const map = p.part.vertexMap;
    for (let row = 0; row < a.rows; row++)
      for (let j = 0; j < map.length; j += 997)
        for (let k = 0; k < 2; k++) {
          const [x, y] = vatTexel(row, base + j, k, a.vertexCount, a.width),
            [u, v] = vatTexel(row, map[j], k, b.vertexCount, b.width),
            o = (y * a.width + x) * 4,
            q = (v * b.width + u) * 4;
          same(a.texels.subarray(o, o + 3), b.texels.subarray(q, q + 3), `row ${row} vertex ${j}`);
        }
    base += map.length;
  }
  // The bone texture bake (instanced skinning) reads the parts' weights through the vertex map too.
  // Half the morph target in the bind pose it bakes, so the gathered deltas count.
  const bones = (model) => {
    for (const p of model.primitives) p.weights[0] = 0.5;
    return bakeBones(new Animation(model), { fps: 2, clips: ['bend'] });
  };
  const parts = bones(auto),
    hand = bones(load(engine, handSplit(grid, partsOf(auto))));
  same(parts.joints, hand.joints, 'bone joints');
  same(parts.weights, hand.weights, 'bone weights');
  same(parts.vertices, hand.vertices, 'bone bind vertices');
  engine.dispose();
});

test('Animation uploads each part its own influences and morph deltas, equal to the hand-split mesh', async () => {
  const engine = await headless();
  // A smaller grid in parts of at most 4,096 vertices keeps the mock buffers small; the code path is the same.
  const small = splitSkinGrid(90, 90),
    auto = load(engine, small, { maxPartVertices: 4096 }),
    hand = load(engine, handSplit(small, partsOf(auto)));
  assert.ok(auto.primitives.length >= 2);
  const blocks = new Set(),
    uploaded = (model) => {
      const animation = new Animation(model);
      engine.use(animation);
      return animation.resources.map(({ slot }) => {
        blocks.add(slot.influences).add(slot.morphs);
        const page = slot.page,
          influences = slot.influences.range,
          morphs = slot.morphs.range;
        return {
          influences: new Uint8Array(page.influences.buffer.data, influences.offset * 16, influences.size * 16).slice(),
          morphs: new Uint8Array(page.morphs.buffer.data, morphs.offset * 48, morphs.size * 48).slice(),
        };
      });
    };
  const a = uploaded(auto),
    b = uploaded(hand);
  assert.equal(a.length, auto.primitives.length);
  a.forEach((slot, k) => {
    same(slot.influences, b[k].influences, `part ${k} influences`);
    same(slot.morphs, b[k].morphs, `part ${k} morph deltas`);
  });
  // No two parts share an influence or delta block (the hand-split primitives have their own too).
  assert.equal(blocks.size, 4 * auto.primitives.length);
  engine.dispose();
});

test('two parts of one primitive with the same vertex count keep their own influences', async () => {
  // The arena shares a block between copies of one primitive by its definition and vertex count; two parts of one
  // definition can have the same count and still hold different vertices. Before the fix they shared one block.
  const engine = await headless(),
    small = splitSkinGrid(90, 90),
    model = load(engine, small, { maxPartVertices: 4096 }),
    first = model.primitives[0],
    reversed = first.part.vertexMap.slice().reverse();
  model.primitives.push({ ...first, vertices: first.vertices.slice(), part: { ...first.part, vertexMap: reversed } });
  const animation = new Animation(model);
  engine.use(animation);
  const slots = animation.resources.map((r) => r.slot),
    a = slots[0],
    b = slots.at(-1);
  assert.notEqual(a.influences, b.influences);
  const words = (slot) =>
    new Uint32Array(
      slot.page.influences.buffer.data,
      slot.influences.range.offset * 16,
      slot.influences.range.size * 4,
    );
  const got = words(b),
    floats = new Float32Array(got.buffer, got.byteOffset, got.length),
    { JOINTS_0: joints, WEIGHTS_0: weights } = small.arrays;
  reversed.forEach((v, k) => {
    for (let c = 0; c < 4; c++) {
      assert.equal(got[k * 8 + c], joints[v * 4 + c]);
      assert.equal(floats[k * 8 + 4 + c], Math.fround(weights[v * 4 + c]));
    }
  });
  engine.dispose();
});
