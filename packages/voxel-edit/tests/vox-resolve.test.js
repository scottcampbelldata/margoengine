import assert from 'node:assert/strict';
import test from 'node:test';
import { createRandom } from '@margoengine/math/mathutils';
import { BlockTypes, VoxelWorld } from '@margoengine/voxel';
import { pasteVoxModel } from '@margoengine/voxel/vox';
import { magicaVoxelMatrix } from '@margoengine/voxel-pathtracer';
import { gridFromVox, resolveVoxScene, voxFrameRange } from '../dist/vox.js';

const clean = (values) => Array.from(values, (v) => v || 0);

// Margo Voxel Studio's frozen resolver (src/editor/vox-scene.ts resolveVoxSceneInstances, its source placement with a
// zero pivot and without the app's own banks), kept as the oracle for the 'box-v1' convention.
const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1],
  AXES = [0, 2, 1],
  SIGNS = [1, 1, -1];
const keyFrame = (key) => key.frame ?? 0;
function held(keys, frame) {
  let first = keys[0],
    selected;
  for (const key of keys) {
    const time = keyFrame(key);
    if (time < keyFrame(first)) first = key;
    if (time <= frame && (!selected || time > keyFrame(selected))) selected = key;
  }
  return selected ?? first;
}
const apply = (m, p) => [0, 1, 2].map((row) => m[row * 3] * p[0] + m[row * 3 + 1] * p[1] + m[row * 3 + 2] * p[2]);
const compose = (a, b) =>
  Array.from({ length: 9 }, (_, index) => {
    const row = index - (index % 3),
      column = index % 3;
    return a[row] * b[column] + a[row + 1] * b[column + 3] + a[row + 2] * b[column + 6];
  });
function studioPlacement(sourceSize, globalRotation, translation) {
  const pivot = [0, 0, 0],
    offset = [0, 1, 2].map((row) => {
      const axis = [0, 1, 2].find((a) => globalRotation[row * 3 + a] !== 0);
      return -Math.floor(sourceSize[axis] / 2) + (globalRotation[row * 3 + axis] < 0 ? sourceSize[axis] : 0);
    }),
    result = new Float32Array(16);
  result[15] = 1;
  for (let row = 0; row < 3; row++)
    for (let column = 0; column < 3; column++)
      result[column * 4 + row] = SIGNS[row] * globalRotation[AXES[row] * 3 + AXES[column]] * SIGNS[column];
  const correction = [pivot[0], pivot[1], pivot[2] - sourceSize[1]];
  for (let row = 0; row < 3; row++)
    result[12 + row] =
      SIGNS[row] * (translation[AXES[row]] + offset[AXES[row]]) +
      result[row] * correction[0] +
      result[4 + row] * correction[1] +
      result[8 + row] * correction[2];
  return result;
}
function studioResolve(scene, frame) {
  const nodes = new Map(scene.nodes.map((n) => [n.id, n])),
    children = (n) => (n.type === 'transform' ? [n.child] : n.type === 'group' ? n.children : []),
    parents = new Set(scene.nodes.flatMap(children)),
    layers = new Map(scene.layers.map((l) => [l.id, l])),
    out = [],
    pending = scene.nodes
      .filter((n) => !parents.has(n.id))
      .map((node) => ({ node, rotation: IDENTITY, translation: [0, 0, 0], visible: true, transforms: [], layers: [] }))
      .reverse();
  while (pending.length) {
    const state = pending.pop(),
      node = state.node,
      next = { ...state, visible: state.visible && !node.hidden, name: node.name ?? state.name };
    if (node.type === 'transform') {
      const key = held(node.frames, frame),
        translated = apply(state.rotation, key.translation ?? [0, 0, 0]);
      next.rotation = compose(state.rotation, key.rotation ?? IDENTITY);
      next.translation = translated.map((v, a) => v + state.translation[a]);
      next.transforms = [...state.transforms, node.id];
      if (node.layer >= 0 && !state.layers.includes(node.layer)) next.layers = [...state.layers, node.layer];
      next.visible &&= !layers.get(node.layer)?.hidden;
      pending.push({ ...next, node: nodes.get(node.child) });
    } else if (node.type === 'group') {
      for (let i = node.children.length - 1; i >= 0; i--) pending.push({ ...next, node: nodes.get(node.children[i]) });
    } else {
      const model = held(node.models, frame).model;
      out.push({
        shapeId: node.id,
        model,
        name: next.name,
        visible: next.visible,
        transformIds: next.transforms,
        layerIds: next.layers,
        matrix: clean(studioPlacement(scene.models[model].size, next.rotation, next.translation)),
      });
    }
  }
  return out;
}

const PERMUTATIONS = (() => {
  const out = [];
  for (const [a, b, c] of [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ])
    for (let signs = 0; signs < 8; signs++) {
      const r = new Array(9).fill(0);
      [a, b, c].forEach((column, row) => {
        r[row * 3 + column] = signs & (1 << row) ? -1 : 1;
      });
      out.push(r);
    }
  return out;
})();

function randomScene(seed) {
  const random = createRandom(seed),
    int = (n) => Math.floor(random() * n),
    models = Array.from({ length: 4 }, () => {
      const size = [1 + int(9), 1 + int(9), 1 + int(9)],
        voxels = [];
      for (let k = 0; k < 6; k++) voxels.push(int(size[0]), int(size[1]), int(size[2]), 1 + int(255));
      return { size, voxels: Uint8Array.from(voxels) };
    }),
    nodes = [],
    keys = () =>
      Array.from({ length: 1 + int(3) }, () => ({
        frame: int(4) * 3,
        translation: [int(41) - 20, int(41) - 20, int(41) - 20],
        rotation: PERMUTATIONS[int(48)],
      })),
    named = () => (random() < 0.4 ? { name: `n${int(100)}` } : {}),
    hidden = () => (random() < 0.15 ? { hidden: true } : {});
  let next = 0;
  function transform(depth) {
    const id = next++,
      node = { id, type: 'transform', layer: int(4) - 1, frames: keys(), ...named(), ...hidden() };
    nodes.push(node);
    if (depth > 2 || random() < 0.5) {
      const shape = next++;
      nodes.push({
        id: shape,
        type: 'shape',
        models: Array.from({ length: 1 + int(2) }, () => ({ model: int(4), frame: int(3) * 4 })),
        ...named(),
      });
      node.child = shape;
    } else {
      const group = next++,
        g = { id: group, type: 'group', children: [], ...hidden() };
      nodes.push(g);
      node.child = group;
      for (let k = 1 + int(3); k > 0; k--) g.children.push(transform(depth + 1));
    }
    return id;
  }
  transform(0);
  return {
    version: 200,
    palette: new Uint8Array(1024).fill(200),
    materials: [],
    models,
    nodes,
    layers: [0, 1, 2].map((id) => ({ id, hidden: random() < 0.3 })),
  };
}

const ODD = {
  version: 200,
  palette: new Uint8Array(1024),
  materials: [],
  layers: [],
  models: [{ size: [3, 5, 7], voxels: new Uint8Array() }],
  nodes: [
    { id: 0, type: 'group', children: [1] },
    { id: 1, type: 'transform', child: 2, layer: -1, frames: [{ rotation: [-1, 0, 0, 0, -1, 0, 0, 0, 1] }] },
    { id: 2, type: 'shape', models: [{ model: 0 }] },
  ],
};

test("'box-v1' keeps Studio's saved odd rotated placement (X 2); 'pivot-v1' is the tracer's (X 1)", () => {
  const [box] = resolveVoxScene(ODD, { centering: 'box-v1' }),
    [pivot] = resolveVoxScene(ODD, { centering: 'pivot-v1' }),
    rotation = ODD.nodes[1].frames[0].rotation;
  assert.equal(box.matrix[12], 2);
  assert.equal(pivot.matrix[12], 1);
  assert.deepEqual(box.matrix, studioResolve(ODD, 0)[0].matrix);
  assert.deepEqual(pivot.matrix, clean(magicaVoxelMatrix([3, 5, 7], [0, 0, 0], rotation)));
  assert.deepEqual(box.rotation, rotation);
  assert.deepEqual(box.translation, [0, 0, 0]);
  assert.throws(() => resolveVoxScene(ODD, {}), /centering/);
  assert.throws(() => resolveVoxScene(ODD, { centering: 'box' }), TypeError);
});

test("'pivot-v1' is magicaVoxelMatrix and 'box-v1' Studio's placement for all 48 rotations", () => {
  const random = createRandom(5);
  for (const rotation of PERMUTATIONS)
    for (let k = 0; k < 6; k++) {
      const size = [1 + Math.floor(random() * 12), 1 + Math.floor(random() * 12), 1 + Math.floor(random() * 12)],
        translation = [Math.floor(random() * 61) - 30, Math.floor(random() * 61) - 30, Math.floor(random() * 61) - 30],
        scene = {
          ...ODD,
          models: [{ size, voxels: new Uint8Array() }],
          nodes: [
            { id: 0, type: 'transform', child: 1, layer: -1, frames: [{ rotation, translation }] },
            { id: 1, type: 'shape', models: [{ model: 0 }] },
          ],
        },
        [box] = resolveVoxScene(scene, { centering: 'box-v1' }),
        [pivot] = resolveVoxScene(scene, { centering: 'pivot-v1' });
      assert.deepEqual(pivot.matrix, clean(magicaVoxelMatrix(size, translation, rotation)));
      assert.deepEqual(box.matrix, clean(studioPlacement(size, rotation, translation)));
      const flippedOdd = [0, 1, 2].some((row) => {
        const axis = rotation.slice(row * 3, row * 3 + 3).findIndex((v) => v !== 0);
        return rotation[row * 3 + axis] < 0 && size[axis] % 2;
      });
      assert.equal(
        flippedOdd,
        box.matrix.some((v, i) => v !== pivot.matrix[i]),
      );
    }
});

test('resolveVoxScene matches Studio frame by frame on random hierarchies', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const scene = randomScene(seed);
    for (const frame of [0, 1, 3, 4, 6, 9, 50]) {
      const ours = resolveVoxScene(scene, { frame, centering: 'box-v1' }).map(({ rotation, translation, ...rest }) => ({
          name: undefined,
          ...rest,
        })),
        theirs = studioResolve(scene, frame);
      assert.deepEqual(ours, theirs, `seed ${seed} frame ${frame}`);
    }
  }
});

test("'box-v1' places cells where @margoengine/voxel's pasteVoxModel does", () => {
  for (let seed = 100; seed < 120; seed++) {
    const scene = randomScene(seed);
    // pasteVoxModel reads each node's first-listed key: keep one key per track so both read the same pose.
    for (const node of scene.nodes) {
      delete node.hidden;
      if (node.frames) node.frames = node.frames.slice(0, 1);
      if (node.models) node.models = node.models.slice(0, 1);
    }
    scene.layers = [];
    const blocks = new BlockTypes(),
      world = new VoxelWorld({ blocks }),
      mapping = Array.from({ length: 256 }, (_, i) => (i ? blocks.define(`c${i}`) : 0)),
      pasted = new Set(),
      placed = new Map(),
      low = [Infinity, Infinity, Infinity];
    world.onChange((x, y, z) => pasted.add(`${x},${y},${z}`));
    pasteVoxModel(world, scene, [0, 0, 0], mapping);
    const instances = resolveVoxScene(scene, { centering: 'box-v1' }),
      at = (m, p, r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r];
    for (const instance of instances) {
      const grid = gridFromVox(scene.models[instance.model]);
      for (let corner = 0; corner < 8; corner++) {
        const p = [0, 1, 2].map((a) => (corner & (1 << a) ? grid.size[a] : 0));
        for (let r = 0; r < 3; r++) low[r] = Math.min(low[r], at(instance.matrix, p, r));
      }
    }
    // pasteVoxModel puts the boxes' lower corner at `at`; shift the resolved placement the same way.
    for (const instance of instances) {
      const grid = gridFromVox(scene.models[instance.model]),
        [sx, sy, sz] = grid.size;
      for (let y = 0; y < sy; y++)
        for (let z = 0; z < sz; z++)
          for (let x = 0; x < sx; x++) {
            const v = grid.voxels[x + sx * (z + sz * y)];
            if (!v) continue;
            const c = [x + 0.5, y + 0.5, z + 0.5],
              key = [0, 1, 2].map((r) => Math.floor(at(instance.matrix, c, r) - low[r])).join(',');
            placed.set(key, [...(placed.get(key) ?? []), v]);
          }
    }
    assert.deepEqual(new Set(placed.keys()), pasted, `seed ${seed}`);
    for (const [key, values] of placed)
      if (values.length === 1) assert.equal(world.getBlock(...key.split(',').map(Number)), mapping[values[0]]);
  }
});

test('keys in force, names, visibility and layers follow the frame', () => {
  const scene = {
    ...ODD,
    models: [
      { size: [2, 2, 2], voxels: new Uint8Array() },
      { size: [4, 4, 4], voxels: new Uint8Array() },
    ],
    layers: [{ id: 3, hidden: true }, { id: 4 }],
    nodes: [
      { id: 0, type: 'transform', child: 1, layer: 4, name: 'root', frames: [{ frame: 5, translation: [1, 0, 0] }] },
      { id: 1, type: 'group', children: [2, 4] },
      {
        id: 2,
        type: 'transform',
        child: 3,
        layer: -1,
        frames: [
          { frame: 8, translation: [0, 0, 9] },
          { frame: 2, translation: [0, 0, 2] },
          { frame: 2, translation: [0, 0, 7] },
        ],
      },
      {
        id: 3,
        type: 'shape',
        name: 'leaf',
        models: [
          { model: 1, frame: 4 },
          { model: 0, frame: 1 },
        ],
      },
      { id: 4, type: 'transform', child: 5, layer: 3, frames: [{}] },
      { id: 5, type: 'shape', models: [{ model: 0 }] },
    ],
  };
  const at = (frame) => resolveVoxScene(scene, { frame, centering: 'box-v1' });
  const [a, b] = at(0);
  assert.deepEqual(
    [a.shapeId, a.model, a.name, a.visible, a.transformIds, a.layerIds],
    [3, 0, 'leaf', true, [0, 2], [4]],
  );
  assert.deepEqual(a.translation, [1, 0, 2], 'before the first key: the earliest; equal frames: the first listed');
  assert.deepEqual([b.shapeId, b.name, b.visible, b.layerIds], [5, 'root', false, [4, 3]]);
  assert.deepEqual(at(4)[0].model, 1);
  assert.deepEqual(at(8)[0].translation, [1, 0, 9]);
  assert.deepEqual(voxFrameRange(scene), { startFrame: 0, endFrame: 8 });
  assert.equal(voxFrameRange({ nodes: [] }), undefined);
  assert.deepEqual(resolveVoxScene({ ...scene, nodes: [] }, { centering: 'pivot-v1' }), []);
});

test('resolveVoxScene refuses broken graphs, keys, frames and model sizes', () => {
  const base = () => structuredClone(ODD),
    run =
      (scene, options = { centering: 'box-v1' }) =>
      () =>
        resolveVoxScene(scene, options);
  assert.throws(run(null), TypeError);
  assert.throws(run(base(), { centering: 'box-v1', frame: -1 }), /frame/);
  assert.throws(run(base(), { centering: 'box-v1', frame: 1.5 }), /frame/);
  let s = base();
  s.nodes.push({ id: 2, type: 'group', children: [] });
  assert.throws(run(s), /repeats/);
  s = base();
  s.nodes[0].children.push(9);
  assert.throws(run(s), /missing node/);
  s = base();
  s.nodes.push({ id: 3, type: 'group', children: [1] });
  assert.throws(run(s), /two parents/);
  s = base();
  s.nodes[1].frames = [];
  assert.throws(run(s), /no keys/);
  s = base();
  s.nodes[1].frames[0].rotation = [1, 1, 0, 0, 1, 0, 0, 0, 1];
  assert.throws(run(s), /permutation/);
  s = base();
  s.nodes[1].frames[0].translation = [0.5, 0, 0];
  assert.throws(run(s), /whole numbers/);
  s = base();
  s.nodes[1].frames[0].frame = -2;
  assert.throws(run(s), /key frame/);
  s = base();
  s.nodes[2].models = [{ model: 3 }];
  assert.throws(run(s), /missing model/);
  s = base();
  s.nodes.push(
    { id: 5, type: 'group', children: [6] },
    { id: 6, type: 'transform', child: 5, layer: -1, frames: [{}] },
  );
  assert.throws(run(s), /cycle/);
  s = base();
  s.models[0].size = [3, 5, 257];
  assert.throws(run(s), /1 to 256/);
});
